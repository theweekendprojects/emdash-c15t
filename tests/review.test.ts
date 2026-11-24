/**
 * Regression tests for the deep-review findings (0.2.0 hardening). Each block names the finding it pins.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ADMIN,
	SAME_ORIGIN,
	adminCall,
	call,
	createRuntime,
	exportRows,
	fragmentsFor,
	rawDb,
	savePayload,
	type Runtime,
} from "./support/harness.js";

const DAY = 86_400_000;
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const runtimes: Runtime[] = [];
let runtime: Runtime;

function values(overrides: Record<string, unknown> = {}) {
	return {
		enabled: true,
		services: JSON.stringify([{ id: "ga4", category: "analytics", preset: "google-tag", options: { id: "G-ABCD1234" } }]),
		allowedScriptHosts: "",
		language: "auto",
		colorScheme: "system",
		bannerPosition: "bottom-left",
		accentColor: "",
		requireChoice: false,
		privacyUrl: "",
		imprintUrl: "",
		cookieUrl: "",
		policyVersion: "1",
		cookieMaxAgeMonths: 12,
		retentionMonths: 36,
		...overrides,
	};
}

async function submit(overrides: Record<string, unknown> = {}) {
	const res = await adminCall(runtime, { type: "form_submit", action_id: "save_privacy", values: values(overrides) });
	const body = (await res.json()) as { data: { toast?: { type: string; message: string } } };
	return body.data.toast;
}

beforeEach(async () => {
	runtime = await createRuntime();
	runtimes.push(runtime);
	expect((await submit())?.type).toBe("success");
});

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(runtimes.splice(0).map((r) => r.shutdown()));
});

const save = (body: Record<string, unknown>) => call(runtime, "save", { method: "POST", headers: SAME_ORIGIN, body: savePayload(body) });

describe("finding 1: the stored time is the server's, not the browser's", () => {
	it("a far-future givenAt is ignored: the record is stored at receive time", async () => {
		const future = Date.now() + 200 * 365 * DAY;
		expect((await save({ givenAt: future })).status).toBe(200);
		const [row] = await exportRows(runtime);
		const stored = Date.parse(row![0]!);
		expect(Math.abs(stored - Date.now())).toBeLessThan(60_000);
	});

	it("a backdated givenAt is ignored too", async () => {
		expect((await save({ givenAt: Date.now() - 40 * 30 * DAY })).status).toBe(200);
		const [row] = await exportRows(runtime);
		expect(Math.abs(Date.parse(row![0]!) - Date.now())).toBeLessThan(60_000);
	});
});

describe("finding 2: one lazy purge clears a backlog, not just 100 rows", () => {
	it("removes every expired record once the daily gate opens", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const start = Date.now();
		vi.setSystemTime(start - 40 * 30 * DAY); // seed the backlog 40 months ago
		for (let i = 0; i < 250; i++) expect((await save({ subjectId: `old${i}` })).status).toBe(200);
		vi.setSystemTime(start); // back to now, with the gate closed by the last purge
		const gate = rawDb().prepare("SELECT name FROM options WHERE name LIKE '%state:lastPurge'").get() as { name: string };
		rawDb().prepare("UPDATE options SET value = ? WHERE name = ?").run(JSON.stringify({ at: 0, via: "save" }), gate.name);
		expect((await save({ subjectId: "trigger" })).status).toBe(200);
		expect((await exportRows(runtime)).map((r) => r[7])).toEqual(["trigger"]);
	}, 180_000);
});

describe("finding 3: third-party license notices travel with the package", () => {
	it("ships THIRD_PARTY_LICENSES.md and lists it in files", () => {
		expect(existsSync(`${ROOT}/THIRD_PARTY_LICENSES.md`)).toBe(true);
		const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")) as { files: string[] };
		expect(pkg.files).toContain("THIRD_PARTY_LICENSES.md");
	});

	it("names c15t with its Apache-2.0 license, and the bundled MIT packages", () => {
		const text = readFileSync(`${ROOT}/THIRD_PARTY_LICENSES.md`, "utf8");
		expect(text).toMatch(/c15t/);
		expect(text).toMatch(/Apache License[\s\S]*Version 2\.0/);
		expect(text).toMatch(/valibot/);
		expect(text).toMatch(/base-x/);
	});
});

describe("finding 4: the peer range matches the EmDash versions we test", () => {
	it("declares emdash >=1.2.0 (raw responses need 0.39+, 1.2.0 is the tested floor)", () => {
		const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")) as { peerDependencies: Record<string, string> };
		expect(pkg.peerDependencies.emdash).toBe(">=1.2.0");
	});
});

describe("finding 7: a public render does not run one query per setting", () => {
	it("reads all settings in a constant number of queries", async () => {
		const db = rawDb() as unknown as { prepare: (sql: string) => unknown };
		const original = db.prepare.bind(db);
		let count = 0;
		db.prepare = (sql: string) => {
			count++;
			return original(sql);
		};
		try {
			await fragmentsFor(runtime, "/");
		} finally {
			db.prepare = original;
		}
		expect(count).toBeLessThanOrEqual(3);
	});
});

describe("finding 8: input bounds", () => {
	it("a save while the banner is disabled stores nothing (no proof for a banner nobody saw)", async () => {
		await submit({ enabled: false });
		const res = await save({ subjectId: "while-disabled" });
		expect(res.status).toBe(200);
		expect(await exportRows(runtime)).toHaveLength(0);
	});

	it("an empty subjectId is refused", async () => {
		expect((await save({ subjectId: "" })).status).toBe(400);
	});

	it("more than 20 grant keys is refused", async () => {
		const grants: Record<string, boolean> = {};
		for (let i = 0; i < 40; i++) grants[`k${i}`] = true;
		expect((await save({ grants })).status).toBe(400);
	});

	it("retention of 0 months is an error, not a silent change to 36", async () => {
		expect((await submit({ retentionMonths: 0 }))?.type).toBe("error");
	});

	it("retention above 120 months is an error", async () => {
		expect((await submit({ retentionMonths: 100000 }))?.type).toBe("error");
	});

	it("re-ask period above 36 months is an error", async () => {
		expect((await submit({ cookieMaxAgeMonths: 5000 }))?.type).toBe("error");
	});
});

describe("finding 9: no dead headers on the raw CSV response", () => {
	it("the route sets nothing EmDash would discard (EmDash sets nosniff and no-store itself)", () => {
		const source = readFileSync(`${ROOT}/src/runtime.ts`, "utf8");
		expect(source).not.toMatch(/"x-content-type-options"/);
		expect(source).not.toMatch(/"cache-control": "private, no-store"/);
	});
});

describe("admin reachability", () => {
	it("still refuses a non-admin after the changes", async () => {
		const res = await call(runtime, "consent-export", { user: { ...ADMIN, role: 10 }, headers: { "X-EmDash-Request": "1" } });
		expect(res.status).toBe(403);
	});
});

describe("live finding: the site id falls back to the request host when the site URL is empty", () => {
	// Found on the staging Worker: ctx.site.url is "" there, so `??` did not fall through and every record was stored as "unknown".
	it("stores the request's host as siteId when the site URL is empty", async () => {
		const bare = await createRuntime("");
		runtimes.push(bare);
		await adminCall(bare, { type: "form_submit", action_id: "save_privacy", values: values() });
		const res = await call(bare, "save", { method: "POST", headers: SAME_ORIGIN, body: savePayload({ subjectId: "bare" }) });
		expect(res.status).toBe(200);
		const row = rawDb().prepare("SELECT data FROM _plugin_storage WHERE collection = 'consents' ORDER BY created_at DESC LIMIT 1").get() as { data: string };
		expect(JSON.parse(row.data).siteId).toBe("site.example");
	});
});

describe("review round 2: export completeness and limits", () => {
	/** Inserts consent rows directly. 90 000 saves through the route would take far too long. */
	function seed(count: number, tsAt: (i: number) => number, siteId = "site.example") {
		const insert = rawDb().prepare(
			"INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at, revision) VALUES ('emdash-privacy','consents',?,?,?,?,?)",
		);
		rawDb().exec("BEGIN");
		for (let i = 0; i < count; i++) {
			const ts = tsAt(i);
			const data = JSON.stringify({ siteId, subjectId: `sub_${String(i).padStart(26, "0")}`, ts, action: "all", grants: { necessary: true, measurement: true, marketing: true }, policyVersion: "1", bannerVersion: "2" });
			const iso = new Date(ts).toISOString();
			insert.run(`seed-${siteId}-${i}`, data, iso, iso, `rev-${i}`);
		}
		rawDb().exec("COMMIT");
	}
	const download = (query?: string, baseUrl?: string) =>
		call(runtime, "consent-export", { user: ADMIN, headers: { "X-EmDash-Request": "1" }, query, baseUrl });

	it("a history too large for one response is refused with a clear error, never cut short", async () => {
		seed(90_000, (i) => Date.UTC(2026, 0, 1) + i * 1000);
		const res = await download();
		const body = await res.text();
		expect(res.status).toBe(413);
		expect(body).toMatch(/too large for one download/);
		expect(body).toMatch(/from=/);
		expect(body).not.toMatch(/^"createdAt"/);
		// 90 000 rows of this size are over EmDash's 8 MiB limit, so this is the real failure the guard prevents.
		expect(90_000 * 112).toBeGreaterThan(8 * 1024 * 1024);
	}, 180_000);

	it("from and to slice a large history into parts with no overlap and no gap, in linear time", async () => {
		const t0 = Date.UTC(2026, 0, 1);
		seed(90_000, (i) => t0 + i * 1000);
		const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString().slice(0, 19) + "Z";
		const subjects = async (query: string) => {
			const started = Date.now();
			const res = await download(query);
			expect(res.status).toBe(200);
			const rows = (await res.text()).trim().split("\r\n").slice(1).map((l) => l.split('","')[7]!);
			return { rows, ms: Date.now() - started };
		};
		const a = await subjects(`to=${at(20_000)}`);
		const b = await subjects(`from=${at(20_000)}&to=${at(40_000)}`);
		const c = await subjects(`from=${at(40_000)}&to=${at(60_000)}`);
		// 20 000 rows each: "to" is exclusive and "from" is inclusive, so the parts meet exactly.
		expect([a.rows.length, b.rows.length, c.rows.length]).toEqual([20_000, 20_000, 20_000]);
		const id = (n: number) => `sub_${String(n).padStart(26, "0")}`;
		expect(a.rows[0]).toBe(id(0));
		expect(a.rows.at(-1)).toBe(id(19_999));
		expect(b.rows[0]).toBe(id(20_000));
		expect(b.rows.at(-1)).toBe(id(39_999));
		expect(c.rows[0]).toBe(id(40_000));
		expect(new Set([...a.rows, ...b.rows, ...c.rows]).size).toBe(60_000);
		// The old JSON orderBy made this quadratic: 7 000 rows took 13 s, so 20 000 would take well over a minute.
		expect(Math.max(a.ms, b.ms, c.ms)).toBeLessThan(40_000);
	}, 300_000);

	it("rejects a malformed from or to instead of ignoring it", async () => {
		expect((await download("from=not-a-date")).status).toBe(400);
		expect((await download("to=2026-13-45")).status).toBe(400);
	});

	it("exports records saved under different hostnames together (storage is per site, siteId is only a label)", async () => {
		const bare = await createRuntime("");
		runtimes.push(bare);
		await adminCall(bare, { type: "form_submit", action_id: "save_privacy", values: values() });
		for (const host of ["https://a.example", "https://b.example"]) {
			const res = await call(bare, "save", {
				method: "POST",
				baseUrl: host,
				headers: { origin: host },
				body: savePayload({ subjectId: `via-${host}` }),
			});
			expect(res.status).toBe(200);
		}
		const res = await call(bare, "consent-export", { user: ADMIN, baseUrl: "https://a.example", headers: { "X-EmDash-Request": "1" } });
		const lines = (await res.text()).trim().split("\r\n");
		expect(lines.length - 1).toBe(2);
		// the host each record was saved under stays visible in the file
		expect(lines.slice(1).join("\n")).toMatch(/a\.example/);
		expect(lines.slice(1).join("\n")).toMatch(/b\.example/);
	});

	it("the admin record count includes records saved under every hostname", async () => {
		const bare = await createRuntime("");
		runtimes.push(bare);
		await adminCall(bare, { type: "form_submit", action_id: "save_privacy", values: values() });
		for (const host of ["https://a.example", "https://b.example"]) {
			await call(bare, "save", { method: "POST", baseUrl: host, headers: { origin: host }, body: savePayload({ subjectId: host }) });
		}
		const page = await adminCall(bare, { type: "page_load" });
		const body = (await page.json()) as { data: { blocks: Array<{ type: string; items?: Array<{ value: string }> }> } };
		expect(body.data.blocks.find((b) => b.type === "stats")?.items?.[0]?.value).toBe("2");
	});
});

describe("review round 2: policy pages and host", () => {
	const hidePrompt = async (path: string) => {
		const fragments = (await fragmentsFor(runtime, path)) as Array<{ code?: string; placement: string }>;
		const config = JSON.parse(fragments[0]!.code!.replace(/^window\.__emdashPrivacy=/, "").replace(/;$/, ""));
		return config.hidePrompt as boolean;
	};

	it("a policy URL hosted elsewhere does not hide the banner on this site's page with the same path", async () => {
		expect((await submit({ privacyUrl: "https://policies.example.com/privacy" }))?.type).toBe("success");
		expect(await hidePrompt("/privacy")).toBe(false);
	});

	it("a policy URL on this host does hide it", async () => {
		expect((await submit({ privacyUrl: "https://site.example/privacy" }))?.type).toBe("success");
		expect(await hidePrompt("/privacy")).toBe(true);
	});

	it("a relative policy URL hides it", async () => {
		expect((await submit({ privacyUrl: "/privacy" }))?.type).toBe("success");
		expect(await hidePrompt("/privacy")).toBe(true);
	});
});

describe("review round 2: empty settings", () => {
	const config = async () => {
		const fragments = (await fragmentsFor(runtime, "/")) as Array<{ code?: string; placement: string }>;
		return JSON.parse(fragments[0]!.code!.replace(/^window\.__emdashPrivacy=/, "").replace(/;$/, "")) as Record<string, any>;
	};

	it("clearing the language, position and policy version in the form falls back to the defaults, not to empty values", async () => {
		const toast = await submit({ language: "", bannerPosition: "", policyVersion: "", accentColor: "" });
		expect(toast?.type).toBe("success");
		const c = await config();
		// language: stored as the default "auto", which follows the page (null here: the test page has no locale)
		expect(c.bannerPosition).toBe("bottom-left");
		expect(c.policyVersion).toBe("1");
		expect(c.rule.copyRevision).toBe("1");
		expect(c.accentColor).toBeUndefined();
	});

	it("a policy version made of spaces is not saved as an empty version", async () => {
		await submit({ policyVersion: "   " });
		const c = await config();
		expect(c.policyVersion).toBe("1");
	});
});
