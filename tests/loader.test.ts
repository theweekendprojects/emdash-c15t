/**
 * The inline loader runs in the visitor's browser, on every page. The browser tests cover the happy path on Chromium.
 * This runs the SAME loader source in Node against fakes of crypto, localStorage, fetch and import, so the branches a real
 * browser rarely hits are covered too: no SubtleCrypto, storage that throws, a wrong hash, a failed fetch.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BANNER_HASH, BANNER_JS } from "../src/assets.generated.js";
import { fragmentsFor, createRuntime, adminCall } from "./support/harness.js";

/** The loader source exactly as a page receives it. */
async function loaderSource(): Promise<string> {
	const runtime = await createRuntime();
	try {
		await adminCall(runtime, {
			type: "form_submit",
			action_id: "save_privacy",
			values: {
				enabled: true, services: JSON.stringify([{ id: "x", category: "analytics", src: "https://cdn.example.com/x.js" }]),
				allowedScriptHosts: "", language: "auto", colorScheme: "system", bannerPosition: "bottom-left", accentColor: "",
				requireChoice: false, privacyUrl: "", imprintUrl: "", cookieUrl: "", policyVersion: "1", cookieMaxAgeMonths: 12, retentionMonths: 36,
			},
		});
		const fragments = (await fragmentsFor(runtime, "/")) as Array<{ placement: string; code?: string }>;
		return fragments.find((f) => f.placement === "body:end")!.code!;
	} finally {
		await runtime.shutdown();
	}
}

const sha12 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

interface World {
	store: Map<string, string>;
	imported: string[];
	fetches: number;
	warnings: unknown[];
}

/** Runs the loader against fakes and resolves once its promise settles. */
async function run(source: string, opts: { subtle?: boolean; storage?: "ok" | "throws" | "full"; seed?: Record<string, string>; fetchData?: string; fetchFails?: boolean }): Promise<World> {
	const world: World = { store: new Map(Object.entries(opts.seed ?? {})), imported: [], fetches: 0, warnings: [] };
	const storage = {
		get length() { return world.store.size; },
		key: (i: number) => [...world.store.keys()][i] ?? null,
		getItem: (k: string) => { if (opts.storage === "throws") throw new Error("denied"); return world.store.get(k) ?? null; },
		setItem: (k: string, v: string) => { if (opts.storage === "throws" || opts.storage === "full") throw new Error("quota"); world.store.set(k, v); },
		removeItem: (k: string) => { world.store.delete(k); },
	};
	const subtle = opts.subtle === false ? {} : { subtle: { digest: async (_alg: string, data: Uint8Array) => createHash("sha256").update(data).digest() } };
	const fakeCrypto = opts.subtle === false ? {} : subtle;
	const fn = new Function("localStorage", "crypto", "fetch", "URL", "Blob", "TextEncoder", "console", "importer", `"use strict";\n var import_ = importer;\n return ${source.replace(/import\(/g, "import_(")}`);
	const fakeURL = Object.assign(function () {}, { createObjectURL: (blob: { text: string }) => `blob:${blob.text}` });
	const fakeBlob = function (this: { text: string }, parts: string[]) { this.text = parts.join(""); } as unknown as typeof Blob;
	const result = fn(
		storage, fakeCrypto,
		async () => { world.fetches++; if (opts.fetchFails) throw new Error("offline"); return { json: async () => ({ data: opts.fetchData ?? BANNER_JS }) }; },
		fakeURL, fakeBlob, TextEncoder,
		{ warn: (...a: unknown[]) => world.warnings.push(a) },
		async (url: string) => { world.imported.push(url.replace(/^blob:/, "")); },
	);
	await result;
	return world;
}

describe("inline loader (same source a page gets)", () => {
	it("the bundle hash in the build matches the bundle", () => {
		expect(sha12(BANNER_JS)).toBe(BANNER_HASH);
	});

	it("first visit: fetches, verifies, runs, and stores the bundle", async () => {
		const w = await run(await loaderSource(), {});
		expect(w.fetches).toBe(1);
		expect(w.imported).toEqual([BANNER_JS]);
		expect(w.store.get(`emdash-privacy-js:${BANNER_HASH}`)).toBe(BANNER_JS);
	});

	it("second visit: a verified cached copy runs with no fetch", async () => {
		const w = await run(await loaderSource(), { seed: { [`emdash-privacy-js:${BANNER_HASH}`]: BANNER_JS } });
		expect(w.fetches).toBe(0);
		expect(w.imported).toEqual([BANNER_JS]);
	});

	it("a cached copy with the wrong content is never run: it is removed and the real bundle is fetched", async () => {
		const evil = "globalThis.pwned = 1;";
		const w = await run(await loaderSource(), { seed: { [`emdash-privacy-js:${BANNER_HASH}`]: evil } });
		expect(w.imported).toEqual([BANNER_JS]);
		expect(w.imported).not.toContain(evil);
		expect(w.fetches).toBe(1);
		expect(w.store.get(`emdash-privacy-js:${BANNER_HASH}`)).toBe(BANNER_JS);
	});

	it("a fetched bundle that does not match the page's hash is not run and not stored", async () => {
		const w = await run(await loaderSource(), { fetchData: "alert('swapped in transit');" });
		expect(w.imported).toEqual([]);
		expect(w.store.has(`emdash-privacy-js:${BANNER_HASH}`)).toBe(false);
		expect(w.warnings.length).toBe(1);
	});

	it("other versions' keys are removed, and unrelated keys are left alone", async () => {
		const w = await run(await loaderSource(), {
			seed: { "emdash-privacy-js:000000000000": "old", "emdash-privacy-js:ffffffffffff": "older", "theme": "dark", [`emdash-privacy-js:${BANNER_HASH}`]: BANNER_JS },
		});
		expect([...w.store.keys()].sort()).toEqual([`emdash-privacy-js:${BANNER_HASH}`, "theme"].sort());
	});

	it("without SubtleCrypto: the bundle still runs, and nothing is cached", async () => {
		const w = await run(await loaderSource(), { subtle: false, seed: { [`emdash-privacy-js:${BANNER_HASH}`]: BANNER_JS } });
		expect(w.imported).toEqual([BANNER_JS]);
		expect(w.fetches).toBe(1); // a stored copy cannot be verified, so it is not trusted
	});

	it("storage that throws does not break the banner", async () => {
		const w = await run(await loaderSource(), { storage: "throws" });
		expect(w.imported).toEqual([BANNER_JS]);
		expect(w.warnings).toEqual([]);
	});

	it("a full storage quota does not break the banner either", async () => {
		const w = await run(await loaderSource(), { storage: "full" });
		expect(w.imported).toEqual([BANNER_JS]);
	});

	it("a failed fetch logs a warning and does not throw", async () => {
		const w = await run(await loaderSource(), { fetchFails: true });
		expect(w.imported).toEqual([]);
		expect(w.warnings.length).toBe(1);
	});
});
