/**
 * Builds embed URLs from a provider and a video ID. The URL is never taken from
 * content, so an editor cannot point an embed at an arbitrary host. Pure, self-checked.
 */

export const EMBED_PROVIDERS = ["youtube", "vimeo"] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

const PATTERNS: Record<EmbedProvider, RegExp> = {
	youtube: /^[A-Za-z0-9_-]{11}$/,
	vimeo: /^\d{5,12}$/,
};

/** Returns the embed URL, or null when the provider is unknown or the ID is malformed. */
export function embedUrl(provider: unknown, id: unknown): string | null {
	if (typeof provider !== "string" || typeof id !== "string") return null;
	if (!(EMBED_PROVIDERS as readonly string[]).includes(provider)) return null;
	const p = provider as EmbedProvider;
	const value = id.trim();
	if (!PATTERNS[p].test(value)) return null;
	return p === "youtube"
		? `https://www.youtube-nocookie.com/embed/${value}?playsinline=1`
		: `https://player.vimeo.com/video/${value}`;
}
