/**
 * Request and output guards for the public consent routes. Pure, self-checked.
 */

/**
 * Same-origin check for the state-changing `save` route. Astro's checkOrigin only
 * covers form content types, and this route takes JSON, so we check it here.
 *
 * Allowed when the request's Origin is the origin the request was addressed to
 * (`requestUrl`) or the site's configured origin (`siteUrl`). The second case covers
 * a site reached through a second hostname. With no Origin header we fall back to
 * `Sec-Fetch-Site`, and only `same-origin` passes (`none` is a typed URL, never a
 * script POST). A request with neither header is refused: browsers send one of
 * them on a POST, so this only affects non-browser clients.
 */
export function isSameOriginRequest(
	headers: Record<string, string | undefined>,
	requestUrl: string,
	siteUrl: string | undefined,
): boolean {
	const origin = header(headers, "origin");
	const allowed = new Set<string>();
	for (const u of [requestUrl, siteUrl]) {
		try {
			if (u) allowed.add(new URL(u).origin);
		} catch {
			/* ignore an unparseable URL; the other one may still match */
		}
	}
	if (origin !== undefined) {
		return origin !== "null" && allowed.has(origin);
	}
	const fetchSite = header(headers, "sec-fetch-site");
	if (fetchSite !== undefined) return fetchSite === "same-origin";
	return false;
}

function header(headers: Record<string, string | undefined>, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower && typeof value === "string") return value;
	}
	return undefined;
}

/**
 * JSON for an inline `<script>`. A `</script>` or `<!--` inside a string would
 * otherwise end the script early, so `<` and the two line separators are escaped.
 * Admin-entered service names and URLs pass through here.
 */
export function safeInlineJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}
