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
