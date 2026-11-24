/**
 * Tracked-services config: parsing, validation and the cookie-cleanup map.
 *
 * Pure (no runtime imports) so `services.selfcheck.ts` can run it under Node.
 * The browser turns a validated spec into a c15t `Script` in `client/presets.ts`,
 * because c15t helpers return callbacks that cannot be serialised into the page.
 *
 * Two forms per entry:
 *   - preset: a vendor from `@c15t/integrations` (correct consent wiring, gated
 *     loading). `{"preset":"google-tag","options":{"id":"G-XXXX"}}`
 *   - custom: any https script we do not know. `{"src":"https://..."}`
 *     (the old format; a Google gtag URL is upgraded to the google-tag preset).
 */

const SERVICE_CATEGORIES = ["analytics", "marketing"] as const;
type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

interface PresetDef {
	/** Category the vendor's helper gates on. `either` = the helper accepts both. */
	category: ServiceCategory | "either";
	/** Option keys the helper needs, with the pattern each trimmed value must match. */
	options: Record<string, RegExp>;
	/** Cookies the vendor is known to set. Used for clear-on-revocation unless the entry lists its own. */
	cookies: readonly string[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DIGITS = /^\d{1,20}$/;

/**
 * Supported presets. Names and option keys follow the c15t integration docs
 * (node_modules/@c15t/core/docs/integrations/*.md). Default cookies come from the
 * c15t clear-on-revocation examples. Vendors whose cookies the c15t docs do not
 * name get an empty default: add their cookies in the entry's `cookies` list.
 * Reviewed: 2026-11-23.
 */
const PRESETS = {
	"google-tag": { category: "either", options: { id: /^[A-Z]{1,3}-[A-Z0-9]{4,20}$/ }, cookies: ["_ga", "_ga_*"] },
	"google-tag-manager": { category: "either", options: { id: /^GTM-[A-Z0-9]{4,20}$/ }, cookies: [] },
	"microsoft-clarity": { category: "analytics", options: { id: ID }, cookies: [] },
	"plausible-analytics": { category: "analytics", options: { scriptId: ID }, cookies: [] },
	"umami-analytics": { category: "analytics", options: { websiteId: ID }, cookies: [] },
	"matomo-analytics": { category: "analytics", options: { matomoUrl: /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._~/-]*)?$/i, siteId: DIGITS }, cookies: [] },
	"fathom-analytics": { category: "analytics", options: { site: ID }, cookies: [] },
	"cloudflare-web-analytics": { category: "analytics", options: { token: ID }, cookies: [] },
	"meta-pixel": { category: "marketing", options: { pixelId: DIGITS }, cookies: ["_fbp"] },
	hotjar: { category: "analytics", options: { siteId: DIGITS }, cookies: [] },
} satisfies Record<string, PresetDef>;

type PresetId = keyof typeof PRESETS;
export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

/** A validated entry. Exactly one of `preset` / `src` is set. */
export interface ServiceSpec {
	id: string;
	name: string;
	category: ServiceCategory;
	/** Shown in the privacy text. Not used by the banner. */
	provider?: string;
	purpose?: string;
	preset?: PresetId;
	options?: Record<string, string>;
	src?: string;
	cookies: string[];
}

interface ParseResult {
	services: ServiceSpec[];
	errors: string[];
}

const ALLOWED_KEYS = new Set(["id", "name", "category", "provider", "purpose", "preset", "options", "src", "cookies"]);
const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'+.^_`|~-]{1,64}$/; // no *: c15t allows one only as a trailing prefix
const GTAG_SRC = /^https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=([A-Za-z0-9-]{4,40})$/;

/**
 * Checks a third-party script URL. Returns an error message, or null when it is
 * allowed. Rejects anything that is not a plain https URL to a public-looking
 * hostname: no credentials, no non-443 port, no IP literal, no `localhost`/`.local`.
 * `allowedHosts` (optional) restricts the hostname to those domains and their subdomains.
 */
export function checkScriptUrl(raw: string, allowedHosts: readonly string[] = []): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "is not a valid URL";
	}
	if (url.protocol !== "https:") return "must use https://";
	if (url.username || url.password) return "must not contain credentials";
	if (url.port && url.port !== "443") return "must use the default https port";
	const host = url.hostname.toLowerCase();
	if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return "must not be an IP address";
	if (!host.includes(".")) return "needs a fully qualified hostname";
	if (host.endsWith(".local") || host.endsWith(".internal")) return "must be a public hostname";
	if (allowedHosts.length && !allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
		return `hostname ${host} is not in the allowed script hosts`;
	}
	return null;
}

/** Validates the comma/space separated `allowedScriptHosts` setting. */
export function parseAllowedHosts(raw: unknown): { hosts: string[]; error: string | null } {
	const text = typeof raw === "string" ? raw : "";
	const hosts = text
		.split(/[\s,]+/)
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean);
	const bad = hosts.find((h) => !/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,63}$/.test(h));
	return bad ? { hosts: [], error: `Allowed script host "${bad}" is not a plain domain name` } : { hosts, error: null };
}

/**
 * Parses the `services` setting (JSON array, or an already-parsed array).
 * Invalid entries are dropped and reported; valid ones are kept. The admin form
 * refuses to save while `errors` is non-empty, so a typo cannot silently hide the banner.
 */
export function parseServices(raw: unknown, allowedHosts: readonly string[] = []): ParseResult {
	let list: unknown = raw;
	if (typeof raw === "string") {
		try {
			list = JSON.parse(raw.trim() || "[]");
		} catch {
			return { services: [], errors: ["Services is not valid JSON."] };
		}
	}
	if (!Array.isArray(list)) return { services: [], errors: ["Services must be a JSON array."] };

	const errors: string[] = [];
	const services: ServiceSpec[] = [];
	const seen = new Set<string>();
	list.forEach((entry, i) => {
		const at = (msg: string, id?: string) => errors.push(`Service ${i + 1}${id ? ` (${id})` : ""}: ${msg}`);
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return at("must be an object");
		const e = entry as Record<string, unknown>;
		for (const key of Object.keys(e)) if (!ALLOWED_KEYS.has(key)) return at(`unknown field "${key}"`);
		if (typeof e.id !== "string" || !SERVICE_ID.test(e.id)) return at("id must be 1-64 letters, digits, - or _");
		const id = e.id;
		if (seen.has(id)) return at(`duplicate id`, id);
		if (e.category !== "analytics" && e.category !== "marketing") {
			return at('category must be "analytics" or "marketing"', id);
		}
		const category: ServiceCategory = e.category;

		// `cookies` present (even empty) replaces the preset default.
		let cookies: string[] | undefined;
		if (e.cookies !== undefined) {
			if (!Array.isArray(e.cookies) || e.cookies.some((c) => typeof c !== "string")) {
				return at("cookies must be a list of names", id);
			}
			const bad = (e.cookies as string[]).find((c) => !validCookieName(c));
			if (bad !== undefined) return at(`cookie name "${bad}" is not valid (* is allowed only at the end)`, id);
			cookies = [...new Set(e.cookies as string[])];
		}

		const name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : id;
		const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
		const info = { provider: text(e.provider), purpose: text(e.purpose) };
		let spec: ServiceSpec;

		if (e.preset !== undefined) {
			if (e.src !== undefined) return at("use either preset or src, not both", id);
			if (typeof e.preset !== "string" || !(PRESET_IDS as string[]).includes(e.preset)) {
				return at(`unknown preset "${String(e.preset)}" (supported: ${PRESET_IDS.join(", ")})`, id);
			}
			const preset = e.preset as PresetId;
			const def: PresetDef = PRESETS[preset];
			if (def.category !== "either" && def.category !== category) {
				return at(`preset ${preset} is a ${def.category} vendor, set category to "${def.category}"`, id);
			}
			const options = validatePresetOptions(def, e.options);
			if (typeof options === "string") return at(options, id);
			spec = { id, name, category, ...info, preset, options, cookies: cookies ?? [...def.cookies] };
		} else {
			if (typeof e.src !== "string") return at("needs a preset or an https src", id);
			const gtag = GTAG_SRC.exec(e.src);
			if (gtag) {
				// A pasted gtag.js URL becomes the google-tag preset, so Consent Mode is set up correctly.
				const def = PRESETS["google-tag"];
				spec = { id, name, category, ...info, preset: "google-tag", options: { id: gtag[1] }, cookies: cookies ?? [...def.cookies] };
			} else {
				const urlError = checkScriptUrl(e.src, allowedHosts);
				if (urlError) return at(`src ${urlError}`, id);
				spec = { id, name, category, ...info, src: e.src, cookies: cookies ?? [] };
			}
		}
		seen.add(id);
		services.push(spec);
	});
	return { services, errors };
}

function validatePresetOptions(def: PresetDef, raw: unknown): Record<string, string> | string {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "options must be an object";
	const given = raw as Record<string, unknown>;
	for (const key of Object.keys(given)) if (!(key in def.options)) return `unknown option "${key}"`;
	const out: Record<string, string> = {};
	for (const [key, pattern] of Object.entries(def.options)) {
		const value = given[key];
		if (value === undefined || value === null || String(value).trim() === "") return `option "${key}" is required`;
		const text = String(value).trim();
		if (!pattern.test(text)) return `option "${key}" has an invalid value`;
		out[key] = text;
	}
	return out;
}

/** A cookie name, or a prefix ending in `*`, as c15t's clearOnRevocation accepts. */
export function validCookieName(name: string): boolean {
	if (name.endsWith("*")) return name.length > 1 && COOKIE_NAME.test(name.slice(0, -1));
	return COOKIE_NAME.test(name);
}

/** c15t optional category for a service category. */
export function c15tCategory(category: ServiceCategory): "measurement" | "marketing" {
	return category === "analytics" ? "measurement" : "marketing";
}

type ClearOnRevocationMap = Partial<Record<"measurement" | "marketing", { cookies: string[] }>>;

/**
 * clearOnRevocation config: the cookies each optional c15t category owns, merged
 * across services. c15t deletes them when the category is denied.
 */
export function buildClearOnRevocation(services: readonly ServiceSpec[]): ClearOnRevocationMap {
	const byCategory: Record<"measurement" | "marketing", Set<string>> = { measurement: new Set(), marketing: new Set() };
	for (const s of services) for (const c of s.cookies) byCategory[c15tCategory(s.category)].add(c);
	const out: ClearOnRevocationMap = {};
	for (const key of ["measurement", "marketing"] as const) {
		if (byCategory[key].size) out[key] = { cookies: [...byCategory[key]] };
	}
	return out;
}
