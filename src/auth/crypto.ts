/**
 * Password hashing primitives for recipient accounts (#18). PBKDF2-HMAC-SHA256 via
 * WebCrypto (available in the Workers runtime, no external deps). Iteration count of
 * 600,000 follows the current OWASP Password Storage Cheat Sheet recommendation for
 * PBKDF2-HMAC-SHA256 (as of 2025 revision: "PBKDF2-HMAC-SHA256 ... 600,000 iterations"),
 * chosen over the older 310,000 minimum since this Worker has no legacy-hardware
 * constraint. Never a bare/fast hash (no SHA-256 alone, no MD5) and never plaintext.
 */

export const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16; // >= 16 bytes per spec requirement
const DERIVED_KEY_BITS = 256;

export interface PasswordHash {
	algorithm: "PBKDF2-HMAC-SHA256";
	iterations: number;
	salt: string; // hex-encoded, random per user
	hash: string; // hex-encoded derived key
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return Array.from(view)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function fromHex(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error("invalid hex string");
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

/**
 * Constant-time byte comparison. Never use `===`/naive string compare on secret
 * material (hashes, HMAC signatures) — a short-circuiting compare leaks timing
 * information proportional to the number of matching leading bytes.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a[i] ^ b[i];
	}
	return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
		keyMaterial,
		DERIVED_KEY_BITS,
	);
	return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations: number = PBKDF2_ITERATIONS): Promise<PasswordHash> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const derived = await pbkdf2(password, salt, iterations);
	return {
		algorithm: "PBKDF2-HMAC-SHA256",
		iterations,
		salt: toHex(salt),
		hash: toHex(derived),
	};
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
	const derived = await pbkdf2(password, fromHex(stored.salt), stored.iterations);
	const expected = fromHex(stored.hash);
	return timingSafeEqual(derived, expected);
}

/**
 * A fixed decoy hash with the SAME cost parameters (iterations, salt length) as a
 * real stored hash. It is a genuine PBKDF2 derivation of an unknowable random
 * password, so no attacker-supplied password can ever match it. Used by
 * verifyPasswordConstantTime to spend one full PBKDF2 on the "no such user" path,
 * keeping login response timing independent of whether the username exists.
 */
export const DECOY_PASSWORD_HASH: PasswordHash = {
	algorithm: "PBKDF2-HMAC-SHA256",
	iterations: PBKDF2_ITERATIONS,
	salt: "bb980c83452ee2c32235f2fe2afe6bfd",
	hash: "929fb668da627cf9deb71d69d23d64062c7f2f6cdd857e687578962a3ded9d90",
};

/**
 * Verifies a password while doing the SAME observable work whether or not the
 * account exists. When `stored` is null (username not found), the verify runs
 * against DECOY_PASSWORD_HASH so exactly one full-cost PBKDF2 is performed on
 * every path — closing the username-enumeration timing side-channel. A missing
 * account always returns false regardless of the (never-matching) decoy result.
 */
export async function verifyPasswordConstantTime(password: string, stored: PasswordHash | null): Promise<boolean> {
	const valid = await verifyPassword(password, stored ?? DECOY_PASSWORD_HASH);
	return stored !== null && valid;
}

export { toHex, fromHex };
