/**
 * CSV for the admin consent export. Pure, self-checked.
 *
 * Columns are the proof fields only: no IP, user agent, e-mail, name or country.
 * Every cell is quoted, embedded quotes are doubled, line breaks are flattened, and
 * a cell that starts like a spreadsheet formula gets a leading `'` so Excel and
 * Sheets show it as text.
 */

const CONSENT_CSV_COLUMNS = [
	"createdAt",
	"policyVersion",
	"bannerVersion",
	"action",
	"necessary",
	"measurement",
	"marketing",
	"subjectId",
	"siteId",
] as const;

/** One stored consent record, as written by the `save` route. */
export interface ConsentRecord {
	ts: number;
	policyVersion: string;
	bannerVersion: string;
	action: string;
	grants: Record<string, boolean>;
	subjectId: string;
	/** The hostname the record was saved under. A label only: plugin storage is already per site. */
	siteId?: string;
}

export function csvCell(value: unknown): string {
	let text = value === null || value === undefined ? "" : String(value);
	text = text.replace(/\r\n|\n|\r/g, " ");
	if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
	return `"${text.replace(/"/g, '""')}"`;
}

export function csvHeaderLine(): string {
	return CONSENT_CSV_COLUMNS.map(csvCell).join(",");
}

export function consentCsvLine(record: ConsentRecord): string {
	const date = new Date(record.ts);
	const created = Number.isNaN(date.getTime()) ? "" : date.toISOString();
	const grant = (k: string) => (record.grants?.[k] === true ? "true" : "false");
	return [
		created,
		record.policyVersion,
		record.bannerVersion,
		record.action,
		grant("necessary"),
		grant("measurement"),
		grant("marketing"),
		record.subjectId,
		record.siteId ?? "",
	]
		.map(csvCell)
		.join(",");
}
