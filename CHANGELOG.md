# Changelog

## 0.1.0

First usable release. Verified end to end on a live EmDash site (Cloudflare Workers + D1).

- Consent banner (German + English) driven by c15t: strict opt-in for every visitor, Accept and Reject with
  equal weight, preference dialog, floating reopen button, non-blocking card (bottom sheet on phones).
- Follows the host site: colors, font and radius from the site's CSS variables, light/dark from the page
  and updated live when the theme is toggled.
- Optional "require a choice" blocking wall (operator setting, default off); default is a non-modal banner that leaves the site usable.
- Gated scripts, Google Consent Mode v2 (basic variant: `default` denied, then `update`), GPC.
- Consent proof in plugin storage (D1) with no personal data; failed saves are queued by c15t and retried.
- Admin: "Privacy" sidebar page (Block Kit) and a settings form, including banner language, policy version
  (bump = re-ask), re-ask period and retention.
- Public `/save` is strictly validated and rejects a client-supplied `siteId`. No in-code rate limiting
  (it slowed every save); use a Cloudflare rate-limiting rule instead.
- Retention purge runs lazily from `/save` (the host did not reliably run the daily cron hook).
- The ~380 KB bundle is served from an immutable, content-hashed route and cached in `localStorage`; after
  the first fetch per browser, later page views import it from `localStorage` with zero network. Pages
  carry only a ~1 KB loader.
- Self-check resolves the policy rule through c15t's real engine for several countries, so a rule the
  runtime would reject fails in CI instead of silently hiding the banner.

Known limits: cron hook unreliable on the tested host; strict CSP needs `script-src blob:`; tenant
isolation depends on the platform's plugin-storage isolation and was not exercised on a multi-site host.

## Unreleased
- **Tests**: 33 integration tests on the real EmDash runtime (`npm test`): save (same-origin, forged origin, strict
  schema, grants), services, admin validation and warnings, CSV export (auth, paging over 250 rows), page injection
  (escaping, policy page, disabled), retention (lazy and admin purge over 250 rows). A GitHub Actions workflow runs
  build, typecheck, self-checks and tests.
- **Dependencies**: `zod` is a runtime dependency (pinned). The `@c15t/*` packages are build-time only and moved to
  `devDependencies`. The published package no longer requires them.
- **Admin**: a warning banner appears when stored tracked-services config is invalid, instead of the banner silently vanishing.
- The published tarball no longer includes the self-check files.
- **Renamed the npm package** from `emdash-privacy` to `emdash-c15t`. The plugin id (`emdash-privacy`), routes and
  stored data are unchanged, so existing sites need no change. `emdash-privacy@0.1.0` stays on npm and should be deprecated.
Implements the gap plan in `docs/consent-feature-plan.md`. Reuses the official c15t APIs and integrations.
- **Cookie cleanup on withdrawal** (`clearOnRevocation`). Presets carry their known cookies, and entries can
  list their own.
- **Vendor presets** from `@c15t/integrations` (Google tag, GTM, Clarity, Plausible, Umami, Matomo, Fathom,
  Cloudflare Web Analytics, Meta Pixel, Hotjar). Google tag uses `loadMode: 'after-consent'`.
  Google's hand-written Consent Mode bridge is removed, because the helper does it. A pasted gtag.js URL is
  upgraded to the preset.
- **Microsoft UET is not offered as a preset**: its helper loads before consent.
- **Script URL validation**: https only, no credentials, public hostname, default port. Optional
  allowed-host list. Invalid service entries block saving.
- **Same-origin check** on the public `save` route. Cross-origin requests get 403.
- **Policy pages** (privacy, imprint, cookie) show no banner. The reopen button stays.
- **Banner position** setting (floating corners, top/bottom bar; the wall stays centred).
- **Languages**: `auto` or a code. Bundled languages are German and English; anything else falls back to German.
  The old rule "anything not English gets German" is now "anything not bundled gets German". Add languages in
  `src/client/languages.ts`.
- **Embed component** `emdash-c15t/embed` (`ConsentEmbed.astro`): YouTube and Vimeo that wait for consent.
- **CSV export** of consent records, admin only, with formula-injection escaping.
- **Public API** documented: `window.emdashPrivacy` (c15t client methods).
- **Fixes**: legal links used the wrong c15t keys and never rendered; `scrollLock` replaced by
  `presentation.prompt.blocking`; a service's `provider` and `purpose` are kept for the public route;
  `__emdashPrivacy` config is escaped for inline `<script>` (a `</script>` in an admin-set name could break out);
  the `./sandbox` export pointed at a missing file and is removed.
- Not implemented: in-code rate limiting. The plugin context has no Worker bindings, so the README gives a
  Cloudflare rate-limiting rule instead.
- Bundle: about 405 KB minified (was 379 KB), from the vendor helpers.
