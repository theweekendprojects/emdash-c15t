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
import type { PageFragmentContribution, PageFragmentEvent, PluginContext } from "emdash";
import type { RouteContext } from "./context.js";
import { z } from "zod";
import { adminRoute } from "./admin-page.js";
import { readAllSettings } from "./settings.js";
import { siteIdFrom } from "./site-id.js";
import { consentCsvLine, csvHeaderLine, type ConsentRecord } from "./export.js";
import { parseExportRange, rangeWhere } from "./export-range.js";
import { isSameOriginRequest, safeInlineJson } from "./security.js";
import { LAZY_PURGE_MAX_PAGES, PURGE_PAGE_SIZE, purgeDue, purgeExpired } from "./purge.js";
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
 * EmDash rejects a raw plugin response over 8 MiB (PLUGIN_ROUTE_MAX_BODY_BYTES). Stay under it with a margin, because the
 * count here is characters and the body is UTF-8 bytes. Test-only override: see tests/review.test.ts.
 */
const EXPORT_MAX_BYTES = 7 * 1024 * 1024;

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
	// Runs in the browser. Dependency-free, no template literals or ${} inside (it is a template string here).
	// Cache rule: a copy in localStorage runs only if its SHA-256 (first 12 hex) matches the hash the page was built
	// with. A mismatch means the copy was altered or is stale, so it is removed and the bundle is fetched again.
	// Without SubtleCrypto (plain http, not localhost) nothing is cached and the fetched bundle runs as usual.
	const fn = `(function(){
	var H=${JSON.stringify(hash)},P="emdash-privacy-js:",K=P+H,U=${JSON.stringify(url)};
	function run(src){return import(URL.createObjectURL(new Blob([src],{type:"text/javascript"})))}
	function digest(src){
		return crypto.subtle.digest("SHA-256",new TextEncoder().encode(src)).then(function(b){
			return Array.from(new Uint8Array(b)).map(function(x){return ("0"+x.toString(16)).slice(-2)}).join("").slice(0,12);
		});
	}
	function clearOld(){
		try{for(var i=localStorage.length-1;i>=0;i--){var k=localStorage.key(i);if(k&&k.indexOf(P)===0&&k!==K)localStorage.removeItem(k)}}catch(e){}
	}
	function fetched(){
		return fetch(U,{credentials:"omit"}).then(function(r){return r.json()}).then(function(j){
			var src=j.data;
			if(!("subtle" in crypto)) return run(src);
			return digest(src).then(function(d){
				if(d!==H) throw new Error("bundle does not match its hash");
				try{localStorage.setItem(K,src);clearOld()}catch(e){}
				return run(src);
			});
		});
	}
	var hit=null;try{hit=localStorage.getItem(K)}catch(e){}
	if(hit&&("subtle" in crypto)){
		return digest(hit).then(function(d){
			if(d===H){clearOld();return run(hit)}
			try{localStorage.removeItem(K)}catch(e){}
			return fetched();
		}).catch(function(e){console.warn("[emdash-privacy] banner failed to load",e)});
	}
	return fetched().catch(function(e){console.warn("[emdash-privacy] banner failed to load",e)});
})();`;
	return fn.replace(/\n\t*/g, "");
}
const LOADER = makeLoader(BUNDLE_URL, BANNER_HASH);

// ── settings ────────────────────────────────────────────────────────────────

/** Every setting, read in one query, with the defaults applied. Undefined values fall back to the default. */
async function loadSettings(ctx: PluginContext) {
	const d = SETTINGS_DEFAULTS;
	const all = await readAllSettings(ctx);
	const get = <T>(key: string, fallback: T): T => (all[key] === undefined || all[key] === null ? fallback : (all[key] as T));
	const str = (key: string): string | undefined => (typeof all[key] === "string" ? (all[key] as string) : undefined);

	const hostsResult = parseAllowedHosts(str("allowedScriptHosts"));
	const parsed = parseServices(get("services", d.services), hostsResult.hosts);
	if (parsed.errors.length) {
		// Bad entries are dropped so the banner still works for the valid ones. The admin form blocks saving them.
		ctx.log?.warn?.(`[emdash-privacy] ${parsed.errors.length} invalid service entr(y/ies) ignored: ${parsed.errors[0]}`);
	}
	return {
		enabled: get("enabled", d.enabled),
		services: parsed.services,
		colorScheme: get<"system" | "light" | "dark">("colorScheme", d.colorScheme),
		language: get("language", d.language),
		bannerPosition: get("bannerPosition", d.bannerPosition),
		requireChoice: get("requireChoice", d.requireChoice),
		accentColor: str("accentColor"),
		privacyUrl: str("privacyUrl"),
		imprintUrl: str("imprintUrl"),
		cookieUrl: str("cookieUrl"),
		policyVersion: get("policyVersion", d.policyVersion),
		cookieMaxAgeMonths: get("cookieMaxAgeMonths", d.cookieMaxAgeMonths),
		retentionMonths: get("retentionMonths", d.retentionMonths),
	};
}

// ── host-derived site id (never trust the payload) ────────────────────────────

/** The hostname of the page being rendered, or undefined when the page URL is missing or not a URL. */
function hostOf(url: string | undefined): string | undefined {
	try {
		return url ? new URL(url).hostname : undefined;
	} catch {
		return undefined;
	}
}

function siteIdFromCtx(ctx: { site?: { url?: string }; request?: { url?: string } }): string {
	return siteIdFrom(ctx.site?.url, ctx.request?.url);
}

// ── routes ────────────────────────────────────────────────────────────────────

const saveSchema = z
	.object({
		subjectId: z.string().min(1).max(64),
		action: z.enum(["all", "necessary", "custom"]),
		// Only three category keys are ever read (see save), so a body with many keys is noise or abuse. Cap it.
		grants: z
			.record(z.string(), z.boolean())
			.refine((g) => Object.keys(g).length <= 20, "too many grant keys"),
		// Sent by the banner bundle, but ignored: the stored time is the server's receive time (see save below).
		// Kept optional so bundles from 0.1.x still validate.
		givenAt: z.number().optional(),
		policyVersion: z.string().max(32),
		bannerVersion: z.string().max(32),
	})
	.strict(); // reject unknown keys, including a spoofed siteId

const ALLOWED_GRANT_KEYS = new Set(["necessary", "measurement", "marketing"]);

type SaveInput = z.infer<typeof saveSchema>;

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

	// Consent proof as CSV. Private (admin session or an admin-scope API token), raw response so it downloads as a file.
	// Everything in this plugin's storage is this site's: multi-site hosts give each site its own storage table, so the
	// export is not filtered by siteId (a site reached through two hostnames would otherwise export only half its records).
	[EXPORT_ROUTE]: {
		response: "raw" as const,
		handler: async (ctx: RouteContext) => {
			const range = parseExportRange(new URL(ctx.request.url).searchParams);
			if (typeof range === "string") throw PluginRouteError.badRequest(range);
			const lines = [csvHeaderLine()];
			let bytes = lines[0]!.length + 2;
			let cursor: string | undefined;
			// No orderBy: EmDash then pages in (created_at, id) order using the table's own index. A JSON orderBy defeats the
			// index and made every page re-sort the whole history (7 000 rows took 13 s). Records are stored in arrival order,
			// so this is chronological.
			do {
				const page = await ctx.storage.consents.query({ where: rangeWhere(range), limit: PURGE_PAGE_SIZE, cursor });
				for (const item of page.items) {
					const line = consentCsvLine(item.data as ConsentRecord);
					bytes += line.length + 2;
					// EmDash refuses a raw response over 8 MiB. Fail clearly before building it, never return a shortened file.
					if (bytes > EXPORT_MAX_BYTES) {
						return pluginResponse({
							status: 413,
							headers: { "content-type": "text/plain; charset=utf-8" },
							body: {
								kind: "text",
								value:
									"This export is too large for one download. Export it in parts with from and to, for example " +
									"?from=2026-01-01&to=2026-07-01 (from is included, to is not).\n",
							},
						});
					}
					lines.push(line);
				}
				cursor = page.hasMore ? page.cursor : undefined;
			} while (cursor);
			return pluginResponse({
				status: 200,
				// Only these two are kept by EmDash's raw-response allowlist. EmDash sets nosniff and private, no-store itself.
				headers: {
					"content-type": "text/csv; charset=utf-8",
					"content-disposition": 'attachment; filename="consent-export.csv"',
				},
				body: { kind: "text", value: `${lines.join("\r\n")}\r\n` },
			});
		},
	},

	// single source of truth for the banner AND the Datenschutz text
	services: {
		public: true,
		handler: async (ctx: RouteContext) => (await loadSettings(ctx)).services,
	},

	save: {
		public: true,
		input: saveSchema,
		handler: async (ctx: RouteContext) => {
			// EmDash has already validated the body against saveSchema, so this cast is safe.
			const input = ctx.input as SaveInput;
			// CSRF: a cross-site page must not be able to post a consent record for this visitor.
			if (!isSameOriginRequest(ctx.request?.headers ?? {}, ctx.request?.url ?? "", ctx.site?.url)) {
				throw PluginRouteError.forbidden("Cross-origin consent save refused");
			}
			// A save while the banner is off is a visitor's stale page. Nothing was shown, so there is no choice to prove.
			// Answer ok (not an error): c15t would keep the refused save in its outbox and retry it on every page load.
			const enabled = (await readAllSettings(ctx)).enabled;
			if (enabled === false) return { ok: true, stored: false };
			// c15t reports all five of its categories; we offer three. Keep only the
			// known keys (never widen the stored row) instead of rejecting - a
			// reject would drop a legitimate consent proof. Unknown keys are ignored.
			const grants: Record<string, boolean> = {};
			for (const k of ALLOWED_GRANT_KEYS) grants[k] = input.grants[k] === true;
			grants.necessary = true; // always on
			const siteId = siteIdFromCtx(ctx);
			await ctx.storage.consents.put(crypto.randomUUID(), {
				siteId, // host-attested, authoritative
				subjectId: input.subjectId, // c15t random client id, not person-derived
				// The server's clock, never the browser's: a client-supplied time could backdate or forward-date a proof.
				ts: Date.now(),
				action: input.action,
				grants,
				policyVersion: input.policyVersion,
				bannerVersion: input.bannerVersion,
			}); // NO ip, user-agent, email, name, country
			// Lazy retention: the daily cron hook proved unreliable (the host swallows
			// hook errors), so also purge from here - at most once a day, one bounded
			// batch - using only code paths this route already relies on. Never let a
			// purge problem fail a consent save.
			try {
				if (purgeDue(await ctx.kv.get("state:lastPurge"), Date.now())) {
					await ctx.kv.set("state:lastPurge", { at: Date.now(), via: "save" });
					await purgeExpired(ctx, LAZY_PURGE_MAX_PAGES);
				}
			} catch (err) {
				ctx.log?.error?.(`[emdash-privacy] lazy purge failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return { ok: true, stored: true };
		},
	},
};

// ── hooks ──────────────────────────────────────────────────────────────────────

export const privacyHooks = {
	"plugin:activate": {
		handler: async (_event: unknown, ctx: PluginContext) => {
			if (ctx.cron?.schedule) {
				await ctx.cron.schedule("retention-purge", { schedule: "0 3 * * *" });
			}
		},
	},

	cron: {
		handler: async (event: { name: string }, ctx: PluginContext) => {
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
		handler: async (event: PageFragmentEvent, ctx: PluginContext) => {
			const s = await loadSettings(ctx);
			// no banner when disabled or when there is nothing to consent to
			// Disabled: nothing at all. No services: still start c15t, so an embed placeholder can open the
			// preference dialog and gate its video. The banner stays hidden in that case (see hidePrompt).
			if (!s.enabled) return null;

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
				hidePrompt: s.services.length === 0 || isPolicyPage(event.page?.path ?? "", policyUrls, hostOf(event.page?.url)),
				// The reopen button only makes sense when there is something to consent to.
				showTrigger: s.services.length > 0,
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
