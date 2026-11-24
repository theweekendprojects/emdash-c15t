/**
 * Banner language selection. Pure, self-checked.
 *
 * The server only works out a candidate code (the operator's setting, or the page
 * locale). The browser picks the language, because it knows which translations are
 * bundled (`src/client/languages.ts`). An unsupported language falls back to German,
 * the default for this plugin's German-market baseline.
 */

export const FALLBACK_LOCALE = "de";

/** Primary language subtag, lowercased, or null. `en-GB` -> `en`, `pt_BR` -> `pt`. */
function primary(code: string): string | null {
	const m = /^([a-z]{2,3})(?:[-_][A-Za-z0-9]{2,8})*$/i.exec(code.trim());
	return m ? m[1]!.toLowerCase() : null;
}

/**
 * The language the operator asked for. `auto` (or unset) follows the page's
 * `<html lang>` / EmDash page locale. A concrete code always wins over the page.
 */
export function languageCandidate(setting: unknown, pageLocale: unknown): string | null {
	if (typeof setting === "string" && setting.trim() && setting.trim().toLowerCase() !== "auto") {
		return primary(setting);
	}
	return typeof pageLocale === "string" ? primary(pageLocale) : null;
}

/** The supported language to use: the candidate if bundled, else the fallback. */
export function pickLocale(candidate: string | null, supported: readonly string[], fallback = FALLBACK_LOCALE): string {
	if (candidate && supported.includes(candidate)) return candidate;
	return supported.includes(fallback) ? fallback : (supported[0] ?? fallback);
}

/** Validates the `language` setting: `auto` or a language code. */
export function isLanguageSetting(value: unknown): boolean {
	return typeof value === "string" && (value.trim().toLowerCase() === "auto" || primary(value) !== null);
}
