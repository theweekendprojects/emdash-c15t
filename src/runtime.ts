/**
 * Runtime behaviour: the `page:fragments` hook that injects the banner, the
 * public `save`/`services`/`assets` routes, the admin-only CSV export, and the
 * retention purge.
 *
 * Security posture (public routes):
 *   - site id is derived SERVER-SIDE from the configured site URL, never the payload
 *   - the save body is strictly validated (strict schema; a client `siteId` is rejected)
 *   - `save` refuses cross-origin requests (Origin / Sec-Fetch-Site check)
 *   - abuse control is a Cloudflare rate-limiting rule on the route path (see the
 *     README). The plugin context has no Worker bindings, so there is no in-code limiter
 *   - the visitor IP is never read or stored by this plugin
 */
import { PluginRouteError, pluginResponse } from "emdash";
import type { PageFragmentContribution } from "emdash";
import { z } from "zod";
import { adminRoute } from "./admin-page.js";
import { consentCsvLine, csvHeaderLine, type ConsentRecord } from "./export.js";
import { isSameOriginRequest, safeInlineJson } from "./security.js";
import { purgeDue, purgeExpired } from "./purge.js";
import { isPolicyPage } from "./presentation.js";
import { languageCandidate } from "./locale.js";
import { buildPolicyRule } from "./rule.js";
import { buildClearOnRevocation, parseAllowedHosts, parseServices } from "./services.js";
import { BANNER_HASH, BANNER_JS } from "./assets.generated.js";
import { BANNER_VERSION, PLUGIN_ID, SETTINGS_DEFAULTS } from "./shared.js";

/** Route that serves the bundle. The hash is in the name, so it is immutable. */
const BUNDLE_ROUTE = `assets/banner-${BANNER_HASH}`;
const BUNDLE_URL = `/_emdash/api/plugins/${PLUGIN_ID}/${BUNDLE_ROUTE}`;
const EXPORT_ROUTE = "consent-export";

/**
 * Tiny inline loader. The ~370 KB bundle is NOT inlined per page. It is cached
 * in `localStorage` under a hash-keyed name, so after a visitor has it once we
 * `import()` straight from localStorage with no network at all (not even the
 * Worker fetch the `/_emdash/api/` edge-bypass would otherwise force on the
 * first page of each session). On a miss we fetch once (EmDash JSON-wraps the
 * route, so unwrap `.data`), import, then store for next time. The hash in the
 * key auto-busts on a new bundle; a quota/parse failure just falls back to
 * fetch, so cache trouble can never break the banner.
 */
function makeLoader(url: string, hash: string): string {
	const KEY = `emdash-privacy-js:${hash}`;
	// This source string runs in the browser; keep it dependency-free and small.
	const fn = `(function(){
	var K=${JSON.stringify(KEY)},U=${JSON.stringify(url)};
	function run(src){return import(URL.createObjectURL(new Blob([src],{type:"text/javascript"})))}
	var hit;try{hit=localStorage.getItem(K)}catch(e){}
	if(hit)return run(hit).catch(function(e){console.warn("[emdash-privacy] banner failed",e)});
	return fetch(U,{credentials:"omit"}).then(function(r){return r.json()}).then(function(j){
		try{localStorage.setItem(K,j.data)}catch(e){}
		return run(j.data);
	}).catch(function(e){console.warn("[emdash-privacy] banner failed to load",e)});
})();`;
	return fn.replace(/\n\t*/g, "");
}
const LOADER = makeLoader(BUNDLE_URL, BANNER_HASH);

// ── settings ────────────────────────────────────────────────────────────────

async function readSetting<T>(ctx: any, key: string): Promise<T | undefined> {
	// Prefer the newer SettingsAccess; fall back to the KV convention.
	if (ctx.settings?.get) return (await ctx.settings.get(key)) ?? undefined;
	return (await ctx.kv.get(`settings:${key}`)) ?? undefined;
}

async function loadSettings(ctx: any) {
	const d = SETTINGS_DEFAULTS;
	const hostsResult = parseAllowedHosts(await readSetting<string>(ctx, "allowedScriptHosts"));
	const rawServices = (await readSetting<string>(ctx, "services")) ?? d.services;
	const parsed = parseServices(rawServices, hostsResult.hosts);
	if (parsed.errors.length) {
		// Bad entries are dropped so the banner still works for the valid ones. The admin form blocks saving them.
		ctx.log?.warn?.(`[emdash-privacy] ${parsed.errors.length} invalid service entr(y/ies) ignored: ${parsed.errors[0]}`);
	}
	return {
		enabled: (await readSetting<boolean>(ctx, "enabled")) ?? d.enabled,
		services: parsed.services,
		colorScheme: (await readSetting<"system" | "light" | "dark">(ctx, "colorScheme")) ?? d.colorScheme,
		language: (await readSetting<string>(ctx, "language")) ?? d.language,
		bannerPosition: (await readSetting<string>(ctx, "bannerPosition")) ?? d.bannerPosition,
		requireChoice: (await readSetting<boolean>(ctx, "requireChoice")) ?? d.requireChoice,
		accentColor: await readSetting<string>(ctx, "accentColor"),
		privacyUrl: await readSetting<string>(ctx, "privacyUrl"),
		imprintUrl: await readSetting<string>(ctx, "imprintUrl"),
		cookieUrl: await readSetting<string>(ctx, "cookieUrl"),
		policyVersion: (await readSetting<string>(ctx, "policyVersion")) ?? d.policyVersion,
		cookieMaxAgeMonths: (await readSetting<number>(ctx, "cookieMaxAgeMonths")) ?? d.cookieMaxAgeMonths,
		retentionMonths: (await readSetting<number>(ctx, "retentionMonths")) ?? d.retentionMonths,
	};
}

// ── host-derived site id (never trust the payload) ────────────────────────────

function siteIdFromCtx(ctx: any): string {
	// Prefer the host-attested site URL; fall back to the request host.
	const raw = ctx.site?.url ?? ctx.request?.url;
	try {
		return new URL(raw).hostname;
	} catch {
		return "unknown";
	}
}

// ── routes ────────────────────────────────────────────────────────────────────

const saveSchema = z
	.object({
		subjectId: z.string().max(64),
		action: z.enum(["all", "necessary", "custom"]),
		grants: z.record(z.string(), z.boolean()), // keys validated below (c15t category set)
		givenAt: z.number().optional(),
		policyVersion: z.string().max(32),
		bannerVersion: z.string().max(32),
	})
	.strict(); // reject unknown keys, including a spoofed siteId

const ALLOWED_GRANT_KEYS = new Set(["necessary", "measurement", "marketing"]);

// Delivery: EmDash JSON-wraps route return values, so the bundle route returns
// the source as a string and the loader unwraps `.data`. The response is
// `immutable`, so after the first visit the browser serves it from its own
// cache with no network (verified). Cloudflare's edge does NOT cache the
// `/_emdash/api/` path, so the FIRST visit per browser still runs the Worker;
// the head `preload` starts that fetch early.

export const consentRoutes = {
	// the banner bundle: public, GET, immutable-cached (name carries the content hash)
	[BUNDLE_ROUTE]: {
		public: true,
		cacheControl: "public, max-age=31536000, immutable",
		handler: async () => BANNER_JS,
	},

	// Block Kit settings page behind the sidebar link (admin-session gated)
	admin: adminRoute,

	// Consent proof as CSV. Private (admin session, plugins:manage), raw response so it downloads as a file.
	[EXPORT_ROUTE]: {
		response: "raw" as const,
		handler: async (ctx: any) => {
			const siteId = siteIdFromCtx(ctx);
			const lines = [csvHeaderLine()];
			let cursor: string | undefined;
			// Page through the whole table. The response is built in memory (plugin responses are
			// text or bytes, not a stream), so very large histories need a future streaming route.
			do {
				const page = await ctx.storage.consents.query({
					where: { siteId },
					orderBy: { ts: "asc" },
					limit: 100,
					cursor,
				});
				for (const item of page.items) lines.push(consentCsvLine(item.data as ConsentRecord));
				cursor = page.hasMore ? page.cursor : undefined;
			} while (cursor);
			return pluginResponse({
				status: 200,
				headers: {
					"content-type": "text/csv; charset=utf-8",
					"content-disposition": 'attachment; filename="consent-export.csv"',
					"cache-control": "private, no-store",
					"x-content-type-options": "nosniff",
				},
				body: { kind: "text", value: `${lines.join("\r\n")}\r\n` },
			});
		},
	},

	// single source of truth for the banner AND the Datenschutz text
	services: {
		public: true,
		handler: async (ctx: any) => (await loadSettings(ctx)).services,
	},

	save: {
		public: true,
		input: saveSchema,
		handler: async (ctx: any) => {
			// CSRF: a cross-site page must not be able to post a consent record for this visitor.
			if (!isSameOriginRequest(ctx.request?.headers ?? {}, ctx.request?.url ?? "", ctx.site?.url)) {
				throw PluginRouteError.forbidden("Cross-origin consent save refused");
			}
			// c15t reports all five of its categories; we offer three. Keep only the
			// known keys (never widen the stored row) instead of rejecting - a
			// reject would drop a legitimate consent proof. Unknown keys are ignored.
			const grants: Record<string, boolean> = {};
			for (const k of ALLOWED_GRANT_KEYS) grants[k] = ctx.input.grants[k] === true;
			grants.necessary = true; // always on
			const siteId = siteIdFromCtx(ctx);
			await ctx.storage.consents.put(crypto.randomUUID(), {
				siteId, // host-attested, authoritative
				subjectId: ctx.input.subjectId, // c15t random client id, not person-derived
				ts: ctx.input.givenAt ?? Date.now(),
				action: ctx.input.action,
				grants,
				policyVersion: ctx.input.policyVersion,
				bannerVersion: ctx.input.bannerVersion,
			}); // NO ip, user-agent, email, name, country
			// Lazy retention: the daily cron hook proved unreliable (the host swallows
			// hook errors), so also purge from here - at most once a day, one bounded
			// batch - using only code paths this route already relies on. Never let a
			// purge problem fail a consent save.
			try {
				if (purgeDue(await ctx.kv.get("state:lastPurge"), Date.now())) {
					await ctx.kv.set("state:lastPurge", { at: Date.now(), via: "save" });
					await purgeExpired(ctx, 1);
				}
			} catch (err) {
				ctx.log?.error?.(`[emdash-privacy] lazy purge failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return { ok: true };
		},
	},
};

// ── hooks ──────────────────────────────────────────────────────────────────────

export const privacyHooks = {
	"plugin:activate": {
		handler: async (_event: any, ctx: any) => {
			if (ctx.cron?.schedule) {
				await ctx.cron.schedule("retention-purge", { schedule: "0 3 * * *" });
			}
		},
	},

	cron: {
		handler: async (event: any, ctx: any) => {
			if (event.name !== "retention-purge") return;
			// Purge FIRST. Bookkeeping must never block the purge: observed live,
			// `ctx.kv.set` can fail inside the cron context, and an exception before the
			// delete silently skipped it. The host swallows hook errors, so record the
			// outcome best-effort only. (The lazy purge in /save is the backstop.)
			let outcome: Record<string, unknown>;
			try {
				outcome = { at: Date.now(), via: "cron", deleted: await purgeExpired(ctx) };
			} catch (err) {
				outcome = { at: Date.now(), via: "cron", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
			}
			try {
				await ctx.kv.set("state:lastPurge", outcome);
			} catch {
				/* best-effort */
			}
		},
	},

	"page:fragments": {
		handler: async (event: any, ctx: any) => {
			const s = await loadSettings(ctx);
			// no banner when disabled or when there is nothing to consent to
			if (!s.enabled || s.services.length === 0) return null;

			const policyUrls = [s.privacyUrl, s.cookieUrl, s.imprintUrl];
			const config = {
				// the browser picks the language from the bundled translations, see locale.ts
				language: languageCandidate(s.language, event.page?.locale),
				colorScheme: s.colorScheme,
				requireChoice: s.requireChoice,
				bannerPosition: s.bannerPosition,
				accentColor: s.accentColor || undefined,
				rule: buildPolicyRule({
					policyVersion: s.policyVersion,
					cookieMaxAgeMonths: s.cookieMaxAgeMonths,
				}),
				services: s.services,
				clearOnRevocation: buildClearOnRevocation(s.services),
				legalLinks: { privacy: s.privacyUrl, imprint: s.imprintUrl, cookies: s.cookieUrl },
				// policy pages show no banner (text stays readable); the reopen button still shows
				hidePrompt: isPolicyPage(event.page?.path ?? "", policyUrls),
				policyVersion: s.policyVersion,
				bannerVersion: BANNER_VERSION,
			};

			const fragments: PageFragmentContribution[] = [
				{
					// Config + loader in head. The loader imports the bundle from
					// localStorage when present (no network at all), so there is NO
					// preload link: a preload would fetch the bundle on every page even
					// when it is already cached, which is exactly the waste we removed.
					kind: "inline-script",
					placement: "head",
					code: `window.__emdashPrivacy=${safeInlineJson(config)};`,
					key: "emdash-privacy-config",
				},
				{
					// Tiny loader; the bundle itself comes from the immutable-cached route.
					// Not inlined: the HTML parser closes an inline <script> at the first
					// literal `</` (c15t has one inside a `/</gu` regex), and inlining would
					// also re-send ~370 KB with every page view.
					kind: "inline-script",
					placement: "body:end",
					code: LOADER,
					key: "emdash-privacy-js",
				},
			];
			return fragments;
		},
	},
};
