/**
 * JWT auth middleware and token signing helpers.
 *
 * Uses Hono's built-in JWT — no extra packages needed.
 *
 * Token types:
 *   otpToken   — issued after OTP sent, carries phone + Omada params (5 min)
 *   authToken  — issued after OTP verified, carries userId + Omada params (10 min)
 *   adminToken — issued after admin login (24 hr)
 */

import { sign, verify } from 'hono/jwt';
import { jwt } from 'hono/jwt';
import type { Context, Next } from 'hono';

// ────────────────────────────────────────────
// Token payload types
// ────────────────────────────────────────────

export interface OtpTokenPayload {
    phone: string;
    clientMac: string;
    apMac: string;
    ssid: string;
    radioId: number;
    redirectUrl: string;
    exp: number;
}

export interface AuthTokenPayload {
    userId: string;
    phone: string;
    clientMac: string;
    apMac: string;
    ssid: string;
    radioId: number;
    redirectUrl: string;
    exp: number;
}

export interface AdminTokenPayload {
    role: 'admin';
    exp: number;
}

// ────────────────────────────────────────────
// Sign tokens
// ────────────────────────────────────────────

/** Sign an OTP token (5 min expiry). Issued after OTP is sent. */
export async function signOtpToken(payload: {
    phone: string;
    clientMac: string;
    apMac: string;
    ssid: string;
    radioId: number;
    redirectUrl: string;
}): Promise<string> {
    const expiry = Number(process.env.JWT_OTP_EXPIRY_SECONDS) || 300;
    return sign(
        { ...payload, exp: Math.floor(Date.now() / 1000) + expiry },
        process.env.JWT_SECRET!
    );
}

/** Sign an auth token (10 min expiry). Issued after OTP is verified. */
export async function signAuthToken(payload: {
    userId: string;
    phone: string;
    clientMac: string;
    apMac: string;
    ssid: string;
    radioId: number;
    redirectUrl: string;
}): Promise<string> {
    const expiry = Number(process.env.JWT_AUTH_EXPIRY_SECONDS) || 600;
    return sign(
        { ...payload, exp: Math.floor(Date.now() / 1000) + expiry },
        process.env.JWT_SECRET!
    );
}

/** Sign an admin token (24 hr expiry). Issued after admin login. */
export async function signAdminToken(): Promise<string> {
    return sign(
        { role: 'admin', exp: Math.floor(Date.now() / 1000) + 86400 },
        process.env.ADMIN_JWT_SECRET!
    );
}

// ────────────────────────────────────────────
// Verify tokens manually (for routes that don't use middleware)
// ────────────────────────────────────────────

/** Verify and decode an OTP token */
export async function verifyOtpToken(token: string): Promise<OtpTokenPayload> {
    return verify(token, process.env.JWT_SECRET!, 'HS256') as Promise<OtpTokenPayload>;
}

/** Verify and decode an auth token */
export async function verifyAuthToken(token: string): Promise<AuthTokenPayload> {
    return verify(token, process.env.JWT_SECRET!, 'HS256') as Promise<AuthTokenPayload>;
}

// ────────────────────────────────────────────
// Hono middleware factories
// ────────────────────────────────────────────

/** Middleware: protects routes requiring auth token (after OTP verified) */
export const authMiddleware = (c: Context, next: Next) => {
    const mw = jwt({
        secret: process.env.JWT_SECRET!,
        alg: 'HS256',
    });
    return mw(c, next);
};

/** Middleware: protects admin routes */
export const adminMiddleware = (c: Context, next: Next) => {
    const mw = jwt({
        secret: process.env.ADMIN_JWT_SECRET!,
        alg: 'HS256',
    });
    return mw(c, next);
};
