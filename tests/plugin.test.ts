import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ADMIN,
	rawDb,
	SAME_ORIGIN,
	SITE,
	SUBSCRIBER,
	adminCall,
	call,
	createRuntime,
	exportRows,
	fragmentsFor,
	savePayload,
	type Runtime,
} from "./support/harness.js";

const DAY = 86_400_000;
const services = JSON.stringify([
	{ id: "ga4", name: "Google Analytics", category: "analytics", preset: "google-tag", options: { id: "G-ABCD1234" } },
	{ id: "meta", name: "Meta", category: "marketing", preset: "meta-pixel", options: { pixelId: "123456789012345" } },
]);

/** The admin form defaults, overridable per test. Goes through the real admin route. */
function settingsValues(overrides: Record<string, unknown> = {}) {
	return {
		enabled: true,
		services,
		allowedScriptHosts: "",
		language: "auto",
		colorScheme: "system",
		bannerPosition: "bottom-left",
		accentColor: "",
		requireChoice: false,
		privacyUrl: "/datenschutz",
		imprintUrl: "/impressum",
		cookieUrl: "/cookies",
		policyVersion: "1",
		cookieMaxAgeMonths: 12,
		retentionMonths: 36,
		...overrides,
	};
}

async function saveSettings(runtime: Runtime, overrides: Record<string, unknown> = {}) {
	const res = await adminCall(runtime, {
		type: "form_submit",
		action_id: "save_privacy",
		values: settingsValues(overrides),
	});
	expect(res.status).toBe(200);
	return (await res.json()) as { data: { toast?: { type: string; message: string } } };
}

async function toastOf(res: Response) {
	const body = (await res.json()) as { data?: { toast?: { type: string; message: string } } };
	return body.data?.toast;
}

let runtimes: Runtime[] = [];
let runtime: Runtime;

beforeEach(async () => {
	runtime = await createRuntime();
	runtimes.push(runtime);
	await saveSettings(runtime);
});

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((r) => r.shutdown()));
});

describe("save route", () => {
	it("stores one proof record for a same-origin request, with only the proof fields", async () => {
		const res = await call(runtime, "save", { method: "POST", body: savePayload(), headers: SAME_ORIGIN });
		expect(res.status).toBe(200);
		const rows = await exportRows(runtime);
		expect(rows).toHaveLength(1);
		const [createdAt, policyVersion, bannerVersion, action, necessary, measurement, marketing, subjectId] = rows[0]!;
		expect(createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect({ policyVersion, bannerVersion, action, necessary, measurement, marketing, subjectId }).toEqual({
			policyVersion: "1",
			bannerVersion: "2",
			action: "all",
			necessary: "true",
			measurement: "true",
			marketing: "true",
			subjectId: "sub_test_1",
		});
	});

	it("keeps only the three known grant keys and always records necessary as granted", async () => {
		await call(runtime, "save", {
			method: "POST",
			headers: SAME_ORIGIN,
			body: savePayload({
				action: "custom",
				grants: { necessary: false, measurement: false, marketing: true, functionality: true, experience: true },
			}),
		});
		const [row] = await exportRows(runtime);
		expect(row!.slice(4, 7)).toEqual(["true", "false", "true"]);
	});

	it("refuses a cross-origin POST and stores nothing", async () => {
		const res = await call(runtime, "save", {
			method: "POST",
			body: savePayload(),
			headers: { origin: "https://evil.example" },
		});
		expect(res.status).toBe(403);
		expect(await exportRows(runtime)).toHaveLength(0);
	});

	it("refuses an opaque origin ('null') and a cross-site Sec-Fetch-Site", async () => {
		const opaque = await call(runtime, "save", { method: "POST", body: savePayload(), headers: { origin: "null" } });
		const crossSite = await call(runtime, "save", {
			method: "POST",
			body: savePayload(),
			headers: { "sec-fetch-site": "cross-site" },
		});
		expect([opaque.status, crossSite.status]).toEqual([403, 403]);
	});

	it("refuses a request with no origin information at all", async () => {
		const res = await call(runtime, "save", { method: "POST", body: savePayload() });
		expect(res.status).toBe(403);
	});

	it("accepts Sec-Fetch-Site same-origin when no Origin header is sent", async () => {
		const res = await call(runtime, "save", {
			method: "POST",
			body: savePayload(),
			headers: { "sec-fetch-site": "same-origin" },
		});
		expect(res.status).toBe(200);
	});

	it("rejects a client-supplied siteId (strict schema)", async () => {
		const res = await call(runtime, "save", {
			method: "POST",
			body: savePayload({ siteId: "evil.example" }),
			headers: SAME_ORIGIN,
		});
		expect(res.status).toBe(400);
		expect(await exportRows(runtime)).toHaveLength(0);
	});

	it("rejects an unknown action and a missing required field", async () => {
		const badAction = await call(runtime, "save", {
			method: "POST",
			body: savePayload({ action: "sure" }),
			headers: SAME_ORIGIN,
		});
		const missing = await call(runtime, "save", {
			method: "POST",
			body: { action: "all", grants: {}, policyVersion: "1", bannerVersion: "2" },
			headers: SAME_ORIGIN,
		});
		expect([badAction.status, missing.status]).toEqual([400, 400]);
	});

	it("exports a formula-like subjectId as text, so a spreadsheet will not run it", async () => {
		await call(runtime, "save", {
			method: "POST",
			body: savePayload({ subjectId: "=HYPERLINK(1)" }),
			headers: SAME_ORIGIN,
		});
		const [row] = await exportRows(runtime);
		expect(row![7]).toBe("'=HYPERLINK(1)");
	});
});

describe("services route", () => {
	it("is public and returns the parsed services with name, provider and purpose", async () => {
		await saveSettings(runtime, {
			services: JSON.stringify([
				{ id: "x", name: "X", category: "marketing", provider: "Example Inc.", purpose: "Reach", src: "https://cdn.example.com/x.js" },
			]),
		});
		const res = await call(runtime, "services");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: Array<{ id: string; provider?: string; purpose?: string }> };
		expect(body.data).toEqual([expect.objectContaining({ id: "x", provider: "Example Inc.", purpose: "Reach" })]);
	});

	it("returns the configured presets", async () => {
		const body = (await (await call(runtime, "services")).json()) as { data: Array<{ id: string; preset?: string }> };
		expect(body.data.map((s) => s.preset)).toEqual(["google-tag", "meta-pixel"]);
	});
});

describe("admin route", () => {
	it("refuses a subscriber and an anonymous caller", async () => {
		const sub = await adminCall(runtime, { type: "page_load" }, SUBSCRIBER);
		const anon = await call(runtime, "admin", {
			method: "POST",
			body: { type: "page_load" },
			user: null,
			headers: { "X-EmDash-Request": "1" },
		});
		expect([sub.status, anon.status]).toEqual([403, 401]);
	});

	it("renders CSV export instructions with the absolute export URL and a Bearer example", async () => {
		const res = await adminCall(runtime, { type: "page_load" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { blocks: Array<Record<string, any>> } };
		const text = body.data.blocks.filter((b) => b.type === "context").map((b) => String(b.text)).join("\n");
		expect(text).toContain(`${SITE}/_emdash/api/plugins/emdash-privacy/consent-export`);
		expect(text).toContain('Authorization: Bearer');
		expect(body.data.blocks.some((b) => b.type === "link")).toBe(false);
	});

	it("rejects invalid services and keeps the previous configuration", async () => {
		const before = (await (await call(runtime, "services")).json()) as { data: unknown[] };
		const res = await adminCall(runtime, {
			type: "form_submit",
			action_id: "save_privacy",
			values: settingsValues({ services: '[{"id":"bad id!","category":"analytics","src":"https://a.example.com/a.js"}]' }),
		});
		const toast = await toastOf(res);
		const after = (await (await call(runtime, "services")).json()) as { data: unknown[] };
		expect(toast?.type).toBe("error");
		expect(toast?.message).toContain("id must be");
		expect(after.data).toEqual(before.data);
	});

	it("rejects services that are not valid JSON, and a non-https policy URL", async () => {
		const badJson = await toastOf(
			await adminCall(runtime, { type: "form_submit", action_id: "save_privacy", values: settingsValues({ services: "[oops" }) }),
		);
		const badUrl = await toastOf(
			await adminCall(runtime, {
				type: "form_submit",
				action_id: "save_privacy",
				values: settingsValues({ privacyUrl: "http://insecure.example.com/datenschutz" }),
			}),
		);
		expect(badJson?.message).toMatch(/not valid JSON/);
		expect(badUrl?.message).toMatch(/Privacy URL/);
	});

	it("rejects a free-text language and an unknown banner position", async () => {
		const badLang = await toastOf(
			await adminCall(runtime, { type: "form_submit", action_id: "save_privacy", values: settingsValues({ language: "english please" }) }),
		);
		const badPos = await toastOf(
			await adminCall(runtime, { type: "form_submit", action_id: "save_privacy", values: settingsValues({ bannerPosition: "middle" }) }),
		);
		expect(badLang?.type).toBe("error");
		expect(badPos?.message).toMatch(/Banner position/);
	});

	it("saves valid settings and the public services route reflects them", async () => {
		const toast = await toastOf(
			await adminCall(runtime, {
				type: "form_submit",
				action_id: "save_privacy",
				values: settingsValues({
					services: JSON.stringify([{ id: "h", category: "analytics", preset: "hotjar", options: { siteId: "1234567" } }]),
				}),
			}),
		);
		expect(toast?.type).toBe("success");
		const body = (await (await call(runtime, "services")).json()) as { data: Array<{ id: string }> };
		expect(body.data.map((s) => s.id)).toEqual(["h"]);
	});
});

describe("CSV export", () => {
	it("returns a CSV attachment to an admin", async () => {
		await call(runtime, "save", { method: "POST", body: savePayload(), headers: SAME_ORIGIN });
		const res = await call(runtime, "consent-export", { user: ADMIN, headers: { "X-EmDash-Request": "1" } });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/text\/csv/);
		expect(res.headers.get("content-disposition")).toBe('attachment; filename="consent-export.csv"');
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		// EmDash sets nosniff on raw responses itself (the route sets no security headers). Checked by running the route.
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		const text = await res.text();
		expect(text.split("\r\n")[0]).toBe(
			'"createdAt","policyVersion","bannerVersion","action","necessary","measurement","marketing","subjectId"',
		);
	});

	it("refuses a subscriber and an anonymous caller", async () => {
		const sub = await call(runtime, "consent-export", { user: SUBSCRIBER, headers: { "X-EmDash-Request": "1" } });
		const anon = await call(runtime, "consent-export", { user: null, headers: { "X-EmDash-Request": "1" } });
		expect([sub.status, anon.status]).toEqual([403, 401]);
	});

	it("an API token with the admin scope can download without the CSRF header", async () => {
		await call(runtime, "save", { method: "POST", body: savePayload(), headers: SAME_ORIGIN });
		const res = await call(runtime, "consent-export", { user: ADMIN, tokenScopes: ["admin"] });
		expect(res.status).toBe(200);
		expect((await res.text()).trim().split("\r\n")).toHaveLength(2);
	});

	it("an API token without the admin scope is refused", async () => {
		const res = await call(runtime, "consent-export", { user: ADMIN, tokenScopes: ["content:read"] });
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INSUFFICIENT_SCOPE");
	});

	it("refuses a browser-style download without the CSRF header (EmDash enforces this on private routes)", async () => {
		const res = await call(runtime, "consent-export", { user: ADMIN });
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CSRF_REJECTED");
	});
});

describe("page:fragments (banner injection)", () => {
	function configOf(fragments: Array<{ code?: string; placement?: string }>) {
		const head = fragments.find((f) => f.placement === "head");
		const json = head!.code!.replace(/^window\.__emdashPrivacy=/, "").replace(/;$/, "");
		return JSON.parse(json) as Record<string, any>;
	}

	it("injects the config in head and the loader at body end", async () => {
		const fragments = (await fragmentsFor(runtime, "/")) as Array<{ code?: string; placement?: string }>;
		expect(fragments.map((f) => f.placement)).toEqual(["head", "body:end"]);
		const config = configOf(fragments);
		expect(config.services.map((s: { id: string }) => s.id)).toEqual(["ga4", "meta"]);
		expect(config.hidePrompt).toBe(false);
		expect(config.rule.match).toEqual({ isDefault: true });
		expect(config.clearOnRevocation.measurement.cookies).toEqual(["_ga", "_ga_*"]);
	});

	it("passes the page language candidate, not a resolved language", async () => {
		const fragments = (await fragmentsFor(runtime, "/", "fr-CH")) as Array<{ code?: string; placement?: string }>;
		expect(configOf(fragments).language).toBe("fr");
	});

	it("hides the prompt on a policy page", async () => {
		const fragments = (await fragmentsFor(runtime, "/datenschutz")) as Array<{ code?: string; placement?: string }>;
		expect(configOf(fragments).hidePrompt).toBe(true);
	});

	it("injects nothing when the banner is disabled", async () => {
		await saveSettings(runtime, { enabled: false });
		expect(await fragmentsFor(runtime, "/")).toEqual([]);
	});

	it("with no services, still starts c15t with the banner hidden and no reopen button (embed-only sites)", async () => {
		await saveSettings(runtime, { services: "[]" });
		const fragments = (await fragmentsFor(runtime, "/")) as Array<{ code?: string; placement?: string }>;
		const config = configOf(fragments);
		expect(config.services).toEqual([]);
		expect(config.hidePrompt).toBe(true);
		expect(config.showTrigger).toBe(false);
	});

	it("escapes a </script> in an admin-entered service name so it cannot break the inline script", async () => {
		await saveSettings(runtime, {
			services: JSON.stringify([
				{ id: "x", name: "</script><img src=x onerror=alert(1)>", category: "marketing", src: "https://cdn.example.com/x.js" },
			]),
		});
		const fragments = (await fragmentsFor(runtime, "/")) as Array<{ code?: string; placement?: string }>;
		const head = fragments.find((f) => f.placement === "head")!;
		expect(head.code).not.toContain("</script");
		expect(configOf(fragments).services[0].name).toBe("</script><img src=x onerror=alert(1)>");
	});
});

/**
 * Runs `fn` with the server clock at `at`. Records are stored at the server's receive time, so this is how a
 * test creates an old record. (The browser's own timestamp is ignored, as the review requires.)
 */
async function atTime<T>(at: number, fn: () => Promise<T>): Promise<T> {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(at);
	try {
		return await fn();
	} finally {
		vi.useRealTimers();
	}
}

describe("retention", () => {
	const fortyMonthsAgo = Date.now() - 40 * 30 * DAY;

	it("deletes records past the retention period when the lazy purge runs", async () => {
		await atTime(fortyMonthsAgo, () =>
			call(runtime, "save", { method: "POST", headers: SAME_ORIGIN, body: savePayload({ subjectId: "old" }) }),
		);
		await call(runtime, "save", { method: "POST", headers: SAME_ORIGIN, body: savePayload({ subjectId: "fresh" }) });
		const subjects = (await exportRows(runtime)).map((r) => r[7]);
		expect(subjects).toEqual(["fresh"]);
	});

	it("runs the lazy purge at most once a day, so old records added later wait for the next run", async () => {
		await call(runtime, "save", { method: "POST", headers: SAME_ORIGIN, body: savePayload({ subjectId: "first" }) });
		await atTime(fortyMonthsAgo, () =>
			call(runtime, "save", { method: "POST", headers: SAME_ORIGIN, body: savePayload({ subjectId: "old-late" }) }),
		);
		const subjects = (await exportRows(runtime)).map((r) => r[7]).sort();
		expect(subjects).toEqual(["first", "old-late"]);
	});

	it("the admin 'delete expired now' action removes expired records and reports the count", async () => {
		// First save runs the lazy purge, so the once-a-day gate is closed for the next save.
		await call(runtime, "save", { method: "POST", headers: SAME_ORIGIN, body: savePayload({ subjectId: "first" }) });
		await atTime(fortyMonthsAgo, () =>
			call(runtime, "save", { method: "POST", headers: SAME_ORIGIN, body: savePayload({ subjectId: "old-late" }) }),
		);
		expect((await exportRows(runtime)).map((r) => r[7]).sort()).toEqual(["first", "old-late"]);

		const toast = await toastOf(await adminCall(runtime, { type: "block_action", action_id: "purge_now" }));
		expect(toast?.message).toBe("Deleted 1 expired record(s)");
		expect((await exportRows(runtime)).map((r) => r[7])).toEqual(["first"]);
	});
});

describe("scale: paging and batched purge", () => {
	// 250 rows crosses the 100-row export page and the 200-row purge batch, so both loops run more than once.
	const ROWS = 250;

	it("exports every record exactly once across export pages", async () => {
		const base = Date.now() - ROWS * 1000;
		for (let i = 0; i < ROWS; i++) {
			const res = await atTime(base + i * 1000, () =>
				call(runtime, "save", {
					method: "POST",
					headers: SAME_ORIGIN,
					body: savePayload({ subjectId: `s${String(i).padStart(4, "0")}` }),
				}),
			);
			expect(res.status).toBe(200);
		}
		const subjects = (await exportRows(runtime)).map((r) => r[7]!);
		expect(subjects).toHaveLength(ROWS);
		expect(new Set(subjects).size).toBe(ROWS);
		// Export is ordered oldest first (ts asc), so the subject ids come back in insertion order.
		expect(subjects).toEqual([...subjects].sort());
	}, 120_000);

	it("the admin purge removes more than one batch of expired records", async () => {
		// Establish the once-a-day gate with a fresh save, then add expired records after it.
		await call(runtime, "save", { method: "POST", headers: SAME_ORIGIN, body: savePayload({ subjectId: "fresh" }) });
		const old = Date.now() - 40 * 30 * DAY;
		await atTime(old, async () => {
			for (let i = 0; i < ROWS; i++) {
				await call(runtime, "save", {
					method: "POST",
					headers: SAME_ORIGIN,
					body: savePayload({ subjectId: `old${i}` }),
				});
			}
		});
		const toast = await toastOf(await adminCall(runtime, { type: "block_action", action_id: "purge_now" }));
		expect(toast?.message).toBe(`Deleted ${ROWS} expired record(s)`);
		expect((await exportRows(runtime)).map((r) => r[7])).toEqual(["fresh"]);
	}, 120_000);
});

describe("admin: stored config warnings", () => {
	it("shows an error banner when the stored services config has problems", async () => {
		// Write a bad value straight into the options row, as an older version or a manual DB edit would have left it.
		// The row name and encoding come from a real save, so this is the same format the runtime reads.
		const row = rawDb().prepare("SELECT name, value FROM options WHERE name LIKE '%settings:services'").get() as
			| { name: string; value: string }
			| undefined;
		expect(row, "the admin save should have written a services row").toBeTruthy();
		rawDb()
			.prepare("UPDATE options SET value = ? WHERE name = ?")
			.run(JSON.stringify('[{"id":"x","category":"analytics"}]'), row!.name);
		const res = await adminCall(runtime, { type: "page_load" });
		const body = (await res.json()) as { data: { blocks: Array<{ type: string; variant?: string; title?: string }> } };
		const banner = body.data.blocks.find((b) => b.type === "banner");
		expect(banner?.variant).toBe("error");
		expect(banner?.title).toMatch(/invalid/);
	});

	it("shows no banner when the stored config is valid", async () => {
		const res = await adminCall(runtime, { type: "page_load" });
		const body = (await res.json()) as { data: { blocks: Array<{ type: string }> } };
		expect(body.data.blocks.some((b) => b.type === "banner")).toBe(false);
	});
});
