import { describe, expect, it } from "vitest";
import { checkExportLink, exportLinkQuery, exportSecret, LINK_TTL_SECONDS, type KvLike } from "../src/export-link.js";

const SECRET = "a".repeat(64);
const NOW = 1_800_000_000;

/** A link from a query string, as the admin page builds it. */
async function link(input: { from?: string; to?: string } = {}, nowSec = NOW) {
	return new URLSearchParams(await exportLinkQuery(SECRET, input, nowSec));
}

describe("export links", () => {
	it("a fresh link is accepted", async () => {
		expect(await checkExportLink(SECRET, await link({ from: "2026-01-01" }), NOW)).toEqual({ ok: true });
	});

	it("a link stops working when it expires", async () => {
		const params = await link({}, NOW);
		const result = await checkExportLink(SECRET, params, NOW + LINK_TTL_SECONDS + 1);
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toMatch(/expired/);
	});

	it("changing the range breaks the signature", async () => {
		const params = await link({ from: "2026-01-01", to: "2026-07-01" });
		params.set("from", "2020-01-01");
		expect((await checkExportLink(SECRET, params, NOW)).ok).toBe(false);
	});

	it("a link signed with another secret is refused", async () => {
		const params = await link({ from: "2026-01-01" });
		expect((await checkExportLink("b".repeat(64), params, NOW)).ok).toBe(false);
	});

	it("a malformed or missing signature is refused", async () => {
		const params = await link({});
		params.set("sig", "not-hex");
		expect((await checkExportLink(SECRET, params, NOW)).ok).toBe(false);
		expect((await checkExportLink(SECRET, new URLSearchParams(), NOW)).ok).toBe(false);
	});

	it("an expiry further ahead than this site can issue is refused", async () => {
		const params = await link({}, NOW + 10 * LINK_TTL_SECONDS);
		expect((await checkExportLink(SECRET, params, NOW)).ok).toBe(false);
	});
});

describe("export secret", () => {
	/** A minimal KV with the same compare-and-set rule as EmDash: a null expected revision creates only when absent. */
	function memoryKv(): KvLike & { store: Map<string, unknown> } {
		const store = new Map<string, unknown>();
		return {
			store,
			async get<T>(key: string) {
				return store.has(key) ? (store.get(key) as T) : null;
			},
			async compareAndSet(key: string, expected: string | null, value: unknown) {
				if (expected === null && store.has(key)) return { applied: false };
				store.set(key, value);
				return { applied: true };
			},
		};
	}

	it("is created once and then reused, so links stay valid", async () => {
		const kv = memoryKv();
		const first = await exportSecret(kv);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(await exportSecret(kv)).toBe(first);
	});
});
