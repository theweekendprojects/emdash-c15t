/**
 * Constants shared by the descriptor (`index.ts`) and the runtime. Kept
 * dependency-free (type-only emdash import) so the self-checks can import it.
 */
import { BANNER_POSITIONS } from "./presentation.js";

/** Plugin id. Also the storage namespace and the public route prefix. Kept at the original name so existing data and routes keep working. */
export const PLUGIN_ID = "emdash-privacy";

/**
 * The published npm package name. EmDash resolves the descriptor `entrypoint` as a module specifier at the
 * consuming site's build time, so this MUST equal package.json "name" (guards.selfcheck.ts enforces it).
 */
export const PACKAGE_NAME = "emdash-c15t";

/**
 * Banner asset version. Bump when the shipped `dist/banner.js` changes so the
 * immutable-cached asset URL busts. Independent of the per-site policy version.
 */
export const BANNER_VERSION = "2";

/** The three consent categories this plugin offers. `necessary` is always on. */
export const CATEGORIES = ["necessary", "analytics", "marketing"] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Storage collections. One: the PII-free consent proof.
 *   - siteId:    host-derived tenant key (never from the payload)
 *   - ts:        epoch ms of the choice (for retention purge + ordering)
 *   - subjectId: c15t's random client id (answer a data-subject request)
 */
export const STORAGE_CONFIG = {
	consents: {
		indexes: ["siteId", "ts", "subjectId", ["siteId", "ts"]] as (string | string[])[],
	},
};

/** Defaults applied when a setting is unset. */
export const SETTINGS_DEFAULTS = {
	enabled: true,
	services: "[]",
	allowedScriptHosts: "",
	colorScheme: "system" as const,
	language: "auto",
	bannerPosition: "bottom-left",
	requireChoice: false,
	policyVersion: "1",
	cookieMaxAgeMonths: 12,
	retentionMonths: 36,
};
