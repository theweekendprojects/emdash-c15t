/**
 * The site id stored with each consent record and used to filter the export: the host of the site URL, or of the
 * request when the site URL is missing or empty. `||` (not `??`): an empty site URL is common on multi-site hosts.
 * Pure, self-checked through the review tests.
 */
export function siteIdFrom(siteUrl: string | undefined, requestUrl: string | undefined): string {
	for (const candidate of [siteUrl, requestUrl]) {
		if (!candidate) continue;
		try {
			return new URL(candidate).hostname;
		} catch {
			/* not a URL: try the next candidate */
		}
	}
	return "unknown";
}
