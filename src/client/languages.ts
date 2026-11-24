/**
 * Banner translations that ship in the bundle, keyed by language code.
 *
 * Default: German and English (about 11 KB together). c15t bundles 35 languages
 * (about 285 KB if you import the `@c15t/translations/all` barrel), so each extra
 * language is opt-in. To ship one, add a line here and rebuild:
 *
 *   import { translations as fr } from "@c15t/translations/fr";
 *   export const bundledTranslations = { de, en, fr };
 *
 * A page or setting in an unbundled language falls back to German (see locale.ts).
 * Import per language from `@c15t/translations/<code>`, which is the documented
 * subpath export. Do not import the `/all` barrel for a single-site bundle.
 */
import { translations as de } from "@c15t/translations/de";
import { translations as en } from "@c15t/translations/en";

export const bundledTranslations: Record<string, Record<string, unknown>> = {
	de: de as unknown as Record<string, unknown>,
	en: en as unknown as Record<string, unknown>,
};
