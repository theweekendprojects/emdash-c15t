import type { PluginContext } from "emdash";

/**
 * Reads all of this plugin's settings in one storage query. `ctx.settings.list()` returns the values keyed relative
 * to the plugin's settings prefix (`plugin:<id>:settings:<key>`). One call replaces a query per setting on every
 * public render and every admin page load. Pure apart from the context it is given.
 */
export async function readAllSettings(ctx: PluginContext): Promise<Record<string, unknown>> {
	const rows: Array<{ key: string; value: unknown }> = await ctx.settings.list();
	return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
