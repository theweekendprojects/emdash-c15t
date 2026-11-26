/**
 * Google Consent Mode v2 defaults. Sent in <head> before any choice, so Google's tags (and the modelling that
 * depends on them) see "denied" until the visitor decides. The Google tag itself still loads only after consent
 * (c15t's gtag helper, loadMode "after-consent"); this stub loads no script, it only sets the default state.
 * Once a choice exists, the helper sends the real state (granted or denied) when it loads the tag.
 *
 * security_storage is granted by Google's own default: it covers security, not tracking.
 */
export const CONSENT_DEFAULT_DENIED =
	'window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){window.dataLayer.push(arguments)};' +
	'window.gtag("consent","default",{ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",' +
	'analytics_storage:"denied",functionality_storage:"denied",personalization_storage:"denied",' +
	'security_storage:"granted",wait_for_update:500});';

/** Presets that read Google Consent Mode. Only a page with one of them needs the default. */
const GOOGLE_PRESETS = new Set(["google-tag", "google-tag-manager"]);

export function needsConsentDefaults(services: ReadonlyArray<{ preset?: string }>): boolean {
	return services.some((s) => s.preset !== undefined && GOOGLE_PRESETS.has(s.preset));
}
