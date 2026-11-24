/**
 * Turns a validated service spec into a c15t `Script`. Runs in the browser, because
 * the c15t helpers return callbacks that cannot be serialised into the page.
 *
 * Presets use the official helpers from `@c15t/integrations` (same package, same
 * version as c15t). Their consent wiring and gating are c15t's, not ours. Google
 * tags use `loadMode: 'after-consent'`, so no request reaches Google before the
 * visitor allows the category. That is the README promise. (The helper's default
 * is `'always'`, which sends cookieless Consent Mode pings before a choice.)
 *
 * Deliberately NOT offered: Microsoft UET. Its helper sets `alwaysLoad: true`, so
 * `bat.js` loads before any choice, which breaks the promise above. Use a custom
 * `src` only once you have checked what that script does before consent.
 */
import type { Script } from "@c15t/core";
import { gtag } from "@c15t/integrations/google-tag";
import { googleTagManager } from "@c15t/integrations/google-tag-manager";
import { clarity } from "@c15t/integrations/microsoft-clarity";
import { plausibleAnalytics } from "@c15t/integrations/plausible-analytics";
import { umamiAnalytics } from "@c15t/integrations/umami-analytics";
import { matomoAnalytics } from "@c15t/integrations/matomo-analytics";
import { fathomAnalytics } from "@c15t/integrations/fathom-analytics";
import { cloudflareWebAnalytics } from "@c15t/integrations/cloudflare-web-analytics";
import { metaPixel } from "@c15t/integrations/meta-pixel";
import { hotjar } from "@c15t/integrations/hotjar";
import type { ServiceSpec } from "../services.js";
import { c15tCategory } from "../services.js";

type C15tCategory = "measurement" | "marketing";

/** Build one c15t script for a validated spec. */
export function toScript(spec: ServiceSpec): Script {
	const category: C15tCategory = c15tCategory(spec.category);
	if (!spec.preset) {
		return { id: spec.id, src: spec.src!, category } as Script;
	}
	const o = spec.options ?? {};
	switch (spec.preset) {
		case "google-tag":
			// Consent Mode defaults and updates come from the helper, sent before gtag/js loads.
			return gtag({ id: o.id!, category, loadMode: "after-consent" }) as Script;
		case "google-tag-manager":
			return googleTagManager({ id: o.id!, category, loadMode: "after-consent" }) as Script;
		case "microsoft-clarity":
			return clarity({ id: o.id! }) as Script;
		case "plausible-analytics":
			return plausibleAnalytics({ scriptId: o.scriptId! }) as Script;
		case "umami-analytics":
			return umamiAnalytics({ websiteId: o.websiteId! }) as Script;
		case "matomo-analytics":
			return matomoAnalytics({ matomoUrl: o.matomoUrl!, siteId: o.siteId! }) as Script;
		case "fathom-analytics":
			return fathomAnalytics({ site: o.site!, spa: "auto" }) as Script;
		case "cloudflare-web-analytics":
			return cloudflareWebAnalytics({ token: o.token! }) as Script;
		case "meta-pixel":
			return metaPixel({ pixelId: o.pixelId! }) as Script;
		case "hotjar":
			return hotjar({ siteId: o.siteId! }) as Script;
	}
}
