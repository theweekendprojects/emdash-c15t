# emdash-privacy: feature gap analysis and implementation plan

Date: 2026-11-18
Scope: the features a production EmDash consent plugin should have, which of them emdash-privacy 0.1.0
already has, and how to add the rest by reusing existing libraries and platform features before
writing new code.

Status legend used below:

- **Verified**: confirmed in source, installed package docs, or the npm registry during this review.
- **Unverified**: an assumption that needs a test or a quick check before implementation.

---

## 1. Summary

emdash-privacy is a thin EmDash plugin around the c15t browser runtime. c15t handles the banner,
policy resolution, script gating, and Google Consent Mode. The plugin adds the EmDash plumbing: a
`page:fragments` injection, a public `save` route that stores a PII-free consent proof in plugin
storage, a public `services` route, a Block Kit admin page, and a retention purge.

The gaps fall into four groups:

1. Features c15t already provides and we do not yet wire up (cookie cleanup, locales, positions,
   public JS API).
2. Small server and input hardening we should add ourselves (same-origin check, https validation
   for script URLs, policy-page handling).
3. EmDash-specific features that c15t does not cover (embed placeholders for EmDash blocks, admin
   export of consent records, rate limiting).
4. Optional features (analytics presets, vendor list).

Design rule: keep c15t as the consent engine. Build only the EmDash-specific parts. Do not cap or
drop consent records to meet a storage limit. A proof log must keep recording whenever the plugin is
enabled.

---

## 2. Current state of emdash-privacy (Verified)

Files reviewed: `package.json`, `src/index.ts`, `src/runtime.ts`, `src/shared.ts`,
`src/client/banner.ts`, `README.md`, and the installed `@c15t/browser` 3.0.0 docs.

| Area | Current behaviour |
| --- | --- |
| Engine | `@c15t/browser` 3.0.0, pinned. Banner uses the `offline()` factory with a custom transport that posts to our `save` route (`src/client/banner.ts`). |
| Injection | `page:fragments` returns an inline config script in `head` and a tiny loader at `body:end`. The ~370 KB bundle is cached in `localStorage` under a content-hash key. |
| Public routes | `assets/banner-<hash>` (immutable), `services` (GET), `save` (POST, strict zod schema). |
| Admin | Block Kit page at `/settings` (sidebar "Privacy"). Settings: enabled, services JSON, language, colour scheme, require-a-choice, accent colour, legal URLs, policy version, cookie max age, retention. |
| Storage | `consents` collection with indexes on `siteId`, `ts`, `subjectId`. Fields: site id (host-derived), subject id (c15t random id), timestamp, action, grants, policy and banner version. No IP, user agent, email or country. |
| Retention | Purge at most once a day from inside `save`. A daily cron is also registered, but the README says the host does not reliably run plugin cron. |
| Script URLs | `buildScripts()` maps `analytics` to `measurement` and `marketing` to `marketing`. It only checks that `src` is a string. There is no https check and no host allowlist. |
| Security | Strict input schema (unknown keys rejected). Site id comes from the server-side site URL, never the body. No Origin check. No rate limiting in code (README asks for a Cloudflare rule instead). |
| c15t features in use | Offline policy, custom transport, `presentation`, `i18n` (de/en only), `scripts`, `legalLinks`, Google Consent Mode bridge, GPC via policy rule. |
| Not used | `clearOnRevocation`, vendor consent, analytics presets, embed gating, bundled translations beyond de/en, banner position setting. |

Known bug: `resolveLanguage()` in `src/shared.ts` maps every non-English page to German. Sites in
other languages get German copy.

---

## 3. Feature reference (what a complete consent plugin needs)

These are the capabilities the plan targets. Each one is described by what it does, not by any other
plugin's implementation.

- **Cookie cleanup on withdrawal.** When a visitor withdraws a category, the first-party cookies and
  storage keys that category created are deleted, not only blocked from loading again.
- **Public JavaScript API.** Other code (themes, other plugins) can read consent state, wait for
  changes, and open the preference dialog.
- **Embed placeholders.** Embedded media (video, social posts, maps) render a placeholder until the
  matching category is allowed. No request leaves the browser for the embed before consent.
- **Hidden banner on policy pages.** The privacy and cookie policy pages can show their text without
  the banner covering them.
- **Same-origin protection on state-changing public routes.** The consent save endpoint rejects
  requests from other origins.
- **Input validation for third-party script URLs.** Only safe, well-formed URLs can be loaded for
  visitors.
- **Rate limiting on the public save endpoint.** Limits abuse of the public route.
- **Consent record export for administrators.** CSV export, with spreadsheet formula injection
  prevented.
- **Analytics presets.** Common analytics providers can be selected by name, with their script and
  cookie details filled in.
- **Locale coverage and banner position options.**
- **Consent Mode defaults** for Google and Microsoft tags.

Design constraints for these features:

- Do not cap the number of stored consent records. A cap that stops recording when full leaves
  consent without proof, which is a compliance risk. If storage needs bounding, use retention
  (deletion of records older than N months), not a hard stop.
- Keep consent logging on whenever the plugin is enabled. Do not make it an opt-in setting.

---

## 4. Gap matrix

Columns: what we should use, what we build, effort.

| # | Feature | Reuse first | Our build | Effort |
| - | --- | --- | --- | --- |
| G1 | Cookie cleanup on withdrawal | c15t `clearOnRevocation` (built in) | Config with analytics and marketing cookie lists | Tiny |
| G2 | Public JS API and change events | c15t `window.c15t`: `has()`, `subscribe()`, `on('consent')`, `c15t:*` events | Document it; optional alias | Tiny |
| G3 | Hide banner on policy pages | None | Check `event.page.path` in `page:fragments` | Tiny |
| G4 | Same-origin check on POST | None (Astro `checkOrigin` does not cover JSON bodies) | Small function in `runtime.ts` | Tiny |
| G5 | Script URL validation | None | https-only and optional host allowlist in `buildScripts` | Small |
| G6 | Embed placeholders | `@emdash-cms/plugin-embeds` (block types), c15t iframe gating (`data-src`/`data-category`) or c15t Astro `ConsentGate` pattern | Placeholder wrapper registered via `componentsEntry` | Medium |
| G7 | Rate limiting | Cloudflare Rate Limiting binding | Binding call in `save`, with a fallback | Small |
| G8 | Consent record export | None needed; D1 storage has no cap | Paginated admin export with CSV escaping | Small to medium |
| G9 | Analytics presets | `@c15t/integrations` helpers, or per-vendor c15t guides | Preset map (id → URL and category) | Small |
| G10 | Locales | c15t `@c15t/translations/all` (about 35 locales) | Config; fix `resolveLanguage` | Tiny |
| G11 | Consent Mode defaults (Google, Microsoft) | c15t Google Consent Mode and Microsoft guides | Config only | Small |
| G12 | Banner position | c15t `presentation.prompt` (floating corners, bar top or bottom) | Expose as a setting | Tiny |

---

## 5. Detailed notes per gap

### G1. Cookie cleanup on withdrawal (Tiny)

c15t provides `clearOnRevocation`. It deletes first-party cookies, localStorage keys and
sessionStorage keys when a category is denied. Names can be exact or a prefix ending in `*`. Keys
must match c15t category names, which are `measurement` and `marketing` here, not our `analytics`.

Sketch, added to the init config in `src/client/banner.ts`:

```ts
clearOnRevocation: {
  measurement: {
    cookies: ["_ga", "_ga_*"], // review the full list for each analytics preset
    localStorage: [],
  },
  marketing: {
    cookies: [], // fill from the marketing presets
  },
},
```

Notes:

- The c15t docs show this option on `init()` or `createConsentRuntime`. Our banner uses the offline
  factory with a custom transport. The option should still apply, but this is unverified.
- Cookie names change over time. Keep the lists in one reviewed constant with a review date.

Verify: in a production build, accept measurement, set a test cookie with the analytics name, reject,
reload, and confirm the cookie is gone.

### G2. Public JS API (Tiny)

c15t already exposes `window.c15t` with `has(category)`, `getSnapshot()`, `subscribe(listener)`,
`on('consent', fn)`, and `c15t:*` DOM events. Other plugins and themes can gate their own code with
these. Document the names in the README. If a shorter alias is wanted, add
`window.emdashPrivacy = window.c15t` in the bundle entry.

### G3. Hide banner on policy pages (Tiny)

Check the page path against the configured policy paths and skip the banner there. In
`page:fragments`:

```ts
const policyPaths = [s.privacyUrl, s.cookieUrl, s.imprintUrl]
  .filter((u): u is string => typeof u === "string" && u.startsWith("/"));
if (policyPaths.includes(event.page?.path)) return null;
```

Decide whether to still inject the config (so the reopen button works) or return nothing. The
recommended behaviour is to hide the banner only and keep the reopen control and other scripts.
Document the choice.

Unverified: whether `event.page.path` is present in our `page:fragments` event type. Confirm against
the EmDash types before relying on it.

### G4. Same-origin check on POST (Tiny)

Astro's `security.checkOrigin` only applies to form content types. The `save` route takes JSON, so
it is not covered. Astro also had a CSRF bypass advisory (GHSA-c4pw-33h3-35xw) involving
content-type parameters. Do not rely on it for this route.

Sketch for `save` in `src/runtime.ts`:

```ts
function sameOriginRequest(request: Request, siteUrl: string): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return origin === new URL(siteUrl).origin;
    } catch {
      return false;
    }
  }
  return request.headers.get("sec-fetch-site")?.toLowerCase() === "same-origin";
}
```

Reject with 403 when the function returns false. Browsers send `Origin` on POST, so the c15t
transport should pass. Verify with a cross-origin `curl -H "Origin: https://evil.example"` (expect
403) and a same-origin request (expect 200).

### G5. Script URL validation (Small)

Currently `buildScripts()` accepts any string as `src`. The input is admin-only, so the risk is
limited, but a typo or a value copied from an untrusted page could load arbitrary code for every
visitor.

Plan:

- Require `https:`. Reject URLs with credentials, private or literal-IP hosts, and non-standard ports.
- Optional host allowlist setting (`scriptHostAllowlist`).
- Optional `integrity` (SRI) per script, only when the vendor publishes a hash.

Put the check in `buildScripts()` and in the admin save path, so invalid entries are rejected with a
visible error and not silently dropped.

### G6. Embed placeholders (Medium)

This is the largest item. Two parts:

1. **Block types.** `@emdash-cms/plugin-embeds` 0.1.59 provides the EmDash block types (YouTube,
   Vimeo, Twitter, Bluesky, Mastodon, Gist, link preview). Its peers are `emdash >=0.15.0` and
   `astro >=6.0.0-beta.0`. Our installed EmDash is 1.2.0. Our Astro version and the package's
   compatibility are unverified.
2. **Gating.** Two options:
   - c15t iframe gating: render `<iframe data-src="…" data-category="marketing">`. c15t moves `data-src`
     to `src` after consent and removes it on withdrawal (`frameworks/html/embeds.md`).
   - c15t Astro helper: the YouTube and Google Maps guides show an Astro component using
     `getConsentClient` from `c15t/astro/client`.

Recommended design:

- Export a `blockComponents` map from `emdash-privacy/astro`. Each entry wraps the matching
  `@emdash-cms/plugin-embeds` component. If the category is allowed, it renders the real embed. If
  not, it renders a placeholder with a button that opens the preference dialog.
- Validate the block payload before rendering: strict ID patterns per provider, and URLs built by the
  plugin from an allowlist, never passed through from the content. Check whether `astro-embed-*`
  already validates IDs, to avoid duplicate work.
- Document the registration order. Plugins registered later win, and Columns and Cover blocks need the
  wrapper registered after `@emdash-cms/plugin-embeds`.

Open questions:

- Does `@emdash-cms/plugin-embeds` export components we can wrap, or only blocks? Unverified.
- Should the plugin depend on `@emdash-cms/plugin-embeds`, or only document it as optional? Keep it
  optional, since many sites have no embeds.

Verify: a page with a YouTube block shows the placeholder before consent. No request goes to
youtube.com before consent (check the network tab). After allowing measurement, the iframe loads.

### G7. Rate limiting (Small, with a decision)

Cloudflare's Rate Limiting binding is the native choice. From the Workers docs: limits are
approximate and apply separately in each Cloudflare location. For strict limits, the docs point to a
Durable Object. Weighted requests are also supported.

Sketch (exact wrangler syntax and the `limit()` return shape need checking against the current docs):

```ts
import { env } from "cloudflare:workers";
const { success } = await env.CONSENT_SAVE.limit({ key: ipHash });
if (!success) return new Response("rate_limited", { status: 429 });
```

Decisions:

- **Key.** A rate limiter needs a key. The obvious key is the client IP. The README currently says the
  plugin never reads the IP. Either store only a short-lived hash used for counting (and update the
  README to say so), or use a key that does not need the IP. An unkeyed global limit is weak. Pick one.
- **Platform.** The binding exists only on Workers. On Node or other adapters there is no
  `cloudflare:workers` env. Fall back to no limit and say so in the README.
- **Fallback.** If the binding is missing, log once and allow the request. Do not fail the consent
  save.

Keep the README's Cloudflare WAF rule as a documented option for sites that prefer WAF rules.

### G8. Consent record export (Small to medium)

Do not cap the export or the stored history. D1 storage can hold the full history, and the retention
purge removes old rows.

Plan:

- Admin-only route `GET /_emdash/api/plugins/emdash-privacy/consent-export`. Require the same
  permission the settings page uses.
- Cursor pagination through the storage query, streamed as CSV. Avoid loading everything in memory.
- Columns: `createdAt`, `policyVersion`, `bannerVersion`, `action`, `necessary`, `measurement`,
  `marketing`, and `subjectId`. Do not add IP or user agent.
- Response headers: `Content-Type: text/csv; charset=utf-8`,
  `Content-Disposition: attachment; filename="consent-export.csv"`, `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff`.
- Escape cells that begin with `=`, `+`, `-`, `@`, tab or carriage return by prefixing `'`. Quote every
  cell and double any embedded quotes.

Sketch:

```ts
function csvCell(value: string): string {
  let s = value.replace(/\r\n|\n|\r/g, " ");
  if (/^[\t\r ]*[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
```

Keep a CSV library out unless it adds something we need. Confirm its formula handling before relying on
it, because most CSV writers do not escape formula-like cells by default.

### G9. Analytics presets (Small)

c15t has integration guides for many common analytics and ad vendors (Plausible, Umami, Cloudflare Web
Analytics, Google Tag Manager, Google Tag, Microsoft Clarity, Microsoft UET, Fathom, Matomo, Hotjar,
PostHog, Meta Pixel and others). The helpers live in `@c15t/integrations`, a separate package. The
framework-specific helpers may not fit a plain Astro page, so check the Astro and JavaScript guides
first.

Plan:

- Start with a preset map: `{ id, label, category, scriptUrl, cookies }`. This needs no new dependency.
- Consider `@c15t/integrations` only for vendors where its helper handles consent mode setup correctly.
- Each preset ships its cookie names for G1.

### G10. Locales (Tiny)

`@c15t/translations/all` bundles about 35 languages. Importing it adds bundle weight, so measure the
size change before enabling it. Options:

- Import all languages (simplest, larger bundle).
- Import only the languages the admin chooses (needs a build per language set, or dynamic import).
- Keep de/en and document how to add more.

Decide after measuring. Fix `resolveLanguage()` in `src/shared.ts` as part of this item, so non-English
sites stop getting German copy.

### G11. Consent Mode defaults (Small)

c15t's Google Consent Mode bridge is already partly used (see the bridge in `src/client/banner.ts`).
Confirm it sets `default` to denied before any choice, and `update` after a choice, as the README
claims. For Microsoft Clarity and UET, check the c15t Microsoft guides before writing our own defaults.

### G12. Banner position (Tiny)

c15t `presentation.prompt` supports floating corners, `bottom-center`, `top-center`, and bar at top or
bottom. Expose it as a setting in the admin page, with the current default kept.

---

## 6. Implementation order

Phase 1, low risk, one day or less:

1. G1 `clearOnRevocation` with reviewed cookie lists.
2. G4 same-origin check on `save`.
3. G3 hide banner on policy pages.
4. G12 banner position setting.
5. G2 document the public JS API in the README.

Phase 2, input safety and correctness:

6. G5 https and optional allowlist for services, with clear admin errors.
7. G10 fix the `resolveLanguage` fallback. Decide on locale import after a size check.

Phase 3, data and abuse controls:

8. G8 paginated, escaped CSV export.
9. G7 rate limiting, after the IP-versus-README decision.

Phase 4, EmDash-specific features:

10. G9 preset map.
11. G6 embed placeholders, after confirming the `@emdash-cms/plugin-embeds` API.

Phase 4 is last because it adds the most surface area and depends on unverified package details.

---

## 7. Decisions needed from the owner

1. **IP and rate limiting.** Either allow a short-lived IP hash for rate limiting and update the README,
   or skip IP-based limits and rely on the Cloudflare WAF rule only.
2. **Locales.** Bundle all about 35 languages (bigger file) or keep de/en with a documented way to add
   more.
3. **Embed dependency.** Depend on `@emdash-cms/plugin-embeds`, or only document it as an optional
   companion.
4. **c15t version.** Installed 3.0.0. npm has 3.2.2. Check the changelog before upgrading, then re-run
   the verification steps in this plan.
5. **Retention.** The cron hook is unreliable according to our README. Keep the lazy purge in `save`
   and accept that retention depends on traffic, or add a platform scheduled job.

---

## 8. Verification plan

Per item, the minimum checks:

- G1: cookie removed after withdrawal in a production build.
- G3: banner absent on the policy path, present elsewhere.
- G4: cross-origin POST returns 403, same-origin returns 200.
- G5: `http://`, credentials, and private hosts are rejected.
- G6: no request to the embed host before consent; iframe loads after consent.
- G7: the request after the limit inside the window returns 429.
- G8: export of 10,000 rows completes without loading all rows into memory; escaped cells checked.

Regression coverage: add a small self-check script (for example `src/*.selfcheck.ts`, following the
existing `rule.selfcheck.ts` pattern) for the pure functions: `sameOriginRequest`, `csvCell`, the https
validator, and the preset map. Do not add a test framework for this.

---

## 9. What is not verified

- Whether `@emdash-cms/plugin-embeds` exports wrappable components, and its compatibility with our
  Astro version.
- Whether `astro-embed-*` validates embed IDs.
- Whether `clearOnRevocation` works through our offline factory and custom transport.
- Whether `event.page.path` is present in our `page:fragments` event type.
- The exact Cloudflare Rate Limiting wrangler syntax and `limit()` return shape.
- Bundle-size impact of importing all c15t locales.

---

## 10. Implementation status (2026-11-23)

Branch `feat/consent-gap-plan`. Verified: `tsc --noEmit`, `scripts/selfcheck.sh` (rule and guards checks),
`npm run build:client`, and a browser run of the real bundle in headless Chromium against a harness page.
The harness checked: no vendor request before consent, Accept loads the gated vendors, Reject loads none and
persists across reload, and the policy-page mode hides the banner but keeps the reopen button. The harness
could not exercise the EmDash side (save route, CSV route, admin page) or the Astro embed component.

| Gap | Status | Notes |
| --- | --- | --- |
| G1 clearOnRevocation | Done | Preset default cookies plus per-entry `cookies`. Defaults come from the c15t examples. |
| G2 public JS API | Done, corrected | `window.c15t` is c15t's debug object, not the API. The client is at `window.emdashPrivacy`, and its documented methods (`has`, `subscribe`, `on`, `openDialog`) are in the README. |
| G3 hide banner on policy pages | Done | Uses `ui.banner: false` (c15t option). The reopen trigger stays with `showWhen: always`. `event.page.path` is confirmed in the EmDash types. |
| G4 same-origin on save | Done | Origin, then Sec-Fetch-Site. Refusal is a `PluginRouteError.forbidden`, which EmDash turns into 403 (checked in the runtime). |
| G5 script URL validation | Done | https only, no credentials, public hostname, default port, and an optional allowed-host list. Invalid entries block the admin save. |
| G6 embed placeholders | Partial | `emdash-privacy/embed` (ConsentEmbed.astro) gates YouTube and Vimeo with c15t's iframe blocker. Wiring into EmDash's `@emdash-cms/plugin-embeds` blocks is not done, because that API is unverified. Not browser-tested. |
| G7 rate limiting | Not in code, by design | The plugin context has no Worker bindings, so the Cloudflare binding cannot be reached from a standard plugin. The README gives a Cloudflare rate-limiting rule instead. |
| G8 CSV export | Done | Private raw route with cursor paging, built in memory (plugin responses cannot stream). Formula-injection escaping. Not run against a live EmDash. |
| G9 analytics presets | Done, partial | Ten presets from `@c15t/integrations`. Microsoft UET is left out: its helper sets `alwaysLoad`, so it contacts Microsoft before consent. |
| G10 locales | Decided differently | Bundled: de and en (about 11 KB). `@c15t/translations/all` costs about 285 KB, so each language is opt-in. Unbundled languages fall back to German, which is the README's documented rule. The old "bug" was that rule itself, and the code and README agree on it. |
| G11 Consent Mode defaults | Done via c15t | Google tag and GTM presets use `loadMode: 'after-consent'`, so the helper sends the defaults. The old hand-written bridge is removed. Microsoft UET is excluded (see G9). |
| G12 banner position | Done | Eight positions, mapped to `presentation.prompt`. The wall stays centred. |

Also fixed while here:
- Legal links used `privacy`, `cookies` and `terms` keys, which c15t ignores. Links now use `privacyPolicy`, `cookiePolicy` and `termsOfService`.
- `scrollLock` (deprecated) is replaced by `presentation.prompt.blocking`.
- The inline config JSON was not escaped for `<script>`, so an admin-entered name containing `</script>` could break out. It is now escaped.
- A dead `event.page.cspNonce` read is removed. EmDash's page context has no nonce.
- The `./sandbox` export pointed at a file that does not exist, and is removed.

Open items:
- Cosmetic: c15t renders the three legal links with no separator ("DatenschutzerklärungCookie-RichtlinieImpressum" in the harness). A CSS tweak would fix it, but the markup is inside c15t's shadow root, so it needs a stable selector first.
- `zod` is a devDependency but is imported at runtime. This predates this work and should be a dependency or peer.
- `npm audit` reports vulnerabilities in the dependency tree. Not reviewed.
- c15t stays pinned at 3.0.0. 3.2.2 exists but has not been reviewed.
- Retention still depends on traffic (lazy purge in `/save`), since the cron hook was unreliable on the tested host.

---

## 11. Deep review and hardening (0.2.0)

A deep review of 0.1.0 found the items below. Each was reproduced first (tests in `tests/review.test.ts` and the
browser suite), then fixed. Section 10 describes the first implementation. This section supersedes it where they differ.

| Finding | Status | Where |
| --- | --- | --- |
| Client-set timestamp could backdate or forward-date a proof | Fixed: server clock | `save` in `src/runtime.ts` |
| Lazy purge deleted 100 rows a run, not 200 (EmDash caps pages at 100) | Fixed: paged, bounded | `src/purge.ts` |
| No third-party license notices in the package | Fixed | `THIRD_PARTY_LICENSES.md` |
| Peer range `>=0.30.0` was never tested | Fixed: `>=1.2.0`, CI runs 1.2.0 and 1.6.0 | `package.json`, `ci.yml` |
| Cached bundle ran without a check, and old versions were kept forever | Fixed: hash-verified, stale keys removed | loader in `src/runtime.ts` |
| Embed-only sites loaded no client, so placeholders did nothing | Fixed: c15t starts with the banner hidden | `page:fragments` |
| One storage query per setting on every render | Fixed: one `settings.list()` | `src/settings.ts` |
| Unbounded inputs (empty subject, 40 000 grant keys, retention 100 000, retention 0 silently 36) | Fixed: bounds, errors not defaults | `save` route, admin `save` |
| Dead headers on the CSV route, and a comment that credited the wrong source | Fixed | export route, test comments |
| `any` in route handlers; unused exports; duplicate settings editor | Fixed: `RouteContext`, unexported; `settingsSchema` removed | `src/context.ts`, `src/index.ts` |
| Dev dependencies with known advisories | Fixed; production audit is clean | `package.json` |

**Decisions**

- The browser-set `givenAt` is accepted and ignored, so bundles from 0.1.x keep validating.
- The `settingsSchema` form is removed. The Block Kit page is the only editor, and it validates the whole form.
- A save while disabled returns `ok` without storing. An error would make c15t retry forever.
- The CSV export needs an admin API token (section 10 described the option chosen). A browser download without a token is refused.

**Still open**

- The host's edge cache (`emdash-multisite/src/edge-cache.ts`) purges on admin writes from a fixed list. Our settings
  save is not on it, so a settings change can stay stale for up to an hour. This needs a change in that repo.
- A retention backlog larger than 2 000 rows (per visit-day) takes several days to clear. The cron path is unreliable on
  the tested host.
- The default fallback language is German. That is the right baseline for the target market, not for every site.
