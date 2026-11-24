/**
 * Runs the plugin in a real EmDash runtime (trusted, in-process) against an in-memory
 * SQLite database, and dispatches HTTP-shaped requests through EmDash's own route
 * dispatcher. Same approach EmDash's core tests use for trusted plugins.
 */
import { randomUUID } from "node:crypto";
import { SqliteDialect } from "kysely";
import { EmDashRuntime, dispatchPluginApiRequest } from "emdash/internal/plugin-test-runtime";
import plugin from "../../src/index.js";
import { PLUGIN_ID } from "../../src/shared.js";
import { MemorySqlite } from "./sqlite.js";

export const SITE = "https://site.example";

/** An EmDash admin (role 50). Private routes need plugins:manage, which admins have. */
export const ADMIN = {
	id: "admin-1",
	email: "admin@site.example",
	name: "Admin",
	role: 50,
	createdAt: new Date(0).toISOString(),
} as const;

/** A subscriber (role 10). Must be refused on admin routes. */
export const SUBSCRIBER = { ...ADMIN, id: "sub-1", role: 10 } as const;

export type Runtime = Awaited<ReturnType<typeof createRuntime>>;

/** The SQLite handle of the most recently created runtime, for tests that inspect or seed raw rows. */
let lastDb: MemorySqlite | undefined;

export function rawDb(): MemorySqlite {
	if (!lastDb) throw new Error("no runtime created yet");
	return lastDb;
}

export async function createRuntime(siteUrl = SITE) {
	return EmDashRuntime.create({
		config: { database: { entrypoint: randomUUID(), config: {}, type: "sqlite" } },
		plugins: [plugin],
		createDialect: () => {
			lastDb = new MemorySqlite();
			return new SqliteDialect({ database: lastDb as never });
		},
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
		siteInfo: { url: siteUrl, name: "Test site", locale: "en" },
	} as never);
}

interface CallOptions {
	method?: string;
	body?: unknown;
	headers?: Record<string, string>;
	user?: typeof ADMIN | typeof SUBSCRIBER | null;
}

/** Calls a plugin route through EmDash's dispatcher, the same path a browser request takes. */
export function call(runtime: Runtime, route: string, options: CallOptions = {}): Promise<Response> {
	const method = options.method ?? "GET";
	const url = `${SITE}/_emdash/api/plugins/${PLUGIN_ID}/${route}`;
	const hasBody = options.body !== undefined;
	const request = new Request(url, {
		method,
		headers: {
			...(hasBody ? { "content-type": "application/json" } : {}),
			...options.headers,
		},
		body: hasBody ? JSON.stringify(options.body) : undefined,
	});
	return dispatchPluginApiRequest({
		runtime,
		pluginId: PLUGIN_ID,
		path: `/${route}`,
		request,
		user: options.user === undefined ? undefined : (options.user as never),
	}) as Promise<Response>;
}

/** Headers a real browser sends with a same-origin POST from the site. */
export const SAME_ORIGIN = { origin: SITE };

/** A consent save body as the browser sends it (see client/banner.ts). */
export function savePayload(overrides: Record<string, unknown> = {}) {
	return {
		subjectId: "sub_test_1",
		action: "all",
		grants: { necessary: true, measurement: true, marketing: true },
		givenAt: Date.now(),
		policyVersion: "1",
		bannerVersion: "2",
		...overrides,
	};
}

/** Admin route call with the headers EmDash requires for a private route. */
export function adminCall(runtime: Runtime, body: unknown, user: typeof ADMIN | typeof SUBSCRIBER | null = ADMIN) {
	return call(runtime, "admin", {
		method: "POST",
		body,
		user,
		headers: { "X-EmDash-Request": "1" },
	});
}

/** Reads consent records the only way a test should: through the admin CSV export. */
export async function exportRows(runtime: Runtime): Promise<string[][]> {
	const res = await call(runtime, "consent-export", {
		user: ADMIN,
		headers: { "X-EmDash-Request": "1" },
	});
	if (res.status !== 200) throw new Error(`export failed: ${res.status} ${await res.text()}`);
	const lines = (await res.text()).trim().split("\r\n");
	return lines.slice(1).map((line) => line.split('","').map((cell) => cell.replace(/^"|"$/g, "")));
}

/** Calls page:fragments for a public page. */
export function fragmentsFor(runtime: Runtime, path: string, locale: string | null = "en") {
	return runtime.collectPageFragments({
		url: `${SITE}${path}`,
		path,
		locale,
		kind: "content",
		pageType: "page",
		title: null,
		description: null,
		canonical: null,
		image: null,
	} as never);
}
