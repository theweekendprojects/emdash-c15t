/**
 * Browser entry, bundled at build time into `dist/banner.js` and embedded as a
 * string by `scripts/build-client.mjs`. It is served by the plugin's own public
 * asset route (no CDN). It composes c15t's local (offline) policy engine with our
 * own `save`, which posts a PII-free proof to the plugin's `/save` route.
 *
 * Why offline + custom save, instead of a server `init`:
 *   c15t's init fold requires a `policyResolution` in the init response; a
 *   hand-written `init` returning only geo would make resolution fail and the
 *   banner would never show. The offline transport synthesizes a valid
 *   policyResolution locally from our policy rule: strict opt-in, no network,
 *   nothing visitor-specific that could leak through cached HTML.
 *
 * Config is inlined by the `page:fragments` hook as `window.__emdashPrivacy`.
 */
import { init, offline } from "@c15t/browser";
import type { SavePayload, SaveResult } from "@c15t/core";
import { strings, imprintLabel } from "../strings.js";
import { bundledTranslations } from "./languages.js";
import { promptFor, triggerPosition } from "../presentation.js";
import { pickLocale } from "../locale.js";
import type { ServiceSpec } from "../services.js";
import { toScript } from "./presets.js";

interface PrivacyConfig {
	language: string | null; // candidate code from the server; null = unknown, fall back
	colorScheme: "system" | "light" | "dark";
	requireChoice?: boolean;
	bannerPosition: string;
	accentColor?: string;
	rule: unknown; // PolicyRuleOut from rule.ts, serialized server-side
	services: ServiceSpec[];
	clearOnRevocation: Partial<Record<"measurement" | "marketing", { cookies: string[] }>>;
	legalLinks: { privacy?: string; imprint?: string; cookies?: string };
	hidePrompt: boolean; // no banner: on policy pages, and on sites with no services (embed-only)
	showTrigger: boolean; // the floating reopen button; off when there are no services
	policyVersion: string;
	bannerVersion: string;
}

const cfg = (window as unknown as { __emdashPrivacy?: PrivacyConfig }).__emdashPrivacy;

/**
 * "system" means "match the PAGE", live. Sites theme via a CSS `color-scheme`
 * on <html> (the landing page does), a `dark` class, or the OS preference.
 * c15t's own "system" only reads the OS, so it showed a white banner on a dark
 * page (seen live). Order: page color-scheme, then a `dark` class, then the OS.
 * We deliberately ignore our own `c15t-dark` class here (we write it).
 */
function resolveScheme(): "light" | "dark" {
	const root = document.documentElement;
	const declared = getComputedStyle(root).colorScheme || "";
	if (/\bdark\b/.test(declared) && !/\blight\b/.test(declared)) return "dark";
	if (/\blight\b/.test(declared) && !/\bdark\b/.test(declared)) return "light";
	if (root.classList.contains("dark")) return "dark";
	return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Live light/dark sync. With `colorScheme: null` c15t follows the `c15t-dark`
 * class on <html> as it changes, so we only have to keep that class correct:
 * re-check when the page toggles its theme (class / style / data-theme on
 * <html> or <body>) or the OS preference changes. One rAF-debounced observer.
 */
function followPageScheme(): void {
	const root = document.documentElement;
	let queued = false;
	const apply = () => {
		queued = false;
		const dark = resolveScheme() === "dark";
		if (root.classList.contains("c15t-dark") !== dark) root.classList.toggle("c15t-dark", dark);
	};
	const schedule = () => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(apply);
	};
	apply();
	const opts = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-mode", "data-color-scheme"] };
	new MutationObserver(schedule).observe(root, opts);
	if (document.body) new MutationObserver(schedule).observe(document.body, opts);
	matchMedia("(prefers-color-scheme: dark)").addEventListener("change", schedule);
}

/**
 * Look: map c15t's theme tokens onto the host site's own CSS variables
 * (`--color-brand`, `--color-bg`, `--color-text`, ...), with neutral fallbacks,
 * so the banner follows whatever theme pack / design system the site uses and
 * its light/dark. The operator's `accentColor` setting wins over `--color-brand`.
 * Accept and Reject get the SAME treatment (equal prominence, no dark pattern).
 */
function buildTheme(accentColor?: string) {
	const accent = accentColor || "var(--color-brand, #2563eb)";
	const colors = {
		primary: accent,
		primaryHover: `color-mix(in srgb, ${accent} 86%, black)`,
		surface: "var(--color-bg, #ffffff)",
		surfaceHover: "color-mix(in srgb, var(--color-bg, #ffffff) 94%, gray)",
		border: "var(--color-border, rgba(128,128,128,0.28))",
		borderHover: "color-mix(in srgb, var(--color-border, rgba(128,128,128,0.28)) 60%, currentColor)",
		text: "var(--color-text, #111827)",
		textMuted: "var(--color-text-secondary, #6b7280)",
		textOnPrimary: "var(--color-on-brand, #ffffff)",
	};
	return {
		colors,
		dark: colors, // the page variables already switch with the page's scheme
		typography: { fontFamily: "var(--font-body, system-ui, sans-serif)" },
		radius: { sm: "8px", md: "12px", lg: "16px" },
		shadows: { lg: "0 12px 40px rgba(0,0,0,0.28), 0 2px 8px rgba(0,0,0,0.16)" },
		consentActions: {
			primary: { variant: "primary", mode: "filled" },
			accept: { variant: "primary", mode: "filled" },
			reject: { variant: "primary", mode: "filled" }, // same as accept on purpose
			customize: { variant: "neutral", mode: "ghost" },
		},
	};
}

/**
 * Extra CSS inside the banner's shadow root: card border and the mobile bottom
 * sheet. Position is left to `presentation`, so the banner-position setting works.
 */
const SHADOW_CSS = `
[data-testid="consent-banner-card"]{border:1px solid var(--c15t-border);backdrop-filter:saturate(1.2)}
[data-testid="consent-banner-title"]{font-weight:650;letter-spacing:-0.01em}
@media (max-width:640px){
  [data-testid="consent-banner-root"]{left:0;right:0;bottom:0;top:auto;max-width:none}
  [data-testid="consent-banner-card"]{border-radius:16px 16px 0 0;border-width:1px 0 0 0;width:100%}
  [data-testid="consent-banner-footer"]{flex-wrap:wrap}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

function routeBase(): string {
	return "/_emdash/api/plugins/emdash-privacy";
}

/**
 * Our save handler. Posts the choice to the plugin route; on any non-2xx we
 * return `ok:false` so c15t keeps the choice locally and replays from its
 * outbox on a later load. We never send a site id: the server derives it
 * from the request host.
 */
async function save(payload: SavePayload): Promise<SaveResult> {
	try {
		const res = await fetch(`${routeBase()}/save`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				subjectId: payload.subjectId,
				action: payload.consentAction, // 'all' | 'necessary' | 'custom'
				grants: payload.consents,
				givenAt: payload.givenAt ?? Date.now(),
				policyVersion: cfg?.policyVersion ?? "1",
				bannerVersion: cfg?.bannerVersion ?? "1",
			}),
			keepalive: true, // survive a page unload right after the click
		});
		if (!res.ok) return { ok: false };
		return { ok: true, subjectId: payload.subjectId };
	} catch {
		return { ok: false }; // queued + replayed by the kernel outbox
	}
}

/** Recursive merge of plain objects; `b` wins. Used to layer our wording over the bundled copy. */
function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...a };
	for (const [k, v] of Object.entries(b)) {
		const base = out[k];
		out[k] =
			v && typeof v === "object" && !Array.isArray(v) && base && typeof base === "object"
				? merge(base as Record<string, unknown>, v as Record<string, unknown>)
				: v;
	}
	return out;
}

/** Bundled c15t copy, with our de/en wording layered on top. */
function messagesWithOverrides(): Record<string, unknown> {
	const all: Record<string, unknown> = { ...bundledTranslations };
	for (const lang of ["de", "en"] as const) {
		all[lang] = merge(bundledTranslations[lang] ?? {}, strings[lang] as Record<string, unknown>);
	}
	return all;
}

/** Clear-on-revocation config in the shape c15t takes. */
function clearOnRevocationFor(map: PrivacyConfig["clearOnRevocation"]) {
	const out: Record<string, { cookies: string[] }> = {};
	for (const key of ["measurement", "marketing"] as const) if (map[key]) out[key] = map[key]!;
	return out;
}

/** Clicks on any `[data-emdash-privacy-open]` element open the preference dialog (the embed placeholders use this). */
function wireOpenButtons(client: { openDialog: () => unknown }): void {
	document.addEventListener("click", (event) => {
		const target = event.target as Element | null;
		const trigger = target?.closest?.("[data-emdash-privacy-open]");
		if (!trigger) return;
		event.preventDefault();
		void client.openDialog();
	});
}

function start(config: PrivacyConfig): void {
	// Compose: offline transport (local policyResolution) + our save.
	// `kind: "custom"` tells c15t this transport is already resolved and ships
	// in the bundle (no backend fetch).
	const offlineFactory = offline({ policyRules: [config.rule as never] });
	const mode = Object.assign(
		(ctx: Parameters<typeof offlineFactory>[0]) => ({
			...offlineFactory(ctx),
			save,
		}),
		{ kind: "custom" as const },
	);

	// Language: a configured or page language if it is bundled, else German.
	const locale = pickLocale(config.language, Object.keys(bundledTranslations));

	// set the scheme class BEFORE c15t mounts, so there is no wrong-scheme flash
	if (config.colorScheme === "system") followPageScheme();

	// requireChoice (operator setting, default off): a centred blocking wall, vs the
	// default non-modal card that leaves the site usable before a choice.
	const prompt = promptFor(config.bannerPosition, config.requireChoice === true);
	const legal = config.legalLinks;
	const legalKeys = [legal.privacy && "privacyPolicy", legal.cookies && "cookiePolicy", legal.imprint && "termsOfService"].filter(
		Boolean,
	) as ("privacyPolicy" | "cookiePolicy" | "termsOfService")[];
	const legalLinks = {
		...(legal.privacy ? { privacyPolicy: { href: legal.privacy } } : {}),
		...(legal.cookies ? { cookiePolicy: { href: legal.cookies } } : {}),
		...(legal.imprint ? { termsOfService: { href: legal.imprint, label: imprintLabel(locale) } } : {}),
	};

	const client = init({
		mode,
		ui: {
			// null = follow the <html> `c15t-dark` class live (kept in sync by
			// followPageScheme). An explicit operator choice is fixed.
			colorScheme: config.colorScheme === "system" ? null : config.colorScheme,
			theme: buildTheme(config.accentColor) as never,
			css: SHADOW_CSS,
			// Policy pages show no banner, so the text stays readable. Other pages show it
			// until the visitor chooses. The reopen button stays on every page.
			banner: config.hidePrompt ? false : { hideBranding: true, legalLinks: legalKeys },
			dialog: { hideBranding: true, legalLinks: legalKeys },
			trigger: config.showTrigger
				? {
						position: triggerPosition(config.bannerPosition),
						showWhen: config.hidePrompt ? "always" : "after-consent",
					}
				: false,
		},
		// Messages for every bundled language, our de/en wording on top.
		i18n: { locale, messages: messagesWithOverrides() as never, detectBrowserLanguage: false },
		consentCategories: ["necessary", "measurement", "marketing"],
		scripts: config.services.map(toScript),
		clearOnRevocation: clearOnRevocationFor(config.clearOnRevocation) as never,
		legalLinks: legalLinks as never,
		reloadOnConsentRevoked: true,
		presentation: { prompt },
	});
	wireOpenButtons(client as never);
	(window as unknown as { emdashPrivacy?: unknown }).emdashPrivacy = client;
}

if (cfg) {
	start(cfg);
} else if (typeof console !== "undefined") {
	console.warn("[emdash-privacy] no window.__emdashPrivacy config; banner not started");
}
