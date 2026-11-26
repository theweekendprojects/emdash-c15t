# Testing emdash-c15t

This document lists every test the plugin has, how to run them, what was tested live on a real EmDash site, and what is still not tested. The automated inventory below is generated from the test suite (`npx vitest list`).

## Summary

- Automated: **100 tests** in **7 files**, run by `npm test` (Node 22.23.5, EmDash 1.6.0; CI also runs EmDash 1.2.0).
- Self-checks: `npm run selfcheck` (pure helpers, policy rule through c15t's engine).
- Live on staging: a real EmDash multi-site host and a tenant, driven through the browser (Playwright, Chromium and Firefox). Results are in the matrix below.

## How to run

```bash
npm install --legacy-peer-deps
npx playwright-core install chromium firefox   # once; WebKit needs macOS 13.5+ or Linux
npm run build:client                             # required before the browser tests
CHROMIUM_PATH=/path/to/chrome-headless-shell npm test   # optional: use an existing Chromium
npm run selfcheck
npm run typecheck
npm pack --dry-run                              # the package contents
```

The full `npm test` takes about 2.5 minutes. The browser tests need a built bundle (`dist/banner.js`).

## Automated inventory

### `tests/review.test.ts` (26 tests)

Regression tests for each bug found in review (timestamps, purge paging, export size, host and policy checks, empty settings, caches, bounds).

- finding 1: the stored time is the server's, not the browser's > a far-future givenAt is ignored: the record is stored at receive time
- finding 1: the stored time is the server's, not the browser's > a backdated givenAt is ignored too
- finding 2: one lazy purge clears a backlog, not just 100 rows > removes every expired record once the daily gate opens
- finding 3: third-party license notices travel with the package > ships THIRD_PARTY_LICENSES.md and lists it in files
- finding 3: third-party license notices travel with the package > names c15t with its Apache-2.0 license, and the bundled MIT packages
- finding 4: the peer range matches the EmDash versions we test > declares emdash >=1.2.0 (raw responses need 0.39+, 1.2.0 is the tested floor)
- finding 7: a public render does not run one query per setting > reads all settings in a constant number of queries
- finding 8: input bounds > a save while the banner is disabled stores nothing (no proof for a banner nobody saw)
- finding 8: input bounds > an empty subjectId is refused
- finding 8: input bounds > more than 20 grant keys is refused
- finding 8: input bounds > retention of 0 months is an error, not a silent change to 36
- finding 8: input bounds > retention above 120 months is an error
- finding 8: input bounds > re-ask period above 36 months is an error
- finding 9: no dead headers on the raw CSV response > the route sets nothing EmDash would discard (EmDash sets nosniff and no-store itself)
- admin reachability > still refuses a non-admin after the changes
- live finding: the site id falls back to the request host when the site URL is empty > stores the request's host as siteId when the site URL is empty
- review round 2: export completeness and limits > a history too large for one response is refused with a clear error, never cut short
- review round 2: export completeness and limits > from and to slice a large history into parts with no overlap and no gap, in linear time
- review round 2: export completeness and limits > rejects a malformed from or to instead of ignoring it
- review round 2: export completeness and limits > exports records saved under different hostnames together (storage is per site, siteId is only a label)
- review round 2: export completeness and limits > the admin record count includes records saved under every hostname
- review round 2: policy pages and host > a policy URL hosted elsewhere does not hide the banner on this site's page with the same path
- review round 2: policy pages and host > a policy URL on this host does hide it
- review round 2: policy pages and host > a relative policy URL hides it
- review round 2: empty settings > clearing the language, position and policy version in the form falls back to the defaults, not to empty values
- review round 2: empty settings > a policy version made of spaces is not saved as an empty version

### `tests/plugin.test.ts` (42 tests)

Plugin routes and behaviour through the real EmDash runtime and in-memory SQLite: save, services, export, admin page, fragments, download link, Consent Mode stub.

- save route > stores one proof record for a same-origin request, with only the proof fields
- save route > keeps only the three known grant keys and always records necessary as granted
- save route > refuses a cross-origin POST and stores nothing
- save route > refuses an opaque origin ('null') and a cross-site Sec-Fetch-Site
- save route > refuses a request with no origin information at all
- save route > accepts Sec-Fetch-Site same-origin when no Origin header is sent
- save route > rejects a client-supplied siteId (strict schema)
- save route > rejects an unknown action and a missing required field
- save route > exports a formula-like subjectId as text, so a spreadsheet will not run it
- services route > is public and returns the parsed services with name, provider and purpose
- services route > returns the configured presets
- admin route > refuses a subscriber and an anonymous caller
- admin route > renders CSV export instructions with the absolute export URL and a Bearer example
- admin route > rejects invalid services and keeps the previous configuration
- admin route > rejects services that are not valid JSON, and a non-https policy URL
- admin route > rejects a free-text language and an unknown banner position
- admin route > saves valid settings and the public services route reflects them
- CSV export > returns a CSV attachment to an admin
- CSV export > refuses a subscriber and an anonymous caller
- CSV export > an API token with the admin scope can download without the CSRF header
- CSV export > an API token without the admin scope is refused
- CSV export > refuses a browser-style download without the CSRF header (EmDash enforces this on private routes)
- page:fragments (banner injection) > injects the config in head and the loader at body end
- page:fragments (banner injection) > sends Consent Mode defaults (denied) in head before the config when a Google service is set
- page:fragments (banner injection) > sends no Consent Mode stub when no Google service is configured
- page:fragments (banner injection) > passes the page language candidate, not a resolved language
- page:fragments (banner injection) > hides the prompt on a policy page
- page:fragments (banner injection) > injects nothing when the banner is disabled
- page:fragments (banner injection) > with no services, still starts c15t with the banner hidden and no reopen button (embed-only sites)
- page:fragments (banner injection) > escapes a </script> in an admin-entered service name so it cannot break the inline script
- retention > deletes records past the retention period when the lazy purge runs
- retention > runs the lazy purge at most once a day, so old records added later wait for the next run
- retention > the admin 'delete expired now' action removes expired records and reports the count
- scale: paging and batched purge > exports every record exactly once across export pages
- scale: paging and batched purge > the admin purge removes more than one batch of expired records
- admin: stored config warnings > shows an error banner when the stored services config has problems
- admin: stored config warnings > shows no banner when the stored config is valid
- owner download link (signed, expiring, no login) > the admin page links to a signed CSV that a browser can follow without a login
- owner download link (signed, expiring, no login) > a changed range or forged signature is refused
- owner download link (signed, expiring, no login) > a request without a link is refused
- owner download link (signed, expiring, no login) > a bad range on the form gives an error and no link
- owner download link (signed, expiring, no login) > a range from the form is carried in the link

### `tests/browser.test.ts` (13 tests)

Real Chromium on the real banner bundle: banner, accept, reject, per-service, reopen, policy page, language, embed gating, bundle integrity, strict CSP limit, Consent Mode state.

- banner in a real browser against the EmDash runtime > on an English page: no vendor request before a choice, accept loads them and stores one record
- banner in a real browser against the EmDash runtime > reject loads no vendor request, and the refusal persists after reload
- banner in a real browser against the EmDash runtime > a page language that is not bundled (French) shows German
- banner in a real browser against the EmDash runtime > a policy page shows no banner
- review: bundle cache integrity and embed-only sites > a tampered cached bundle is never run, and the banner still mounts from the verified bundle
- review: bundle cache integrity and embed-only sites > a verified cached copy loads with no bundle request, and a stale version's key is removed
- review: bundle cache integrity and embed-only sites > a site with no tracked services still starts c15t, so an embed placeholder can open the dialog
- content security policy (documented limits) > a strict policy (script-src 'self') blocks the loader, so no banner, and the browser reports the violation
- content security policy (documented limits) > inline script plus blob: (what the README asks for) runs the banner
- content security policy (documented limits) > inline script without blob: cannot import the bundle, so no banner
- Google Consent Mode defaults (denied until a choice) > before any choice: the default is denied, and no Google request is made
- Google Consent Mode defaults (denied until a choice) > after accept: the state becomes granted
- Google Consent Mode defaults (denied until a choice) > after reject: the state is denied, and the Google tag is never requested

### `tests/loader.test.ts` (10 tests)

The inline loader (localStorage cache, hash check, fallbacks) run in Node against fakes.

- inline loader (same source a page gets) > the bundle hash in the build matches the bundle
- inline loader (same source a page gets) > first visit: fetches, verifies, runs, and stores the bundle
- inline loader (same source a page gets) > second visit: a verified cached copy runs with no fetch
- inline loader (same source a page gets) > a cached copy with the wrong content is never run: it is removed and the real bundle is fetched
- inline loader (same source a page gets) > a fetched bundle that does not match the page's hash is not run and not stored
- inline loader (same source a page gets) > other versions' keys are removed, and unrelated keys are left alone
- inline loader (same source a page gets) > without SubtleCrypto: the bundle still runs, and nothing is cached
- inline loader (same source a page gets) > storage that throws does not break the banner
- inline loader (same source a page gets) > a full storage quota does not break the banner either
- inline loader (same source a page gets) > a failed fetch logs a warning and does not throw

### `tests/embed.test.ts` (1 tests)

ConsentEmbed compiled by a real Astro build.

- ConsentEmbed in an Astro build > renders gated iframes and an error for a malformed ID

### `tests/smoke.test.ts` (1 tests)

Basic runtime smoke test.

- boots the runtime and round-trips one consent save

### `tests/export-link.test.ts` (7 tests)

Owner download link: signing, expiry, tamper detection, per-site secret.

- export links > a fresh link is accepted
- export links > a link stops working when it expires
- export links > changing the range breaks the signature
- export links > a link signed with another secret is refused
- export links > a malformed or missing signature is refused
- export links > an expiry further ahead than this site can issue is refused
- export secret > is created once and then reused, so links stay valid

## Live results (staging, real browsers)

Run against the staging host with the plugin, first on the apex site and then on the tenant "Banner Check" (`banner-check`). Results are from one run each on the dates in the log; they are not part of `npm test`.

| Area | Check | Browser | Result | Notes |
|---|---|---|---|---|
| Banner | Shows to a new visitor | Chromium, Firefox | PASS |  |
| Banner | Accept saves (200) and hides the banner after reload | Chromium, Firefox | PASS |  |
| Banner | Reject saves (200), no Google request | Chromium, Firefox | PASS |  |
| Gating | No vendor request before a choice | Chromium, Firefox | PASS | Google loads only after accept |
| Per-service | Analytics only: Google loads, Marketing stays off; reopened dialog shows the saved state | Chromium | PASS |  |
| Reopen | Floating trigger reopens the dialog with the saved state | Chromium | PASS |  |
| Policy page | Banner hidden on the policy page, trigger still shown | Chromium | PASS |  |
| Consent Mode | Defaults denied before any choice (added in 0.3.1) | Chromium | PASS | Before 0.3.1 nothing was sent before a choice |
| Consent Mode | Granted after accept, denied after reject | Chromium | PASS |  |
| Cookies | Accept sets _ga and _ga_*; reject removes them; c15t cookies kept | Chromium | PASS |  |
| Policy version | Bumping the version asks a visitor who already chose | Chromium | PASS |  |
| Admin | Invalid service entry (http src) is refused with an error; stored list unchanged | Chromium | PASS |  |
| GPC | Sec-GPC: optional categories denied, no Google request | Chromium | PASS |  |
| GPC | Sec-GPC: banner hidden | Chromium | DIFFERS | Banner still shows; the README said it would not. README corrected. |
| Language | Unbundled language (fr) falls back to German | Chromium | PASS |  |
| Offline | Choice applies while saving is blocked; save delivered after reconnect | Chromium | PASS | c15t retries the queued save |
| Mobile | iPhone 13 emulation: accept inside the screen, tap saves and hides | Chromium | PASS | Emulation only, not a real device |
| Export | Owner's download link returns the CSV (9 columns, one row per choice) | Chromium | PASS | 3 rows for decline, per-service, accept |
| Export | Bad date shows an error and no link | Chromium | PASS |  |
| Strict CSP | script-src 'self' blocks the banner (documented limit) | Chromium | PASS | Confirms the known limit |
| Core flows | Banner, accept, reject, Google gating | Firefox | PASS | 7 of 7 checks |
| Core flows | Same flows | WebKit | NOT RUN | This Playwright WebKit build does not start on macOS 12.7; needs macOS 13.5+ or Linux CI |

Earlier runs (0.2.x, old tenant): decline, per-service, accept, owner CSV, bad date, policy page, embed-only sites, CSP, mobile. Those are listed in the 0.2.0 notes and were run before the rows above existed.

## Known gaps

Not tested, with the reason. Treat these as open until someone runs them.

- **WebKit / Safari** live: this Mac's Playwright WebKit build will not start a page (macOS 12.7). Run on macOS 13.5+ or a Linux CI runner.
- **Tenant isolation** live: records from one tenant must not appear in another tenant's export. Needs a second tenant.
- **Retention purge** live: the lazy purge in `/save` on a site with old records.
- **413 path** live: an export larger than 7 MiB. Covered by the integration tests, not on a live site.
- **Embed placeholder click** on a live page: needs a page that renders `ConsentEmbed`. Covered by `tests/embed.test.ts` (build) and the browser tests (gating), not clicked on a live site.
- **Keyboard and screen-reader accessibility**: needs manual testing with assistive technology. This is not something an automated test can confirm.
- **Cloudflare rate-limit rule** on the save route: documented in the README; not verified on the live platform.
- **Production**: the 0.1.0 consent records exported with 0.3.x (no owner login on prod for this run), and a real production tenant with services on.
- **Cron retention** on the host: the README says the host did not run plugin cron hooks reliably in testing.

## Behaviour that differs from the README

- **GPC does not hide the banner.** Optional categories are denied and no Google request is made, but the banner still shows so the visitor can choose. The README now says this.
- **Consent Mode defaults** were missing before 0.3.1. The README claimed defaults were denied before a choice; that was not true until 0.3.1 added the stub.

