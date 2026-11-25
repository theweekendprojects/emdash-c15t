# emdash-c15t

> Previously published as `emdash-privacy` (0.1.0). The plugin id, routes and stored data keep the `emdash-privacy` name, so existing sites need no change. Only the npm package name moved.

Not affiliated with or endorsed by c15t or EmDash.

Per-site cookie consent for [EmDash CMS](https://emdashcms.com), built to meet GDPR / TDDDG requirements.
A themed banner (German and English, plus any language you bundle) that follows your site's design and light/dark mode, with Google
Consent Mode v2 and Global Privacy Control, powered by [c15t](https://c15t.com). The consent proof is
stored in your own Cloudflare D1. No third-party consent backend, no CDN, no paid service.

> **Not legal advice.** This plugin provides a configurable consent *mechanism*. It is built to meet
> GDPR/TDDDG requirements and does not guarantee compliance. Have your setup and your privacy policy
> reviewed by a lawyer. It does not generate an Impressum or a Datenschutzerklärung.

## What you get

- **Opt-in for every visitor.** Optional categories (Analytics, Marketing) are denied until the visitor
  chooses. No country detection: country is not the legal test, and an unknown or VPN country must fail safe.
- **Accept and Reject have equal weight** (same style, same size). A third "Settings" action opens the
  preference dialog. A floating button lets visitors change or withdraw consent later.
- **Gated scripts.** Your analytics/marketing scripts load only after the matching category is granted.
  Vendor presets come from the official c15t integrations (see below), so their consent wiring is c15t's.
- **Cookie cleanup on withdrawal.** Cookies a service is known to set are deleted when its category is denied,
  not just blocked from loading again (c15t `clearOnRevocation`).
- **Google Consent Mode v2** from the official c15t Google tag helper. Consent defaults are `denied` before
  any choice and `update` follows the real choice. The Google tag itself is not loaded before consent.
- **GPC** (`Sec-GPC` / `navigator.globalPrivacyControl`): optional categories stay denied and no banner
  is shown.
- **Looks like your site.** Colors, font and radius come from your own CSS variables (`--color-brand`,
  `--color-bg`, `--color-text`, `--color-border`, `--font-body`, ...) with neutral fallbacks, and light/dark
  follows your page live, including a theme toggle. Set an accent color in settings to override the brand color.
- **Placement you choose.** Floating corners, top or bottom bar, or a blocking wall (see Configure).
- **Non-blocking by default.** No dimmed overlay and no scroll lock, so your Impressum and Datenschutz pages stay
  readable before a choice is made. On phones the banner is a bottom sheet. Policy pages show no banner at all.
- **Embedded videos wait for consent.** A YouTube or Vimeo embed shows a placeholder and makes no request to the
  video host until the matching category is allowed.
- **Consent proof without personal data.** One record per choice: a random id, the visitor's random c15t
  client id, timestamp, choice, per-category grants, policy and banner version, and the site. No IP,
  user agent, e-mail, name or country. Admins can download the records as CSV.
- **Safe configuration.** Invalid service entries stop the settings from saving, so a typo cannot silently
  hide the banner. Third-party script URLs must be https, on a public hostname, and can be limited to your own domains.
- **Resilient.** If saving fails, the choice still applies and c15t queues the save in the browser and
  retries on a later page load.

## Install

```bash
npm install emdash-c15t
```

```ts
// astro.config.mjs
import { privacyPlugin } from "emdash-c15t";

emdash({
  plugins: [privacyPlugin()],
});
```

It is a trusted, standard-format EmDash plugin (it needs the privileged `page:fragments` hook). Your
layout must render EmDash's page-contribution components (`<EmDashHead>`, `<EmDashBodyEnd>`), as the
EmDash templates do.

## Configure

Admin → **Privacy** (the sidebar page). It is the only editor for these settings: it checks the whole form before saving.

| Setting | Meaning |
| --- | --- |
| Enable consent banner | Master switch. Off = nothing is injected. |
| Tracked services (JSON) | Your analytics/marketing services. **The banner only appears when this list is non-empty.** With no services the page still starts c15t (no banner, no reopen button), so embedded videos can open the preference dialog. Invalid entries block saving. |
| Allowed script hosts | Optional. Comma-separated domains. When set, custom `src` URLs must be on these domains or their subdomains. |
| Banner language | `auto` (follows the page language), or a code such as `de`, `en`, `fr`. Unbundled languages show German. See Languages. |
| Color scheme | Follow the page (default), Light, or Dark. |
| Banner position | Floating bottom-left (default), bottom-right, bottom-center, top-left, top-right, top-center, or a bar at the top or bottom. |
| Require a choice (blocking wall) | Off (default): non-modal, the site stays usable until the visitor chooses. On: a centred wall dims and locks the page until Accept or Reject (the "consent wall" style). Neither is legally required. |
| Accent color | Optional CSS color; defaults to your `--color-brand`. |
| Privacy / Imprint / Cookie URLs | Linked from the banner. A relative path (`/datenschutz`) or an https URL. A page on this site with that path shows no banner. An https URL on another host does not hide the banner here. |
| Policy version | **Bump it to ask every visitor again**, for example after adding a service. |
| Re-ask after N months | Default 12. |
| Delete records older than N months | Default 36. Pick the period with legal advice. |

### Tracked services

Each entry is either a **preset** (a known vendor, wired by c15t) or a **custom** https script.

```json
[
  {
    "id": "ga4",
    "name": "Google Analytics",
    "category": "analytics",
    "provider": "Google Ireland Limited",
    "purpose": "Reichweitenmessung",
    "preset": "google-tag",
    "options": { "id": "G-XXXXXXXXXX" }
  },
  {
    "id": "meta",
    "name": "Meta Pixel",
    "category": "marketing",
    "preset": "meta-pixel",
    "options": { "pixelId": "123456789012345" }
  },
  {
    "id": "custom",
    "name": "Example widget",
    "category": "marketing",
    "src": "https://widgets.example.com/loader.js",
    "cookies": ["widget_id", "widget_session_*"]
  }
]
```

`category` is `analytics` or `marketing`. Analytics means c15t's `measurement` category.

Presets (options in brackets):

| Preset | Category | Options |
| --- | --- | --- |
| `google-tag` | either | `id` (G-, AW-, DC-) |
| `google-tag-manager` | either | `id` (GTM-) |
| `microsoft-clarity` | analytics | `id` |
| `plausible-analytics` | analytics | `scriptId` |
| `umami-analytics` | analytics | `websiteId` |
| `matomo-analytics` | analytics | `matomoUrl` (https), `siteId` |
| `fathom-analytics` | analytics | `site` |
| `cloudflare-web-analytics` | analytics | `token` |
| `meta-pixel` | marketing | `pixelId` |
| `hotjar` | analytics | `siteId` |

A pasted `https://www.googletagmanager.com/gtag/js?id=G-…` custom `src` is upgraded to the `google-tag`
preset automatically, so Consent Mode is set up correctly.

Not offered as a preset: **Microsoft UET**. Its c15t helper loads `bat.js` before any choice, which
would contact Microsoft before consent. Add it as a custom script only after you have checked the consequences.

Custom `src` URLs must be `https://`, with no credentials, no IP address, no `localhost`, and the default
port. If you set **Allowed script hosts**, they must also be on one of those domains.

`cookies` lists the cookies to delete when the entry's category is denied. Use an exact name, or a prefix
ending in `*` (`_ga_*` matches `_ga_ABC123` but not `_ga`). Preset entries have default cookies (for
example `_ga` and `_ga_*` for Google Analytics); an explicit `cookies` list replaces them. c15t never
deletes its own consent records, and it cannot delete HttpOnly cookies.

The public `GET /_emdash/api/plugins/emdash-privacy/services` route returns the parsed list with `name`,
`provider` and `purpose`, so a privacy-policy page can read the same source of truth as the banner.

### Embedded videos

```astro
---
import ConsentEmbed from "emdash-c15t/embed";
---
<ConsentEmbed provider="youtube" id="dQw4w9WgXcQ" title="Product demo" lang="en" />
```

The component renders a YouTube (privacy-enhanced) or Vimeo iframe with c15t's `data-src` and
`data-category`, so the browser makes no request to the video host until the category is allowed. A
placeholder with a "Privacy settings" button shows until then. Give it the category it needs with
`category="analytics"` or `category="marketing"` (the default). The URL is built from the provider and an ID
that is checked against a pattern, so content cannot point it at another host.

EmDash's embed blocks (`@emdash-cms/plugin-embeds`) do not use this component. Gating those blocks would mean
rendering them through `ConsentEmbed` in your theme. That API is not verified, so treat it as untested.

### Languages

The bundle ships German and English. Any other language in the setting or on the page falls back to German,
so no bundled text is missing. To add a language, import it from c15t and add it to
`src/client/languages.ts`, then rebuild (`npm run build:client`):

```ts
import { translations as fr } from "@c15t/translations/fr";
export const bundledTranslations = { de, en, fr };
```

Each language adds about 6 KB. Importing the `@c15t/translations/all` barrel adds about 285 KB, so avoid it.

### Policy pages

On the privacy, imprint and cookie pages the banner is hidden, so the text stays readable. The floating
reopen button still shows, so visitors can change their choice there.

## Privacy: what to disclose

Your Datenschutzerklärung must list what this mechanism stores. It is generally treated as necessary for
the consent mechanism itself; have a lawyer confirm.

- a first-party `c15t` cookie and localStorage entries (the consent state, and a queue of unsent saves),
- the consent proof record described above, with its retention period (default 36 months),
- every cookie your tracked services set, as listed by their vendors. Those are yours to disclose.

## Consent records (CSV export)

The Privacy settings page shows how many records are stored and has a **Download consent records (CSV)** link.
The link is signed and expires after 15 minutes, so a browser can follow it with no API token. Each time the page
loads it makes a fresh link. For part of the history, fill in **From** and **To** and choose **Create download
link**. A bad date shows an error and no link.

Automation (scripts, backups) can use an API token instead. EmDash's private admin routes need a browser session or a
token, and a plain command can't send the header EmDash requires for session requests, so this route is a command-line step.
1. In EmDash, create an API token with the `admin` scope. Its value starts with `ec_pat_`.
2. Download the file:

```bash
curl -H "Authorization: Bearer ec_pat_..." \
  -o consent-export.csv \
  https://your-site.example/_emdash/api/plugins/emdash-privacy/consent-export
```

The admin page shows this URL for your site. The owner link produces the same file. The file has one row per record, oldest first. Columns: `createdAt`,
`policyVersion`, `bannerVersion`, `action`, `necessary`, `measurement`, `marketing`, `subjectId`, `siteId`. `siteId` is
the hostname the choice was saved under (a site reached through two hostnames exports both together). Every cell
is quoted, and a cell that starts like a spreadsheet formula gets a leading `'`, so it opens as text.

EmDash limits a plugin download to 8 MiB, which is roughly 50 000 to 65 000 records, depending on the length of the hostname. A larger history is refused with `413` and a
message, never cut short. Export it in parts with `from` (included) and `to` (not included), as ISO dates or
date-times. Consecutive parts do not overlap and leave no gap:

```bash
curl -H "Authorization: Bearer ec_pat_..." -o part-1.csv "https://your-site.example/_emdash/api/plugins/emdash-privacy/consent-export?from=2026-01-01&to=2026-07-01"
curl -H "Authorization: Bearer ec_pat_..." -o part-2.csv "https://your-site.example/_emdash/api/plugins/emdash-privacy/consent-export?from=2026-07-01"
```

A malformed `from` or `to` is an error (`400`), not ignored.

A token without the `admin` scope gets `403 INSUFFICIENT_SCOPE`. Revoke the token once the export is done.

## Public JavaScript API

After the banner starts, the client is at `window.emdashPrivacy`. It is the c15t `@c15t/browser` client, so the
documented methods work on it:

```js
// Is the analytics category allowed right now? (a permission, not a recorded choice)
window.emdashPrivacy.has("measurement");

// React to changes
const stop = window.emdashPrivacy.subscribe((snapshot) => console.log(snapshot));
window.emdashPrivacy.on("consent", () => { /* the visitor saved a choice */ });

// Open the preference dialog from your own button
window.emdashPrivacy.openDialog();
```

Any element with the attribute `data-emdash-privacy-open` also opens the dialog when clicked.

Note: `window.c15t` is c15t's debug object, not the API. Use `window.emdashPrivacy`.

## Development

Development requires Node 22.23.4 or newer (the Astro 7 toolchain). The integration tests also use `node:sqlite`. EmDash itself needs Node 22.16 or newer.

```bash
npm install --legacy-peer-deps   # --legacy-peer-deps: npm's peer resolver fails on vitest's optional browser peers
npx playwright-core install chromium   # once, for the browser tests
npm test                         # all integration tests (tests/): the real EmDash runtime, in-memory SQLite,
                                 #   a headless browser on the real banner, and an Astro build of ConsentEmbed
npm run selfcheck                # unit checks: policy rule through c15t's engine, validation, same-origin, CSV, layout, language
npm run typecheck                # tsc over src/
npm run build:client             # bundles the banner into src/assets.generated.ts (also runs on npm pack)
```

The browser tests need `dist/banner.js` (run `npm run build:client` first). To use an existing Chromium
instead of the one Playwright installs, set `CHROMIUM_PATH`.

## Operating notes

- **Rate limiting.** `/save` is public and has no rate limiting in code. The plugin has no access to Worker
  bindings, and the IP never reaches it. **Add a Cloudflare rate-limiting rule** for the save route. In the
  dashboard: WAF → Rate limiting rules → Create. Match `http.request.uri.path eq "/_emdash/api/plugins/emdash-privacy/save"`,
  count per IP (`ip.src`), and pick a limit above what a real visitor needs. See
  [Cloudflare's guide](https://developers.cloudflare.com/waf/custom-rules/rate-limiting/create-dashboard).
- **Same-origin.** `/save` refuses requests whose `Origin` (or, without it, `Sec-Fetch-Site`) is not your site.
  A plain script with no browser headers is refused as well.
- **Retention.** Expired records are purged from inside `/save`, at most once a day per site, up to 2 000 records
  per run. A backlog larger than that clears over later days. The daily cron task clears up to 5 000 records per run,
  but the host did not reliably run plugin cron hooks in testing, so do not depend on it.
- **Stored time.** Every record is stamped with the server's clock when it arrives. The browser's own timestamp is ignored.
- **Content Security Policy.** The banner does not run under a strict CSP. With `script-src 'self'` and no
  `'unsafe-inline'`, the browser blocks the loader script, so the banner never appears (tested in Chromium: the console
  reports a CSP violation). Two EmDash limits cause this. EmDash refuses to serve JavaScript from a plugin route, and it
  gives plugins no nonce for page fragments. A site that uses this plugin needs:
  - `script-src 'unsafe-inline' blob:` (the loader is an inline script that imports the bundle from a `blob:` URL).
  The bundle itself comes from your own origin. Sites that must keep a strict policy should not use this plugin until
  EmDash supports nonces or plugin scripts. Upstream: [emdash-cms/emdash#4827](https://github.com/emdash-cms/emdash/issues/4827)
  (hash-based CSP blocks EmDash's own toolbar script) and [#1601](https://github.com/emdash-cms/emdash/issues/1601)
  (the same class of problem for JSON-LD, now closed).
- **Weight.** About 1 KB of inline script is added to each page. The bundle (about 405 KB minified, about 117 KB gzipped) is fetched once per browser, then cached in `localStorage` under a content-hash key.
  After that the loader imports it from `localStorage` with no network at all (verified: zero bundle requests on
  later page views). Before running a cached copy the loader checks its SHA-256 against the hash the page was built
  with. A copy that does not match is removed and the bundle is fetched again. Keys from other versions are removed.
  Without SubtleCrypto (plain http, not localhost) nothing is cached. A quota or parse error falls back to the fetch,
  so cache trouble can't break the banner.
- **Multi-tenant.** The site key comes from the server-side site URL, never from the request body, and a
  body containing a `siteId` is rejected. Records live in EmDash plugin storage, so they follow whatever isolation your
  platform gives plugin storage. On emdash-multisite each site has its own storage table, so the record count and the
  export cover that site and no other.

## License

MIT © The Weekend Projects. The bundled third-party code (c15t, valibot, base-x) keeps its own license. The notices and
license texts are in `THIRD_PARTY_LICENSES.md`, which ships in the npm package.
