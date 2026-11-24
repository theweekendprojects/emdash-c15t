/**
 * Self-check for the pure logic added with the gap plan: service validation and
 * clear-on-revocation, same-origin and output escaping, CSV, layout and policy pages,
 * language choice and embed URLs. Run via `bash scripts/selfcheck.sh`. Plain asserts.
 */
import assert from "node:assert/strict";
import { PRESET_IDS, buildClearOnRevocation, checkScriptUrl, parseAllowedHosts, parseServices, validCookieName } from "./services.js";
import { isSameOriginRequest, safeInlineJson } from "./security.js";
import { consentCsvLine, csvCell, csvHeaderLine } from "./export.js";
import { isPolicyPage, promptFor, triggerPosition } from "./presentation.js";
import { languageCandidate, isLanguageSetting, pickLocale } from "./locale.js";
import { embedUrl } from "./embed-url.js";
import { PACKAGE_NAME, PLUGIN_ID } from "./shared.js";
import { parseExportRange, parseInstant, rangeWhere } from "./export-range.js";
import { siteIdFrom } from "./site-id.js";
import { readFileSync } from "node:fs";

const ok = (raw: unknown, hosts: string[] = []) => {
	const r = parseServices(raw, hosts);
	assert.deepEqual(r.errors, [], `expected no errors, got ${r.errors.join(" | ")}`);
	return r.services;
};
const bad = (raw: unknown, needle: string, hosts: string[] = []) => {
	const r = parseServices(raw, hosts);
	assert.ok(r.errors.some((e) => e.includes(needle)), `expected error containing "${needle}", got: ${JSON.stringify(r.errors)}`);
	return r;
};

// --- services: presets ---
assert.ok(PRESET_IDS.includes("google-tag") && PRESET_IDS.includes("meta-pixel"), "known presets present");

const [ga] = ok(`[{"id":"ga4","name":"Google Analytics","category":"analytics","preset":"google-tag","options":{"id":"G-ABCD1234"}}]`);
assert.equal(ga!.preset, "google-tag");
assert.deepEqual(ga!.options, { id: "G-ABCD1234" });
assert.deepEqual(ga!.cookies, ["_ga", "_ga_*"], "preset default cookies apply when none are listed");

bad(`[{"id":"x","category":"analytics","preset":"nope","options":{}}]`, "unknown preset");
bad(`[{"id":"x","category":"analytics","preset":"meta-pixel","options":{"pixelId":"123456789012345"}}]`, "is a marketing vendor");
bad(`[{"id":"x","category":"marketing","preset":"plausible-analytics","options":{"scriptId":"example.com"}}]`, "is a analytics vendor");
bad(`[{"id":"x","category":"analytics","preset":"google-tag","options":{}}]`, 'option "id" is required');
bad(`[{"id":"x","category":"analytics","preset":"google-tag","options":{"id":"G-AB12","extra":"1"}}]`, 'unknown option "extra"');
bad(`[{"id":"x","category":"analytics","preset":"google-tag","options":{"id":"<script>"}}]`, "invalid value");
bad(`[{"id":"x","category":"analytics","preset":"google-tag","src":"https://a.example.com/x.js","options":{"id":"G-AB12"}}]`, "not both");

// a pasted gtag.js URL is upgraded to the google-tag preset (Consent Mode set up correctly)
const [up] = ok(`[{"id":"ga","category":"analytics","src":"https://www.googletagmanager.com/gtag/js?id=G-ABCD1234"}]`);
assert.equal(up!.preset, "google-tag", "gtag src upgraded to preset");
assert.equal(up!.options!.id, "G-ABCD1234");

// --- services: custom src ---
const [custom] = ok(`[{"id":"c","category":"marketing","src":"https://cdn.example.com/pixel.js"}]`);
assert.equal(custom!.src, "https://cdn.example.com/pixel.js");
assert.deepEqual(custom!.cookies, [], "custom scripts have no default cookies");

// --- services: shape errors keep the valid entries ---
const mixed = parseServices(
	`[{"id":"good","category":"analytics","src":"https://cdn.example.com/a.js"},{"id":"bad id!","category":"analytics","src":"https://cdn.example.com/b.js"}]`,
);
assert.equal(mixed.services.length, 1, "valid entry kept");
assert.equal(mixed.errors.length, 1, "invalid entry reported");
bad(`{"not":"an array"}`, "must be a JSON array");
bad(`[not json`, "not valid JSON");
bad(`["string"]`, "must be an object");
bad(`[{"id":"x","category":"analytics","src":"https://a.example.com/a.js","typo":1}]`, 'unknown field "typo"');
bad(`[{"id":"x","category":"sometimes","src":"https://a.example.com/a.js"}]`, 'category must be');
bad(`[{"id":"a","category":"analytics","src":"https://a.example.com/a.js"},{"id":"a","category":"analytics","src":"https://a.example.com/b.js"}]`, "duplicate id");
bad(`[{"id":"x","category":"analytics"}]`, "needs a preset or an https src");
assert.deepEqual(parseServices("").services, [], "empty setting = no services, no error");
assert.deepEqual(parseServices("  ").errors, [], "whitespace setting = no services, no error");

// provider and purpose are kept for the public services route (Datenschutz text)
const [info] = ok(`[{"id":"i","category":"analytics","provider":"Example Inc.","purpose":"Reach","src":"https://a.example.com/a.js"}]`);
assert.equal(info!.provider, "Example Inc.");
assert.equal(info!.purpose, "Reach");

// --- services: cookies ---
const [own] = ok(`[{"id":"ga","category":"analytics","preset":"google-tag","options":{"id":"G-AB12CD34"},"cookies":[]}]`);
assert.deepEqual(own!.cookies, [], "explicit empty cookies replaces the preset default");
bad(`[{"id":"x","category":"analytics","src":"https://a.example.com/a.js","cookies":["a*b"]}]`, "not valid");
bad(`[{"id":"x","category":"analytics","src":"https://a.example.com/a.js","cookies":["*"]}]`, "not valid");
bad(`[{"id":"x","category":"analytics","src":"https://a.example.com/a.js","cookies":"_ga"}]`, "list of names");
assert.equal(validCookieName("_ga"), true);
assert.equal(validCookieName("_ga_*"), true);
assert.equal(validCookieName("_ga*x"), false, "* only at the end");
assert.equal(validCookieName("*"), false, "a bare * is not allowed");
assert.equal(validCookieName("a b"), false, "no spaces");

// clear-on-revocation: merged per c15t category
const cor = buildClearOnRevocation(
	parseServices(
		`[{"id":"a","category":"analytics","preset":"google-tag","options":{"id":"G-AB12CD34"}},` +
			`{"id":"b","category":"analytics","src":"https://x.example.com/a.js","cookies":["_ga","_x"]},` +
			`{"id":"c","category":"marketing","preset":"meta-pixel","options":{"pixelId":"123456789012345"}}]`,
	).services,
);
assert.deepEqual(cor.measurement, { cookies: ["_ga", "_ga_*", "_x"] }, "analytics cookies merged, de-duplicated");
assert.deepEqual(cor.marketing, { cookies: ["_fbp"] }, "marketing cookies under marketing");
assert.deepEqual(buildClearOnRevocation([]), {}, "no services -> no clear config");

// --- script URLs ---
assert.equal(checkScriptUrl("https://cdn.example.com/a.js"), null, "plain https ok");
assert.match(checkScriptUrl("http://cdn.example.com/a.js") ?? "", /https/, "http rejected");
assert.match(checkScriptUrl("https://user:pw@cdn.example.com/a.js") ?? "", /credentials/, "credentials rejected");
assert.match(checkScriptUrl("https://cdn.example.com:8443/a.js") ?? "", /port/, "non-443 port rejected");
assert.match(checkScriptUrl("https://127.0.0.1/a.js") ?? "", /IP address/, "IPv4 literal rejected");
assert.match(checkScriptUrl("https://10.0.0.5/a.js") ?? "", /IP address/, "private IPv4 rejected");
assert.match(checkScriptUrl("https://[::1]/a.js") ?? "", /IP address/, "IPv6 literal rejected");
assert.match(checkScriptUrl("https://localhost/a.js") ?? "", /fully qualified/, "localhost rejected (no dot)");
assert.match(checkScriptUrl("https://printer.internal/a.js") ?? "", /public hostname/, ".internal rejected");
assert.match(checkScriptUrl("not a url") ?? "", /valid URL/, "garbage rejected");
assert.equal(checkScriptUrl("https://cdn.example.com/a.js", ["example.com"]), null, "allowed host ok");
assert.equal(checkScriptUrl("https://x.cdn.example.com/a.js", ["example.com"]), null, "subdomain of allowed host ok");
assert.match(checkScriptUrl("https://evil-example.com/a.js", ["example.com"]) ?? "", /not in the allowed/, "suffix lookalike rejected");
assert.match(checkScriptUrl("https://other.org/a.js", ["example.com"]) ?? "", /not in the allowed/, "other host rejected");
bad(`[{"id":"x","category":"analytics","src":"https://other.org/a.js"}]`, "not in the allowed", ["example.com"]);

const hosts = parseAllowedHosts("Example.com, cdn.example.org");
assert.deepEqual(hosts, { hosts: ["example.com", "cdn.example.org"], error: null });
assert.match(parseAllowedHosts("localhost").error ?? "", /plain domain/, "bare host rejected");
assert.match(parseAllowedHosts("https://example.com").error ?? "", /plain domain/, "URLs rejected, hosts only");
assert.deepEqual(parseAllowedHosts("").hosts, [], "empty = no restriction");

// --- same-origin ---
const SITE = "https://hostmyemdash.example";
const REQ = `${SITE}/_emdash/api/plugins/emdash-privacy/save`;
assert.equal(isSameOriginRequest({ origin: SITE }, REQ, SITE), true, "same origin allowed");
assert.equal(isSameOriginRequest({ Origin: SITE }, REQ, SITE), true, "header name is case-insensitive");
assert.equal(isSameOriginRequest({ origin: "https://evil.example" }, REQ, SITE), false, "cross-origin refused");
assert.equal(isSameOriginRequest({ origin: "null" }, REQ, SITE), false, "opaque origin refused");
assert.equal(isSameOriginRequest({ origin: "http://hostmyemdash.example" }, REQ, SITE), false, "scheme mismatch refused");
assert.equal(isSameOriginRequest({ origin: "https://other.example" }, REQ, "https://other.example"), true, "site URL origin also allowed");
assert.equal(isSameOriginRequest({ "sec-fetch-site": "same-origin" }, REQ, SITE), true, "no Origin, Sec-Fetch-Site same-origin ok");
assert.equal(isSameOriginRequest({ "sec-fetch-site": "cross-site" }, REQ, SITE), false, "cross-site refused");
assert.equal(isSameOriginRequest({ "sec-fetch-site": "none" }, REQ, SITE), false, "typed navigation (none) refused for a POST");
assert.equal(isSameOriginRequest({}, REQ, SITE), false, "no origin info refused");
assert.equal(isSameOriginRequest({ origin: SITE }, "not a url", undefined), false, "garbage request url does not crash");

// a trusted plugin route gets a real Request: headers is a Headers object, not a record
const real = (h: Record<string, string>) => new Request(REQ, { method: "POST", headers: h });
assert.equal(isSameOriginRequest(real({ origin: SITE }).headers, REQ, SITE), true, "Headers: same origin allowed");
assert.equal(isSameOriginRequest(real({ origin: "https://evil.example" }).headers, REQ, SITE), false, "Headers: cross-origin refused");
assert.equal(isSameOriginRequest(real({ "sec-fetch-site": "same-origin" }).headers, REQ, SITE), true, "Headers: Sec-Fetch-Site same-origin ok");
assert.equal(isSameOriginRequest(real({}).headers, REQ, SITE), false, "Headers: no origin info refused");

// --- package identity: EmDash resolves the descriptor entrypoint by the package name ---
// the bundle runs from a temp dir, so the repo root comes from the environment (set by selfcheck.sh)
const root = process.env.PLUGIN_ROOT ?? process.cwd();
const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as { name: string; plugin?: { id?: string } };
assert.equal(PACKAGE_NAME, pkg.name, "PACKAGE_NAME must equal package.json name");
assert.equal(PLUGIN_ID, pkg.plugin?.id, "plugin id must equal package.json plugin.id");

// --- inline JSON cannot close the <script> tag ---
const json = safeInlineJson({ name: "</script><img src=x onerror=alert(1)>", x: "\u2028" });
assert.ok(!json.includes("</script"), "no literal </script in output");
assert.ok(!json.includes("<"), "no literal < at all");
assert.deepEqual(JSON.parse(json), { name: "</script><img src=x onerror=alert(1)>", x: "\u2028" }, "still round-trips");

// --- CSV ---
assert.equal(csvCell("plain"), '"plain"');
assert.equal(csvCell('say "hi"'), '"say ""hi"""', "embedded quotes doubled");
assert.equal(csvCell("a\nb\r\nc"), '"a b c"', "line breaks flattened");
assert.equal(csvCell(null), '""', "null is empty");
for (const f of ["=HYPERLINK(1)", "+1", "-2", "@SUM", "\t=x", "  =x", "\r=x"]) {
	assert.ok(csvCell(f).startsWith(`"'`), `formula-like "${JSON.stringify(f)}" is prefixed`);
}
assert.equal(csvCell("normal text"), '"normal text"', "no prefix for normal text");
assert.equal(csvHeaderLine(), '"createdAt","policyVersion","bannerVersion","action","necessary","measurement","marketing","subjectId","siteId"');

const line = consentCsvLine({
	ts: Date.UTC(2026, 10, 23, 12, 0, 0),
	policyVersion: "3",
	bannerVersion: "2",
	action: "custom",
	grants: { necessary: true, measurement: true, marketing: false },
	subjectId: "abc",
	siteId: "a.example",
});
assert.equal(line, '"2026-11-23T12:00:00.000Z","3","2","custom","true","true","false","abc","a.example"');
assert.ok(consentCsvLine({ ts: 0, policyVersion: "1", bannerVersion: "1", action: "all", grants: {}, subjectId: "s" }).endsWith(',""'), "a record without siteId exports an empty cell");
assert.ok(consentCsvLine({ ts: 0, policyVersion: "1", bannerVersion: "1", action: "all", grants: {}, subjectId: "s", siteId: "=cmd" }).endsWith(`,"'=cmd"`), "siteId is escaped like every other cell");
assert.equal(consentCsvLine({ ts: Number.NaN, policyVersion: "1", bannerVersion: "1", action: "all", grants: {}, subjectId: "s" }).startsWith('"",'), true, "bad timestamp -> empty date");
assert.ok(consentCsvLine({ ts: 1e20, policyVersion: "1", bannerVersion: "1", action: "all", grants: {}, subjectId: "s" }).startsWith('"",'), "out-of-range timestamp does not throw");
assert.ok(consentCsvLine({ ts: 0, policyVersion: "1", bannerVersion: "1", action: "all", grants: {}, subjectId: "s" }).includes('"false","false","false"'), "missing grants are false");

// --- layout ---
assert.deepEqual(
	{ v: promptFor("bottom-left", false).variant, p: promptFor("bottom-left", false).position },
	{ v: "floating", p: "bottom-left" },
	"default is a floating card, bottom-left",
);
assert.equal(promptFor("top-center", false).position, "top-center", "floating top-center");
assert.deepEqual(
	[promptFor("bar-bottom", false).variant, promptFor("bar-bottom", false).position],
	["bar", "bottom"],
	"bar-bottom",
);
assert.deepEqual([promptFor("bar-top", false).variant, promptFor("bar-top", false).position], ["bar", "top"], "bar-top");
assert.equal(promptFor("nonsense", false).position, "bottom-left", "unknown position falls back to bottom-left");
assert.equal(promptFor("top-left", true).variant, "wall", "requireChoice always gives the wall");
assert.equal(promptFor("top-left", true).position, "center", "the wall is centred");
assert.equal(promptFor("top-left", true).blocking, true, "the wall blocks");
assert.equal(promptFor("bottom-right", false).blocking, false, "floating does not block");
assert.deepEqual(promptFor("bottom-right", false).primaryActions, ["accept", "reject"], "accept and reject both primary");
assert.equal(triggerPosition("bottom-right"), "bottom-right");
assert.equal(triggerPosition("top-right"), "bottom-right", "right side -> reopen on the right");
assert.equal(triggerPosition("top-center"), "bottom-left");
assert.equal(triggerPosition("bar-bottom"), "bottom-left");

// --- policy pages ---
const POLICY = ["/datenschutz", "https://hostmyemdash.example/cookies/", undefined, ""];
assert.equal(isPolicyPage("/datenschutz", POLICY), true, "relative policy path matches");
assert.equal(isPolicyPage("/datenschutz/", POLICY), true, "trailing slash ignored");
assert.equal(isPolicyPage("/cookies", POLICY), true, "absolute policy URL matched by path");
assert.equal(isPolicyPage("/", POLICY), false, "home is not a policy page");
assert.equal(isPolicyPage("/datenschutz/x", POLICY), false, "sub-path is not the policy page");
assert.equal(isPolicyPage("/x", [undefined, ""]), false, "no configured URLs -> never a policy page");
assert.equal(isPolicyPage("/", ["/"]), true, "root policy page works");
// An absolute policy URL on another host is not this site's page, even when the path is the same.
assert.equal(isPolicyPage("/privacy", ["https://policies.example.com/privacy"], "shop.example"), false, "other host, same path: not a policy page here");
assert.equal(isPolicyPage("/privacy", ["https://shop.example/privacy"], "shop.example"), true, "same host: matches");
assert.equal(isPolicyPage("/privacy", ["https://SHOP.example/privacy"], "shop.example"), true, "host comparison ignores case");
assert.equal(isPolicyPage("/privacy", ["/privacy"], "shop.example"), true, "a relative URL is always this host");
assert.equal(isPolicyPage("/privacy", ["https://shop.example:8443/privacy"], "shop.example"), true, "a port does not change the hostname");
assert.equal(isPolicyPage("/privacy", ["https://www.shop.example/privacy"], "shop.example"), false, "www is a different host");
assert.equal(isPolicyPage("/privacy", ["https://policies.example.com/privacy"]), true, "no host given: path only, as before");

// --- language ---
assert.equal(languageCandidate("auto", "en-GB"), "en", "auto follows the page");
assert.equal(languageCandidate("auto", "pt_BR"), "pt", "underscore separator");
assert.equal(languageCandidate("fr", "de"), "fr", "a concrete setting beats the page");
assert.equal(languageCandidate(undefined, "EN"), "en", "unset = auto, case-insensitive");
assert.equal(languageCandidate("auto", null), null, "no page locale -> no candidate");
assert.equal(languageCandidate("  ", "fr"), "fr", "blank setting = auto");
assert.equal(languageCandidate("auto", "123"), null, "garbage locale rejected");

const SUPPORTED = ["de", "en", "fr"];
assert.equal(pickLocale("fr", SUPPORTED), "fr", "bundled language used");
assert.equal(pickLocale("it", SUPPORTED), "de", "unbundled language falls back to German");
assert.equal(pickLocale(null, SUPPORTED), "de", "no candidate falls back to German");
assert.equal(pickLocale("it", ["en", "fr"], "en"), "en", "custom fallback");
assert.equal(pickLocale("it", ["fr", "nl"], "de"), "fr", "no fallback bundled -> first supported");
assert.equal(isLanguageSetting("auto"), true);
assert.equal(isLanguageSetting("de"), true);
assert.equal(isLanguageSetting("english please"), false, "free text rejected");
assert.equal(isLanguageSetting(""), false, "empty rejected");

// --- embeds ---
assert.equal(embedUrl("youtube", "dQw4w9WgXcQ"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?playsinline=1");
assert.equal(embedUrl("youtube", "short"), null, "youtube ID must be 11 chars");
assert.equal(embedUrl("youtube", 'x" onload="alert(1)'), null, "no attribute injection");
assert.equal(embedUrl("vimeo", "123456789"), "https://player.vimeo.com/video/123456789");
assert.equal(embedUrl("vimeo", "../../evil"), null, "no path traversal");
assert.equal(embedUrl("dailymotion", "x1"), null, "unknown provider rejected");
assert.equal(embedUrl("youtube", undefined), null, "missing ID rejected");

// --- export range ---
assert.equal(parseInstant("2026-01-01"), Date.UTC(2026, 0, 1), "a plain date is midnight UTC");
assert.equal(parseInstant("2026-01-01T12:30:00Z"), Date.UTC(2026, 0, 1, 12, 30), "date-time with Z");
assert.equal(parseInstant("2026-01-01T12:30:00+02:00"), Date.UTC(2026, 0, 1, 10, 30), "offset is applied");
assert.equal(parseInstant("2026-01-01 12:30"), Date.UTC(2026, 0, 1, 12, 30), "space separator, no zone means UTC");
for (const bad of ["not-a-date", "2026-13-45", "2026-02-30", "2026/01/01", "01-01-2026", "", "1795553603272", "tomorrow"]) {
	assert.equal(parseInstant(bad), null, `${JSON.stringify(bad)} is not an instant`);
}
const q = (s: string) => new URLSearchParams(s);
assert.deepEqual(parseExportRange(q("")), {}, "no range = everything");
assert.deepEqual(parseExportRange(q("from=2026-01-01&to=2026-02-01")), { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 1, 1) });
assert.equal(typeof parseExportRange(q("from=junk")), "string", "a bad from is an error, not ignored");
assert.equal(typeof parseExportRange(q("to=2026-13-45")), "string", "an impossible date is an error");
assert.equal(typeof parseExportRange(q("from=2026-02-01&to=2026-01-01")), "string", "from after to is an error");
assert.equal(typeof parseExportRange(q("from=2026-01-01&to=2026-01-01")), "string", "an empty range is an error");
assert.deepEqual(rangeWhere({}), {}, "no range = no filter");
assert.deepEqual(rangeWhere({ from: 5 }), { ts: { gte: 5 } });
assert.deepEqual(rangeWhere({ to: 9 }), { ts: { lt: 9 } });
assert.deepEqual(rangeWhere({ from: 5, to: 9 }), { ts: { gte: 5, lt: 9 } }, "from is inclusive, to is exclusive");

// --- site id ---
assert.equal(siteIdFrom("https://a.example/path", "https://b.example/x"), "a.example", "the site URL wins");
assert.equal(siteIdFrom("", "https://b.example/x"), "b.example", "an empty site URL falls back to the request host");
assert.equal(siteIdFrom(undefined, "https://b.example/x"), "b.example", "a missing site URL falls back too");
assert.equal(siteIdFrom("not a url", "https://b.example/x"), "b.example", "an unparseable site URL falls back");
assert.equal(siteIdFrom("", ""), "unknown", "nothing to go on");
assert.equal(siteIdFrom(undefined, undefined), "unknown");

console.log("guards.selfcheck: OK");
