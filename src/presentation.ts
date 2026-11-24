/**
 * Banner layout and page rules. Pure, self-checked.
 *
 * c15t's `presentation.prompt` takes a variant and a position. We expose one
 * `bannerPosition` setting that maps onto it, so the admin picks a place, not a variant.
 */

export const BANNER_POSITIONS = [
	"bottom-left",
	"bottom-right",
	"bottom-center",
	"top-left",
	"top-right",
	"top-center",
	"bar-bottom",
	"bar-top",
] as const;
type BannerPosition = (typeof BANNER_POSITIONS)[number];
const DEFAULT_BANNER_POSITION: BannerPosition = "bottom-left";

export function isBannerPosition(value: unknown): value is BannerPosition {
	return typeof value === "string" && (BANNER_POSITIONS as readonly string[]).includes(value);
}

/** Accept and Reject are both primary, with Settings as the quiet third action (equal prominence). */
const ACTIONS = {
	primaryActions: ["accept", "reject"],
	layout: [["reject", "accept"], ["customize"]],
} as const;

/**
 * The `presentation.prompt` object for a position. `blocking` (the requireChoice
 * setting) always wins and gives a centred wall. Otherwise a floating card, or a
 * bar at the top or bottom.
 */
export function promptFor(position: string, blocking: boolean) {
	if (blocking) return { variant: "wall" as const, position: "center" as const, blocking: true, ...ACTIONS };
	const pos = isBannerPosition(position) ? position : DEFAULT_BANNER_POSITION;
	if (pos === "bar-bottom") return { variant: "bar" as const, position: "bottom" as const, blocking: false, ...ACTIONS };
	if (pos === "bar-top") return { variant: "bar" as const, position: "top" as const, blocking: false, ...ACTIONS };
	return { variant: "floating" as const, position: pos, blocking: false, ...ACTIONS };
}

/** Reopen-button corner. Follows the banner's side so the two do not sit on opposite edges. */
export function triggerPosition(position: string): "bottom-left" | "bottom-right" {
	return typeof position === "string" && position.includes("right") ? "bottom-right" : "bottom-left";
}

/**
 * True when the request path is one of the configured policy pages (privacy,
 * cookie, imprint). Those pages show no banner, so the text stays readable. The
 * reopen button still shows. Absolute and relative URLs both work.
 */
export function isPolicyPage(path: string, policyUrls: ReadonlyArray<string | undefined>): boolean {
	const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p) || "/";
	const current = norm(path);
	return policyUrls.some((u) => {
		if (typeof u !== "string" || !u.trim()) return false;
		try {
			return norm(new URL(u.trim(), "https://policy.invalid").pathname) === current;
		} catch {
			return false;
		}
	});
}
