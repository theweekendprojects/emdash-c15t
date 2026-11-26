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
import { BANNER_HASH } from "../src/assets.generated.js";

const BUNDLE = fileURLToPath(new URL("../dist/banner.js", import.meta.url));
const ROUTE_PREFIX = `/_emdash/api/plugins/${PLUGIN_ID}/`;
const SERVICES = JSON.stringify([
	{ id: "ga4", name: "Google Analytics", category: "analytics", preset: "google-tag", options: { id: "G-ABCD1234" } },
	{ id: "meta", name: "Meta", category: "marketing", preset: "meta-pixel", options: { pixelId: "123456789012345" } },
]);

/** Button labels: English on English pages, German on the fallback. Either is a banner. */
const ACCEPT = ["Accept all", "Alle akzeptieren"];

/** Content Security Policies for the documented cases (README, Operating notes). Other paths send no policy. */
const CSP_BY_PATH: Record<string, string> = {
	// strict: no inline script, no blob import. The banner must not run (a known, documented limit).
	"/csp-strict": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
	// what the README asks for: inline loader plus blob: for the bundle import. The banner must run.
	"/csp-inline-blob": "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
	// inline without blob: the loader cannot import the bundle. The banner must not run.
	"/csp-inline-only": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
};
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
			const embedBody =
				url.pathname === "/embed"
					? `<div class="emdash-privacy-embed"><iframe data-src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?playsinline=1" data-category="marketing" title="Demo"></iframe><div class="emdash-privacy-placeholder"><p>Third-party video.</p><button type="button" data-emdash-privacy-open>Privacy settings</button></div></div>`
					: "<p>Body text.</p>";
			// A page: its head config and body loader come from the runtime's own page:fragments output.
			const fragments = (await fragmentsFor(runtime, url.pathname, url.searchParams.get("lang") ?? "en")) as Array<{
				placement: string;
				code?: string;
			}>;
			// Every head fragment, in order: the Consent Mode defaults (when a Google service is set) come before the config.
			const head = fragments.filter((f) => f.placement === "head").map((f) => f.code ?? "").join("\n");
			const loader = fragments.find((f) => f.placement === "body:end")?.code ?? "";
			const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
			const csp = CSP_BY_PATH[url.pathname];
			if (csp) headers["content-security-policy"] = csp;
			res
				.writeHead(200, headers)
				.end(
					`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${url.pathname}</title>
<script>${head}</script></head>
<body><h1>Test page ${url.pathname}</h1>${embedBody}
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

describe("review: bundle cache integrity and embed-only sites", () => {
	const KEY = `emdash-privacy-js:${BANNER_HASH}`;

	it("a tampered cached bundle is never run, and the banner still mounts from the verified bundle", async () => {
		const context = await browser.newContext();
		// Runs before any page script: plants code under the cache key the loader reads first.
		await context.addInitScript(
			({ key }) => {
				try {
					localStorage.setItem(key, "window.__pwned = 1;");
				} catch {
					/* storage may be disabled */
				}
			},
			{ key: KEY },
		);
		await context.route("**/*", (route) => {
			const url = route.request().url();
			if (url.startsWith(origin)) return route.continue();
			return route.fulfill({ status: 204, body: "" });
		});
		const page = await context.newPage();
		const consoleErrors: string[] = [];
		page.on("console", (m) => {
			if (m.type() === "error") consoleErrors.push(m.text());
		});
		await page.goto(`${origin}/`, { waitUntil: "load" });
		await waitForBannerButton(page).catch(() => {
			throw new Error(`banner did not mount after a tampered cache. Console: ${consoleErrors.join(" | ")}`);
		});
		expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
		await context.close();
	}, 60_000);

	it("a verified cached copy loads with no bundle request, and a stale version's key is removed", async () => {
		const context = await browser.newContext();
		await context.route("**/*", (route) => {
			const url = route.request().url();
			if (url.startsWith(origin)) return route.continue();
			return route.fulfill({ status: 204, body: "" });
		});
		const bundleRequests: string[] = [];
		const page = await context.newPage();
		page.on("request", (r) => {
			if (r.url().includes("/assets/banner-")) bundleRequests.push(r.url());
		});
		// First visit: fetches the bundle, verifies it, stores it.
		await page.goto(`${origin}/`, { waitUntil: "load" });
		await waitForBannerButton(page);
		expect(bundleRequests).toHaveLength(1);
		// Leave a stale key from an older build, as a previous release would have.
		await page.evaluate(() => localStorage.setItem("emdash-privacy-js:000000000000", "old"));
		// Second visit: the verified copy runs from localStorage, so no bundle request is made.
		bundleRequests.length = 0;
		await page.goto(`${origin}/`, { waitUntil: "load" });
		await waitForBannerButton(page);
		expect(bundleRequests).toEqual([]);
		const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("emdash-privacy-js:")));
		expect(keys).toEqual([KEY]);
		await context.close();
	}, 60_000);

	it("a site with no tracked services still starts c15t, so an embed placeholder can open the dialog", async () => {
		const seeded = await adminCall(runtime, {
			type: "form_submit",
			action_id: "save_privacy",
			values: {
				enabled: true,
				services: "[]",
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
			},
		});
		expect(((await seeded.json()) as { data: { toast?: { type: string } } }).data.toast?.type).toBe("success");
		try {
			externalRequests.length = 0;
			const { context, page, consoleErrors } = await openPage("/embed", { expectBanner: false });
			// The iframe is gated: no request to the video host before consent.
			expect(await page.evaluate(() => document.querySelector("iframe")?.hasAttribute("src"))).toBe(false);
			expect(externalRequests.filter((u) => u.includes("youtube"))).toEqual([]);

			// The placeholder button opens the preference dialog (the banner stays hidden).
			await page.click("[data-emdash-privacy-open]");
			await page.waitForFunction(() => {
				const walk = (root: Document | ShadowRoot): boolean => {
					for (const el of Array.from(root.querySelectorAll("*"))) {
						if (el.shadowRoot) {
							if (/Privacy settings|Datenschutz-Einstellungen/.test(el.shadowRoot.textContent ?? "")) return true;
							if (walk(el.shadowRoot)) return true;
						}
					}
					return false;
				};
				return walk(document);
			}, null, { timeout: 15_000 });

			// Allowing the category in the dialog sets the iframe's src, and only then does the video load.
			const saved = page.waitForResponse(isSaveRequest);
			expect(await clickButton(page, ACCEPT)).toBe(true);
			expect((await saved).status()).toBe(200);
			await page.waitForFunction(() => document.querySelector("iframe")?.hasAttribute("src") === true, null, { timeout: 15_000 });
			await waitUntil(() => externalRequests.some((u) => u.includes("youtube-nocookie")), "the video request after consent");
			expect(consoleErrors).toEqual([]);
			await context.close();
		} finally {
			// Restore the services used by the other browser scenarios.
			await adminCall(runtime, {
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
		}
	}, 90_000);
});

describe("content security policy (documented limits)", () => {
	/** Loads a page and waits a fixed time, for cases where the banner must NOT appear (openPage waits for it). */
	async function visitAndWait(path: string) {
		const context = await browser.newContext();
		await context.route("**/*", (route) => {
			const url = route.request().url();
			if (url.startsWith(origin)) return route.continue();
			return route.fulfill({ status: 204, body: "" });
		});
		const page = await context.newPage();
		const consoleErrors: string[] = [];
		page.on("console", (m) => {
			if (m.type() === "error") consoleErrors.push(m.text());
		});
		await page.goto(`${origin}${path}`, { waitUntil: "load" });
		await page.waitForTimeout(5000);
		return { context, page, consoleErrors };
	}

	it("a strict policy (script-src 'self') blocks the loader, so no banner, and the browser reports the violation", async () => {
		const { context, page, consoleErrors } = await visitAndWait("/csp-strict");
		expect(await shadowText(page)).not.toMatch(/Accept all|Alle akzeptieren/);
		expect(consoleErrors.some((e) => /Content Security Policy/i.test(e))).toBe(true);
		await context.close();
	}, 60_000);

	it("inline script plus blob: (what the README asks for) runs the banner", async () => {
		const { context, consoleErrors } = await openPage("/csp-inline-blob");
		expect(consoleErrors.filter((e) => /Content Security Policy/i.test(e))).toEqual([]);
		await context.close();
	}, 60_000);

	it("inline script without blob: cannot import the bundle, so no banner", async () => {
		const { context, page, consoleErrors } = await visitAndWait("/csp-inline-only");
		expect(await shadowText(page)).not.toMatch(/Accept all|Alle akzeptieren/);
		expect(consoleErrors.some((e) => /Content Security Policy/i.test(e))).toBe(true);
		await context.close();
	}, 60_000);
});

describe("Google Consent Mode defaults (denied until a choice)", () => {
	type ConsentCall = { kind: string; state: Record<string, string> };
	/** Every consent command the page pushed to dataLayer (the Google Consent Mode API), in order. */
	async function consentCalls(page: Page): Promise<ConsentCall[]> {
		return page.evaluate(() =>
			Array.from((window as unknown as { dataLayer?: ArrayLike<unknown> }).dataLayer ?? [])
				.map((e) => Array.from(e as ArrayLike<unknown>))
				.filter((c) => c[0] === "consent")
				.map((c) => ({ kind: String(c[1]), state: c[2] as Record<string, string> })),
		);
	}
	/** Waits until the last consent command sets analytics to the wanted value. */
	async function waitForAnalytics(page: Page, want: "granted" | "denied") {
		for (let i = 0; i < 40; i++) {
			const calls = await consentCalls(page);
			if (calls.at(-1)?.state?.analytics_storage === want) return calls;
			await page.waitForTimeout(250);
		}
		throw new Error(`consent state never became ${want}: ${JSON.stringify(await consentCalls(page))}`);
	}

	it("before any choice: the default is denied, and no Google request is made", async () => {
		externalRequests.length = 0;
		const { context, page, consoleErrors } = await openPage("/");
		const calls = await consentCalls(page);
		expect(calls[0]?.kind).toBe("default");
		expect(calls[0]?.state).toMatchObject({ analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
		expect(vendorCalls()).toEqual([]);
		expect(consoleErrors).toEqual([]);
		await context.close();
	}, 60_000);

	it("after accept: the state becomes granted", async () => {
		externalRequests.length = 0;
		const { context, page, consoleErrors } = await openPage("/");
		const saved = page.waitForResponse(isSaveRequest);
		expect(await clickButton(page, ACCEPT)).toBe(true);
		expect((await saved).status()).toBe(200);
		const calls = await waitForAnalytics(page, "granted");
		expect(calls.at(-1)?.state).toMatchObject({ ad_storage: "granted", analytics_storage: "granted" });
		expect(consoleErrors).toEqual([]);
		await context.close();
	}, 60_000);

	it("after reject: the state is denied, and the Google tag is never requested", async () => {
		externalRequests.length = 0;
		const { context, page, consoleErrors } = await openPage("/");
		const saved = page.waitForResponse(isSaveRequest);
		expect(await clickButton(page, REJECT)).toBe(true);
		expect((await saved).status()).toBe(200);
		const calls = await waitForAnalytics(page, "denied");
		expect(calls.at(-1)?.state).toMatchObject({ ad_storage: "denied", analytics_storage: "denied" });
		expect(vendorCalls()).toEqual([]);
		expect(consoleErrors).toEqual([]);
		await context.close();
	}, 60_000);
});
