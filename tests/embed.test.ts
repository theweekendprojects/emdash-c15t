/**
 * Builds a fixture page with the repo's own Astro and checks what ConsentEmbed renders: gated iframes
 * with data-src and c15t categories, no bare src, and an error state for an invalid ID.
 */
import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const FIXTURE = fileURLToPath(new URL("./fixtures/embed", import.meta.url));
const ASTRO = fileURLToPath(new URL("../node_modules/astro/bin/astro.mjs", import.meta.url));

describe("ConsentEmbed in an Astro build", () => {
	it("renders gated iframes and an error for a malformed ID", async () => {
		rmSync(`${FIXTURE}/dist`, { recursive: true, force: true });
		await run(process.execPath, [ASTRO, "build", "--root", FIXTURE], { timeout: 180_000 });
		const html = readFileSync(`${FIXTURE}/dist/index.html`, "utf8");

		// Both valid embeds are gated: data-src holds the URL, and no iframe has a bare src.
		expect(html).toContain('data-src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?playsinline=1"');
		expect(html).toContain('data-src="https://player.vimeo.com/video/123456789"');
		expect(html).not.toMatch(/<iframe[^>]* src=/);
		// Categories map to c15t names: YouTube defaults to marketing, Vimeo was set to analytics (= measurement).
		expect(html).toContain('data-category="marketing"');
		expect(html).toContain('data-category="measurement"');
		// Each valid embed has its own placeholder button that opens the preference dialog.
		expect(html.match(/data-emdash-privacy-open/g)).toHaveLength(2);
		// The malformed ID renders the error text and no iframe for itself.
		expect(html).toContain("emdash-privacy-invalid");
		expect(html.match(/<iframe/g)).toHaveLength(2);
	}, 240_000);
});
