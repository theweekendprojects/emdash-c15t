/**
 * Owner download links for the consent export.
 *
 * A browser cannot follow a link to an admin route: EmDash requires the `X-EmDash-Request` header there, and a
 * navigation cannot send it. So the admin page links to a public route instead, and the link carries its own proof:
 * `from`, `to`, `exp` (unix seconds) and `sig`, an HMAC-SHA256 over those values with a secret only this site holds.
 * A link expires after LINK_TTL_SECONDS, and changing any value breaks the signature. Pure apart from WebCrypto.
 */

/** The public route that serves a signed export. */
export const DOWNLOAD_ROUTE = "consent-download";
export const LINK_TTL_SECONDS = 15 * 60;

const SECRET_KEY = "export-secret";
const HEX_64 = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

/** The part of the plugin KV store this module needs. */
export interface KvLike {
	get<T>(key: string): Promise<T | null>;
	compareAndSet(key: string, expectedRevision: string | null, value: unknown): Promise<{ applied: boolean }>;
}

/** A copy in a fresh ArrayBuffer, which the WebCrypto types require. */
function bytesOf(text: string): Uint8Array<ArrayBuffer> {
	const encoded = encoder.encode(text);
	const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
	out.set(encoded);
	return out;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** The exact bytes that are signed. The version prefix keeps a future format from matching an old signature. */
function signedBytes(from: string, to: string, exp: number): Uint8Array<ArrayBuffer> {
	return bytesOf(`v1|${from}|${to}|${exp}`);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** The site's signing secret. Created once, on first use, and kept in plugin KV. */
export async function exportSecret(kv: KvLike): Promise<string> {
	const stored = await kv.get<string>(SECRET_KEY);
	if (typeof stored === "string" && HEX_64.test(stored)) return stored;
	const fresh = toHex(crypto.getRandomValues(new Uint8Array(32)));
	// A null expected revision creates only when absent, so two first renders cannot store two different secrets.
	const written = await kv.compareAndSet(SECRET_KEY, null, fresh);
	if (written.applied) return fresh;
	const winner = await kv.get<string>(SECRET_KEY);
	if (typeof winner === "string" && HEX_64.test(winner)) return winner;
	throw new Error("export secret is unavailable");
}

/** The query string for a link that is valid from `nowSec` for LINK_TTL_SECONDS. `from` and `to` are raw, as typed. */
export async function exportLinkQuery(secret: string, input: { from?: string; to?: string }, nowSec: number): Promise<string> {
	const from = input.from ?? "";
	const to = input.to ?? "";
	const exp = nowSec + LINK_TTL_SECONDS;
	const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), signedBytes(from, to, exp));
	const params = new URLSearchParams();
	if (from) params.set("from", from);
	if (to) params.set("to", to);
	params.set("exp", String(exp));
	params.set("sig", toHex(new Uint8Array(sig)));
	return params.toString();
}

export type LinkCheck = { ok: true } | { ok: false; reason: string };

const INVALID = "This download link is not valid.";

/** Accepts a link only if its signature matches, it has not expired, and its expiry is one this site could have issued. */
export async function checkExportLink(secret: string, params: URLSearchParams, nowSec: number): Promise<LinkCheck> {
	const exp = Number(params.get("exp"));
	const sig = params.get("sig") ?? "";
	if (!Number.isInteger(exp) || !HEX_64.test(sig)) return { ok: false, reason: INVALID };
	if (exp < nowSec) return { ok: false, reason: "This download link has expired. Create a new one on the Privacy settings page." };
	// A link this site issued expires at most LINK_TTL_SECONDS ahead. The margin allows for a little clock drift.
	if (exp > nowSec + LINK_TTL_SECONDS + 60) return { ok: false, reason: INVALID };
	const valid = await crypto.subtle.verify(
		"HMAC",
		await hmacKey(secret),
		fromHex(sig),
		signedBytes(params.get("from") ?? "", params.get("to") ?? "", exp),
	);
	return valid ? { ok: true } : { ok: false, reason: INVALID };
}
