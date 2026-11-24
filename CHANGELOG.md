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

## 0.2.0
Not yet published. A hardening release after a deep review of 0.1.0 and the first 0.2.0 work. Some behaviour changed,
so read the breaking notes first.

**Breaking or behaviour changes**
- The stored consent time is the server's clock. The browser's `givenAt` is ignored. Existing records are unchanged.
- Saves while the banner is disabled store nothing (they return `{ok: true, stored: false}`).
- CSV export is a command-line step with an API token that has the `admin` scope. The old download link is removed.
  A browser request without a token gets `403 CSRF_REJECTED`, as EmDash enforces.
- The admin page is the only settings editor. The auto-generated `settingsSchema` form is removed, because it skipped validation.
- The CSV has a ninth column, `siteId`. Parsers that read by position are unaffected; a parser that checks the column count is not.
- Retention and re-ask periods outside their range (1-120 and 1-36 months) are errors, not a silent default.
- A `subjectId` must not be empty, and a save may carry at most 20 grant keys.
- The peer range is `emdash >=1.2.0`. The package was previously declared `>=0.30.0`, which was never tested.
- Development requires Node 22.23.4 or newer (Astro 7.4).

**Found by the live test and the second review**
- Every record was stored with `siteId: "unknown"` on hosts where `ctx.site.url` is empty (the multisite host is one).
  The fallback used `??`, which does not fall through on an empty string. Fixed in one helper, `siteIdFrom()`.
- The CSV export failed with a 500 for a history over roughly 50 000 to 65 000 records (EmDash's 8 MiB response limit; the file stops at 7 MiB). It now
  answers 413 with instructions, and `from`/`to` export a history in parts.
- The export and the purge were quadratic: `orderBy` on a JSON field re-sorted every match on each page (7 000 rows took
  13 s, now 0.7 s). Neither orders by a JSON field now.
- The export and the admin record count filtered by `siteId`. With the fix above, a site reached through two hostnames would
  have shown only the records of the hostname you happened to call. They now cover all of the site's storage. The export
  has a `siteId` column.
- A policy URL on another host hid the banner on this site's page with the same path. Absolute URLs now have to match the host.
- Tests: the loader's inline source is run in Node against fakes (no SubtleCrypto, storage that throws, a swapped bundle).
  The published tarball was installed into a clean Astro project and `emdash-c15t/embed` built from `node_modules`.

**Fixes**
- Lazy purge: EmDash caps a query page at 100 rows. The purge asked for 200, and removed only 100 per run. It now
  pages correctly and clears up to 2 000 records per visit-day, with the cron run clearing 5 000.
- Bundle cache: a cached copy runs only if its SHA-256 matches the build hash. Anything else is removed and refetched.
  Other versions' cache keys are removed. A tampered cache entry can no longer run.
- Embed-only sites: with no tracked services, c15t still starts (banner hidden, no reopen button), so a `ConsentEmbed`
  placeholder can open the preference dialog and gate its video.
- Settings: all settings are read in one query, not one per setting, on every public render and admin page load.
- Raw CSV response: the route no longer sets headers EmDash discards. EmDash sets `nosniff` and `no-store` itself.
- `zod` is a runtime dependency (pinned). The c15t packages are build-time only.
- A stored invalid services config shows an error on the admin page.
- Third-party notices: `THIRD_PARTY_LICENSES.md` ships in the package (c15t Apache-2.0, valibot and base-x MIT).

**Tests and tooling**
- Integration tests on the real EmDash runtime (SQLite), a headless browser against the real banner and runtime, and an
  Astro build of `ConsentEmbed`. `npm test`.
- Regression tests for each review finding (`tests/review.test.ts`).
- CI runs the suite on EmDash 1.2.0 (the floor) and 1.6.0, on Node 22.23.5.
- Dev dependencies upgraded: EmDash 1.6.0, Astro 7.4.13, Vitest 4.1.12, esbuild 0.28.2, and exact pins for `@types/node`
  and `typescript`. `npm audit` reports nothing for production, and nothing for the dev tree.
- `AGENTS.md` records the EmDash and c15t facts that were verified.

**Earlier work since 0.1.0**
- **CSV export** is now a command-line step with an API token that has the `admin` scope (`curl` with
  `Authorization: Bearer ec_pat_...`). The admin page shows the URL. The broken browser download link is removed. A plain
  browser request without a token is refused with 403 `CSRF_REJECTED`, as EmDash enforces.
- **Browser tests**: a headless Chromium drives the real banner against the real runtime. It checks no vendor request before
  a choice, accept loads them and stores one record, reject loads none and persists, the fallback language, and that
  policy pages show no banner. External requests are intercepted.
- **Embed test**: `ConsentEmbed` is built with Astro in a fixture, and the output is checked.
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
