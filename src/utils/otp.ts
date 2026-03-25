/**
 * OTP generation and hashing utilities.
 * Uses Web Crypto API (available in Bun natively).
 */

/** Generate a cryptographically secure 6-digit OTP */
export function generateOTP(): string {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return String(arr[0] % 1000000).padStart(6, '0');
}

/** Hash an OTP with SHA-256. Returns hex string. */
export async function hashOTP(otp: string): Promise<string> {
    const data = new TextEncoder().encode(otp);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Compare a plain OTP against a stored hash */
export async function verifyOTPHash(otp: string, storedHash: string): Promise<boolean> {
    const hash = await hashOTP(otp);
    // Constant-time comparison to prevent timing attacks
    if (hash.length !== storedHash.length) return false;
    let result = 0;
    for (let i = 0; i < hash.length; i++) {
        result |= hash.charCodeAt(i) ^ storedHash.charCodeAt(i);
    }
    return result === 0;
}
