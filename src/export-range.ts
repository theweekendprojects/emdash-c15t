/**
 * `from` and `to` for the CSV export. Pure, self-checked.
 *
 * Both are optional dates or timestamps: `2026-01-01`, `2026-01-01T12:00:00Z`. `from` is inclusive, `to` is exclusive,
 * so consecutive ranges (`to=X` then `from=X`) neither overlap nor leave a gap. A bad value is an error and is never
 * ignored: an ignored `from` would silently export more than the admin asked for.
 */

export interface ExportRange {
	from?: number;
	to?: number;
}

/** Parses a date or timestamp to epoch ms, or null when it is not a real instant (`2026-13-45` is not). */
export function parseInstant(value: string): number | null {
	const text = value.trim();
	// Only ISO 8601 calendar dates and date-times. Date.parse accepts far looser strings, and across engines differently.
	if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) return null;
	const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text.replace(" ", "T") : `${text.replace(" ", "T")}Z`;
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return null;
	// Date.parse rolls an impossible day over (Feb 30 -> Mar 2). Reject it by checking the calendar date round-trips.
	const day = text.slice(0, 10);
	if (new Date(Date.parse(`${day}T00:00:00Z`)).toISOString().slice(0, 10) !== day) return null;
	return at;
}

/** Reads `from` and `to` from a query string. Returns the range, or an error message. */
export function parseExportRange(search: URLSearchParams): ExportRange | string {
	const range: ExportRange = {};
	for (const key of ["from", "to"] as const) {
		const raw = search.get(key);
		if (raw === null || raw === "") continue;
		const at = parseInstant(raw);
		if (at === null) return `${key} must be an ISO date or date-time such as 2026-01-31 or 2026-01-31T12:00:00Z.`;
		range[key] = at;
	}
	if (range.from !== undefined && range.to !== undefined && range.from >= range.to) return "from must be earlier than to.";
	return range;
}

/** The storage `where` clause for a range. `ts` is indexed. */
export function rangeWhere(range: ExportRange): Record<string, { gte?: number; lt?: number }> {
	const ts: { gte?: number; lt?: number } = {};
	if (range.from !== undefined) ts.gte = range.from;
	if (range.to !== undefined) ts.lt = range.to;
	return Object.keys(ts).length ? { ts } : {};
}
