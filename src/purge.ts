/**
 * Retention purge: delete consent records older than `retentionMonths`.
 * Used by the daily cron hook, by the lazy purge in `/save`, and by the admin "delete expired now" button.
 */
import type { PluginContext } from "emdash";
import { SETTINGS_DEFAULTS } from "./shared.js";

export const DAY_MS = 86_400_000;

/**
 * EmDash caps a storage query page at 100 rows (`QueryOptions.limit`: "Default 50, max 100"). Asking for more
 * silently returns 100, so a larger page size would delete less than it reports.
 */
export const PURGE_PAGE_SIZE = 100;

/** Pages per run. The cron and admin paths clear up to 5 000 rows per run. */
const PURGE_MAX_PAGES = 50;

/** Pages the lazy purge inside `/save` may take. It runs in a visitor's request, so it stays small: 2 000 rows. */
export const LAZY_PURGE_MAX_PAGES = 20;

/** True when a lazy purge is due: never run, or last run over a day ago. Pure; self-checked. */
export function purgeDue(last: unknown, now: number): boolean {
	const at = last && typeof last === "object" ? (last as { at?: unknown }).at : undefined;
	return typeof at !== "number" || !Number.isFinite(at) || now - at >= DAY_MS;
}

/** Cutoff timestamp (epoch ms) for a retention period in months. Pure; self-checked. */
export function retentionCutoff(now: number, months: unknown): number {
	const m = typeof months === "number" && Number.isFinite(months) && months > 0 ? months : SETTINGS_DEFAULTS.retentionMonths;
	return now - m * 30 * DAY_MS;
}

/**
 * Deletes expired records, up to `maxPages` pages of `PURGE_PAGE_SIZE`. Returns how many were deleted.
 * Each page is read from the start again, because the rows just deleted are no longer there. That needs no cursor.
 */
export async function purgeExpired(ctx: PluginContext, maxPages = PURGE_MAX_PAGES): Promise<number> {
	const months = (await ctx.kv.get("settings:retentionMonths")) as number | null;
	const cutoff = retentionCutoff(Date.now(), months);
	let deleted = 0;
	for (let i = 0; i < maxPages; i++) {
		// No orderBy: a JSON orderBy defeats the index and re-sorts every match on each page. Order does not matter for a delete.
		const res = await ctx.storage.consents.query({
			where: { ts: { lt: cutoff } },
			limit: PURGE_PAGE_SIZE,
		});
		if (!res.items.length) break;
		await ctx.storage.consents.deleteMany(res.items.map((it) => it.id));
		deleted += res.items.length;
		if (!res.hasMore) break;
	}
	return deleted;
}
