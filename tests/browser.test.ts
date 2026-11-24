/**
 * End-to-end: the real EmDash runtime renders the page (head config and loader), serves the real banner
 * bundle from its asset route, and receives the consent POST through its route dispatcher. A headless
 * Chromium drives the page. External vendor requests are intercepted, so the test needs no network.
 *
 * Needs a built bundle (`npm run build:client`) and a Chromium. Install one with
 * `npx playwright-core install chromium`, or point CHROMIUM_PATH at an existing build.
 */
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchPluginApiRequest } from "emdash/internal/plugin-test-runtime";
import { PLUGIN_ID } from "../src/shared.js";
import { adminCall, createRuntime, fragmentsFor, rawDb, type Runtime } from "./support/harness.js";

const BUNDLE = fileURLToPath(new URL("../dist/banner.js", import.meta.url));
const ROUTE_PREFIX = `/_emdash/api/plugins/${PLUGIN_ID}/`;
const SERVICES = JSON.stringify([
	{ id: "ga4", name: "Google Analytics", category: "analytics", preset: "google-tag", options: { id: "G-ABCD1234" } },
	{ id: "meta", name: "Meta", category: "marketing", preset: "meta-pixel", options: { pixelId: "123456789012345" } },
]);

/** Button labels: English on English pages, German on the fallback. Either is a banner. */
const ACCEPT = ["Accept all", "Alle akzeptieren"];
const REJECT = ["Reject all", "Alle ablehnen"];

let server: Server;
let origin = "";
let runtime: Runtime;
let browser: Browser;
const externalRequests: string[] = [];

/** Reads the request body, so it can be handed to EmDash's route dispatcher. */
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return chunks.length ? Buffer.concat(chunks) : undefined;
}

beforeAll(async () => {
	if (!existsSync(BUNDLE)) throw new Error("dist/banner.js is missing. Run `npm run build:client` first.");

	// The server needs a port before the runtime is created, because the runtime's site URL must be the
	// origin the browser actually uses. Otherwise the same-origin check would (correctly) refuse the save.
	server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", origin);
		try {
			if (url.pathname.startsWith(ROUTE_PREFIX)) {
				const body = await readBody(req);
				const headers = new Headers();
				for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
				const response = await dispatchPluginApiRequest({
					runtime,
					pluginId: PLUGIN_ID,
					path: `/${url.pathname.slice(ROUTE_PREFIX.length)}`,
					request: new Request(url, { method: req.method, headers, body: body as never }),
				});
				res.writeHead(response.status, Object.fromEntries(response.headers));
				res.end(Buffer.from(await response.arrayBuffer()));
				return;
			}
			if (url.pathname === "/favicon.ico") {
				res.writeHead(404).end();
				return;
			}
			// A page: its head config and body loader come from the runtime's own page:fragments output.
			const fragments = (await fragmentsFor(runtime, url.pathname, url.searchParams.get("lang") ?? "en")) as Array<{
				placement: string;
				code?: string;
			}>;
			const head = fragments.find((f) => f.placement === "head")?.code ?? "";
			const loader = fragments.find((f) => f.placement === "body:end")?.code ?? "";
			res
				.writeHead(200, { "content-type": "text/html; charset=utf-8" })
				.end(
					`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${url.pathname}</title>
<script>${head}</script></head>
<body><h1>Test page ${url.pathname}</h1><p>Body text.</p>
<script>${loader}</script></body></html>`,
				);
		} catch (err) {
			res.writeHead(500).end(String(err));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const { port } = server.address() as { port: number };
	origin = `http://127.0.0.1:${port}`;

	runtime = await createRuntime(origin);
	const seeded = await adminCall(runtime, {
		type: "form_submit",
		action_id: "save_privacy",
		values: {
			enabled: true,
			services: SERVICES,
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
		},
	});
	const toast = ((await seeded.json()) as { data: { toast?: { type: string; message: string } } }).data.toast;
	if (toast?.type !== "success") throw new Error(`settings not saved: ${toast?.message}`);

	browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }).catch((err: Error) => {
		throw new Error(`Could not start Chromium: ${err.message}. Run \`npx playwright-core install chromium\` or set CHROMIUM_PATH.`);
	});
}, 180_000);

afterAll(async () => {
	await browser?.close();
	// Chromium keeps HTTP connections alive. Close them, or server.close() never calls back.
	server?.closeAllConnections();
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	await runtime?.shutdown();
}, 60_000);

/** Opens a fresh browser context, with external requests blocked and recorded. */
async function openPage(path: string, { expectBanner = true }: { expectBanner?: boolean } = {}) {
	const context = await browser.newContext();
	const consoleErrors: string[] = [];
	await context.route("**/*", (route) => {
		const url = route.request().url();
		if (url.startsWith(origin)) return route.continue();
		externalRequests.push(url);
		return route.fulfill({ status: 204, body: "" });
	});
	const page = await context.newPage();
	page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning") consoleErrors.push(`console.${m.type()}: ${m.text()}`);
	});
	await page.goto(`${origin}${path}`, { waitUntil: "load" });
	await page.waitForFunction(() => typeof (window as unknown as { emdashPrivacy?: unknown }).emdashPrivacy === "object", null, {
		timeout: 15_000,
	});
	if (expectBanner) {
		// Wait for a banner button, not a fixed delay: the UI mounts after the bundle imports.
		await waitForBannerButton(page).catch(async (err: Error) => {
			throw new Error(`banner did not mount on ${path}: ${err.message}. Console: ${consoleErrors.join(" | ") || "(none)"}`);
		});
	}
	return { context, page, consoleErrors };
}

/** Resolves once an Accept or Reject button exists in any open shadow root. */
async function waitForBannerButton(page: Page): Promise<void> {
	await page.waitForFunction(
		() => {
			const walk = (root: Document | ShadowRoot): boolean => {
				for (const el of Array.from(root.querySelectorAll("*"))) {
					if (el.shadowRoot) {
						const labels = Array.from(el.shadowRoot.querySelectorAll("button")).map((b) => b.textContent ?? "");
						if (labels.some((t) => /Accept all|Alle akzeptieren|Reject all|Alle ablehnen/.test(t))) return true;
						if (walk(el.shadowRoot)) return true;
					}
				}
				return false;
			};
			return walk(document);
		},
		null,
		{ timeout: 15_000 },
	);
}

/** Text of every open shadow root, where c15t renders the banner. */
function shadowText(page: Page): Promise<string> {
	return page.evaluate(() => {
		const out: string[] = [];
		const walk = (root: Document | ShadowRoot) => {
			for (const el of Array.from(root.querySelectorAll("*"))) {
				if (el.shadowRoot) {
					out.push(el.shadowRoot.textContent ?? "");
					walk(el.shadowRoot);
				}
			}
		};
		walk(document);
		return out.join(" ").replace(/\s+/g, " ");
	});
}

/** Clicks the first shadow-root button whose label starts with one of `labels`. */
function clickButton(page: Page, labels: string[]): Promise<boolean> {
	return page.evaluate((labels) => {
		const find = (root: Document | ShadowRoot): HTMLButtonElement | null => {
			for (const b of Array.from(root.querySelectorAll("button"))) {
				const text = (b.textContent ?? "").trim();
				if (labels.some((l) => text.startsWith(l))) return b;
			}
			for (const el of Array.from(root.querySelectorAll("*"))) {
				if (el.shadowRoot) {
					const found = find(el.shadowRoot);
					if (found) return found;
				}
			}
			return null;
		};
		const button = find(document);
		if (!button) return false;
		button.click();
		return true;
	}, labels);
}

/** Polls a condition until it holds, so tests wait for an observable effect, not a fixed delay. */
async function waitUntil(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

const vendorHosts = /googletagmanager|google-analytics|connect\.facebook|facebook\.com/;
const vendorCalls = () => externalRequests.filter((u) => vendorHosts.test(u));

/** Consent records in plugin storage, counted directly. */
function storedConsentCount(): number {
	const row = rawDb()
		.prepare("SELECT COUNT(*) AS n FROM _plugin_storage WHERE plugin_id = ? AND collection = 'consents'")
		.get(PLUGIN_ID) as { n: number } | undefined;
	return row?.n ?? 0;
}

const isSaveRequest = (r: { url(): string; request(): { method(): string } }) =>
	r.url().endsWith(`${ROUTE_PREFIX}save`) && r.request().method() === "POST";

describe("banner in a real browser against the EmDash runtime", () => {
	it("on an English page: no vendor request before a choice, accept loads them and stores one record", async () => {
		const before = storedConsentCount();
		externalRequests.length = 0;
		const { context, page, consoleErrors } = await openPage("/");
		expect(await shadowText(page)).toContain("Accept all");
		expect(vendorCalls()).toEqual([]);

		const saved = page.waitForResponse(isSaveRequest);
		expect(await clickButton(page, ACCEPT)).toBe(true);
		expect((await saved).status()).toBe(200);
		await waitUntil(() => vendorCalls().length > 0, "a vendor request after accept");
		expect(storedConsentCount()).toBe(before + 1);
		expect(consoleErrors).toEqual([]);
		await context.close();
	}, 60_000);

	it("reject loads no vendor request, and the refusal persists after reload", async () => {
		externalRequests.length = 0;
		const { context, page, consoleErrors } = await openPage("/");
		const saved = page.waitForResponse(isSaveRequest);
		expect(await clickButton(page, REJECT)).toBe(true);
		expect((await saved).status()).toBe(200);
		expect(vendorCalls()).toEqual([]);

		await page.reload({ waitUntil: "load" });
		await page.waitForFunction(() => typeof (window as unknown as { emdashPrivacy?: unknown }).emdashPrivacy === "object");
		const state = await page.evaluate(() => {
			const client = (window as unknown as { emdashPrivacy: { hasConsented(): boolean; has(c: string): boolean } }).emdashPrivacy;
			return { consented: client.hasConsented(), measurement: client.has("measurement") };
		});
		expect(state).toEqual({ consented: true, measurement: false });
		expect(vendorCalls()).toEqual([]);
		expect(consoleErrors).toEqual([]);
		await context.close();
	}, 60_000);

	it("a page language that is not bundled (French) shows German", async () => {
		const { context, page } = await openPage("/?lang=fr");
		expect(await shadowText(page)).toContain("Alle akzeptieren");
		await context.close();
	}, 60_000);

	it("a policy page shows no banner", async () => {
		const { context, page } = await openPage("/datenschutz", { expectBanner: false });
		// Wait for the client to start. Then give a banner the time it would need to appear, and confirm it did not.
		await page.waitForFunction(() => typeof (window as unknown as { emdashPrivacy?: unknown }).emdashPrivacy === "object");
		await page.waitForTimeout(3000);
		expect(await shadowText(page)).not.toMatch(/Accept all|Alle akzeptieren/);
		await context.close();
	}, 60_000);
});
