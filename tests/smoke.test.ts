import { afterEach, expect, it } from "vitest";
import { SAME_ORIGIN, call, createRuntime, exportRows, savePayload, type Runtime } from "./support/harness.js";

const open: Runtime[] = [];
afterEach(async () => {
	await Promise.all(open.splice(0).map((r) => r.shutdown()));
});

it("boots the runtime and round-trips one consent save", async () => {
	const runtime = await createRuntime();
	open.push(runtime);
	const res = await call(runtime, "save", { method: "POST", body: savePayload(), headers: SAME_ORIGIN });
	const text = await res.text();
	expect({ status: res.status, text }).toEqual({ status: 200, text: expect.any(String) });
	const rows = await exportRows(runtime);
	expect(rows).toHaveLength(1);
});
