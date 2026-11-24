import { isBuiltin } from "node:module";
import { defineConfig } from "vitest/config";

/**
 * EmDash's runtime imports `virtual:emdash/*` modules that only exist inside an Astro build.
 * The tests run the plugin in a plain Node runtime, so these stubs stand in for them. The
 * same stubs EmDash's own core tests use (packages/core/vitest.config.ts), for a Node build
 * with no cache, scheduler or Cloudflare bindings.
 */
const virtualStubs: Record<string, string> = {
	"virtual:emdash/wait-until": "export const waitUntil = undefined;",
	"virtual:emdash/scheduler": "export const createScheduler = null;",
	"virtual:emdash/object-cache": "export const createObjectCache = undefined; export const objectCacheConfig = {};",
	"virtual:emdash/rooms": "export const createRoomHost = null;",
	"virtual:emdash/config": "export default {};",
	"virtual:emdash/env": "export const env = undefined;",
	"virtual:emdash/build": "export const buildTime = 0;",
};

export default defineConfig({
	plugins: [
		{
			// node:sqlite is a prefix-only builtin, which Vitest would otherwise try to bundle.
			name: "emdash-node-builtins",
			enforce: "pre",
			resolveId(id) {
				return isBuiltin(id) ? { id, external: true } : null;
			},
		},
		{
			name: "emdash-virtual-stubs",
			resolveId(id) {
				if (Object.hasOwn(virtualStubs, id)) return "\0" + id;
				return null;
			},
			load(id) {
				if (!id.startsWith("\0virtual:emdash/")) return null;
				const key = id.slice(1);
				return Object.hasOwn(virtualStubs, key) ? virtualStubs[key] : null;
			},
		},
	],
	// Inline EmDash so the virtual-module stubs above also apply to its imports.
	ssr: { noExternal: ["emdash"] },
	test: {
		server: { deps: { inline: [/emdash/] } },
		environment: "node",
		include: ["tests/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
