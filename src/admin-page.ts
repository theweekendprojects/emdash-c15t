/**
 * Sidebar settings page (Block Kit), the same mechanism emdash-better-auth and
 * emdash-smtp use. `settingsSchema` alone only surfaces under
 * Plugins -> manager -> Settings; an `adminPages` entry plus this `admin` route
 * gives the plugin its own sidebar link. Values are stored as `settings:<key>`
 * in kv, exactly where `loadSettings()` in runtime.ts reads them.
 *
 * Authorization: the route is NOT public, so EmDash gates it behind the admin
 * session (default permission `plugins:manage`).
 */
import { purgeExpired } from "./purge.js";
import { isBannerPosition, BANNER_POSITIONS } from "./presentation.js";
import { isLanguageSetting } from "./locale.js";
import { parseAllowedHosts, parseServices } from "./services.js";
import { SETTINGS_DEFAULTS } from "./shared.js";

export const ADMIN_PAGE_PATH = "/settings";
const EXPORT_PATH = "/_emdash/api/plugins/emdash-privacy/consent-export";
const SAVE_ACTION = "save_privacy";
const PURGE_ACTION = "purge_now";

interface Interaction {
	type?: string;
	action_id?: string;
	values?: Record<string, unknown>;
}

/** Same host-derived tenant key the /save route writes. */
function siteHost(ctx: any): string {
	try {
		return new URL(ctx.site?.url ?? ctx.request?.url).hostname;
	} catch {
		return "unknown";
	}
}

/**
 * Block Kit external links must be absolute. `ctx.url()` is only absolute when the site
 * URL is configured, so fall back to the origin of the admin request itself.
 */
function absoluteUrl(ctx: any, path: string): string {
	const viaSite = typeof ctx.url === "function" ? ctx.url(path) : path;
	if (/^https?:\/\//i.test(viaSite)) return viaSite;
	try {
		return new URL(path, ctx.request?.url).toString();
	} catch {
		return viaSite;
	}
}

async function readKv<T>(ctx: any, key: string): Promise<T | undefined> {
	return ((await ctx.kv.get(`settings:${key}`)) ?? undefined) as T | undefined;
}

async function buildPage(ctx: any, toast?: { message: string; type: "success" | "error" }) {
	const d = SETTINGS_DEFAULTS;
	const v = {
		enabled: (await readKv<boolean>(ctx, "enabled")) ?? d.enabled,
		services: (await readKv<string>(ctx, "services")) ?? d.services,
		allowedScriptHosts: (await readKv<string>(ctx, "allowedScriptHosts")) ?? d.allowedScriptHosts,
		language: (await readKv<string>(ctx, "language")) ?? d.language,
		colorScheme: (await readKv<string>(ctx, "colorScheme")) ?? d.colorScheme,
		bannerPosition: (await readKv<string>(ctx, "bannerPosition")) ?? d.bannerPosition,
		accentColor: (await readKv<string>(ctx, "accentColor")) ?? "",
		requireChoice: (await readKv<boolean>(ctx, "requireChoice")) ?? d.requireChoice,
		privacyUrl: (await readKv<string>(ctx, "privacyUrl")) ?? "",
		imprintUrl: (await readKv<string>(ctx, "imprintUrl")) ?? "",
		cookieUrl: (await readKv<string>(ctx, "cookieUrl")) ?? "",
		policyVersion: (await readKv<string>(ctx, "policyVersion")) ?? d.policyVersion,
		cookieMaxAgeMonths: (await readKv<number>(ctx, "cookieMaxAgeMonths")) ?? d.cookieMaxAgeMonths,
		retentionMonths: (await readKv<number>(ctx, "retentionMonths")) ?? d.retentionMonths,
	};
	const siteId = siteHost(ctx);
	const total = await ctx.storage.consents.count({ siteId });
	const exportUrl = absoluteUrl(ctx, EXPORT_PATH);

	return {
		blocks: [
			{ type: "header", text: "Privacy & cookie consent" },
			{
				type: "context",
				text: "Consent mechanism built to meet GDPR/TDDDG requirements. Not legal advice - have the result reviewed by a lawyer. The banner only shows when at least one service is listed.",
			},
			{
				type: "stats",
				items: [{ label: "Consent records stored", value: String(total) }],
			},
			{
				type: "form",
				block_id: "privacy_settings",
				fields: [
					{ type: "toggle", action_id: "enabled", label: "Enable consent banner", initial_value: v.enabled },
					{
						type: "text_input",
						action_id: "services",
						label: "Tracked services (JSON)",
						multiline: true,
						initial_value: v.services,
						placeholder:
							'[{"id":"ga4","name":"Google Analytics","category":"analytics","preset":"google-tag","options":{"id":"G-XXXXXXXX"}}]',
					},
					{
						type: "text_input",
						action_id: "allowedScriptHosts",
						label: "Allowed script hosts (optional, comma-separated domains)",
						initial_value: v.allowedScriptHosts,
					},
					{
						type: "text_input",
						action_id: "language",
						label: "Banner language: auto, or a code such as de, en, fr",
						initial_value: v.language,
					},
					{
						type: "select",
						action_id: "colorScheme",
						label: "Color scheme",
						options: [
							{ label: "Follow page / system", value: "system" },
							{ label: "Light", value: "light" },
							{ label: "Dark", value: "dark" },
						],
						initial_value: v.colorScheme,
					},
					{
						type: "select",
						action_id: "bannerPosition",
						label: "Banner position",
						options: BANNER_POSITIONS.map((value) => ({ label: value, value })),
						initial_value: v.bannerPosition,
					},
					{ type: "text_input", action_id: "accentColor", label: "Accent color (CSS color)", initial_value: v.accentColor },
					{
						type: "toggle",
						action_id: "requireChoice",
						label: "Require a choice (blocking wall)",
						description: "Off: non-modal, site usable. On: dims the page until the visitor chooses.",
						initial_value: v.requireChoice,
					},
					{ type: "text_input", action_id: "privacyUrl", label: "Privacy policy URL", initial_value: v.privacyUrl },
					{ type: "text_input", action_id: "imprintUrl", label: "Imprint (Impressum) URL", initial_value: v.imprintUrl },
					{ type: "text_input", action_id: "cookieUrl", label: "Cookie policy URL", initial_value: v.cookieUrl },
					{
						type: "text_input",
						action_id: "policyVersion",
						label: "Policy version (bump to re-ask every visitor)",
						initial_value: v.policyVersion,
					},
					{
						type: "number_input",
						action_id: "cookieMaxAgeMonths",
						label: "Re-ask after N months",
						min: 1,
						max: 36,
						initial_value: v.cookieMaxAgeMonths,
					},
					{
						type: "number_input",
						action_id: "retentionMonths",
						label: "Delete consent records older than N months (pick with legal advice)",
						min: 1,
						max: 120,
						initial_value: v.retentionMonths,
					},
				],
				submit: { label: "Save", action_id: SAVE_ACTION },
			},
			{
				type: "actions",
				elements: [
					{ type: "link", label: "Download consent records (CSV)", target: { kind: "external", url: exportUrl } },
					{
						type: "button",
						label: "Delete expired records now",
						action_id: PURGE_ACTION,
						style: "danger",
						confirm: {
							title: "Delete expired consent records?",
							text: "Removes every consent record older than the retention period. This cannot be undone.",
							confirm: "Delete",
							deny: "Cancel",
							style: "danger",
						},
					},
				],
			},
		],
		...(toast ? { toast } : {}),
	};
}

/** A policy link: a relative path or an https URL. Empty is allowed (link hidden). */
function policyUrlError(value: string): string | null {
	if (!value) return null;
	if (value.startsWith("/") && !value.startsWith("//")) return null;
	try {
		return new URL(value).protocol === "https:" ? null : "must be an https:// URL or a path starting with /";
	} catch {
		return "must be an https:// URL or a path starting with /";
	}
}

/**
 * Validates the whole form, then writes it. Nothing is written unless every field is valid,
 * so a bad service entry cannot silently replace a working config. Returns an error or null.
 */
async function save(ctx: any, values: Record<string, unknown>): Promise<string | null> {
	const str = (k: string) => (typeof values[k] === "string" ? (values[k] as string).trim() : "");
	const num = (k: string, fallback: number) => {
		const n = Number(values[k]);
		return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
	};

	const hosts = parseAllowedHosts(str("allowedScriptHosts"));
	if (hosts.error) return hosts.error;

	const services = parseServices(str("services") || "[]", hosts.hosts);
	if (services.errors.length) {
		const shown = services.errors.slice(0, 3).join("; ");
		return services.errors.length > 3 ? `${shown} (+${services.errors.length - 3} more)` : shown;
	}

	if (!isLanguageSetting(str("language") || "auto")) return "Language must be 'auto' or a language code such as de or en.";
	const position = str("bannerPosition") || SETTINGS_DEFAULTS.bannerPosition;
	if (!isBannerPosition(position)) return "Banner position is not valid.";

	for (const k of ["privacyUrl", "imprintUrl", "cookieUrl"] as const) {
		const err = policyUrlError(str(k));
		if (err) return `${k === "privacyUrl" ? "Privacy" : k === "imprintUrl" ? "Imprint" : "Cookie"} URL ${err}.`;
	}

	const scheme = ["system", "light", "dark"].includes(str("colorScheme")) ? str("colorScheme") : "system";
	const writes: Record<string, unknown> = {
		enabled: values.enabled === true,
		services: str("services") || "[]",
		allowedScriptHosts: hosts.hosts.join(" "),
		language: str("language") || "auto",
		colorScheme: scheme,
		bannerPosition: position,
		accentColor: str("accentColor"),
		requireChoice: values.requireChoice === true,
		privacyUrl: str("privacyUrl"),
		imprintUrl: str("imprintUrl"),
		cookieUrl: str("cookieUrl"),
		policyVersion: str("policyVersion") || SETTINGS_DEFAULTS.policyVersion,
		cookieMaxAgeMonths: num("cookieMaxAgeMonths", SETTINGS_DEFAULTS.cookieMaxAgeMonths),
		retentionMonths: num("retentionMonths", SETTINGS_DEFAULTS.retentionMonths),
	};
	for (const [k, val] of Object.entries(writes)) await ctx.kv.set(`settings:${k}`, val);
	return null;
}

export const adminRoute = {
	handler: async (ctx: any) => {
		const i = (ctx.input ?? {}) as Interaction;
		if (i.type === "form_submit" && i.action_id === SAVE_ACTION) {
			const err = await save(ctx, i.values ?? {});
			return buildPage(ctx, err ? { message: err, type: "error" } : { message: "Saved", type: "success" });
		}
		if (i.type === "block_action" && i.action_id === PURGE_ACTION) {
			const n = await purgeExpired(ctx);
			return buildPage(ctx, { message: `Deleted ${n} expired record(s)`, type: "success" });
		}
		return buildPage(ctx); // page_load / anything else
	},
};
