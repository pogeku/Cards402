// Server-only helpers for the cards402 admin dashboard session.
//
// The admin UI never holds a backend Bearer token in JavaScript. Instead, on
// successful OTP verification the Next.js route handler wraps the token in an
// HMAC-signed HttpOnly cookie. Middleware and the admin-proxy route handler
// both verify the signature before trusting the token.
//
// Cookie value (base64url-encoded segments, joined with `.`):
//
//     <b64u(token)>.<expiresAt>.<b64u(hmac_sha256(`${token}.${expiresAt}`, SECRET))>
//
// The HttpOnly flag stops XSS from reading the token; the HMAC stops
// tampering with the expiry or token; the expiry bounds the blast radius of a
// cookie leak.

import crypto from 'crypto';

export const ADMIN_SESSION_COOKIE = 'cards402_admin_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface SessionPayload {
  token: string;
  expiresAt: number;
}

function b64uEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64url');
}

function b64uDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function getSessionSecret(): Buffer {
  const hex = process.env.ADMIN_SESSION_KEY;
  if (!hex) {
    throw new Error('ADMIN_SESSION_KEY is required — generate with `openssl rand -hex 32`');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('ADMIN_SESSION_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/** Sign a backend Bearer token into a cookie value with a 7-day expiry. */
export function signSession(token: string, ttlMs: number = SESSION_TTL_MS): string {
  const expiresAt = Date.now() + ttlMs;
  const secret = getSessionSecret();
  const signedPayload = `${token}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', secret).update(signedPayload).digest();
  return `${b64uEncode(token)}.${expiresAt}.${b64uEncode(sig)}`;
}

/** Verify a cookie value. Returns the session payload if valid, else null. */
export function verifySession(cookieValue: string | undefined | null): SessionPayload | null {
  if (!cookieValue) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 3) return null;
  const [tokB64, expStr, sigB64] = parts;
  if (!tokB64 || !expStr || !sigB64) return null;

  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  let token: string;
  let providedSig: Buffer;
  try {
    token = b64uDecode(tokB64).toString('utf8');
    providedSig = b64uDecode(sigB64);
  } catch {
    return null;
  }

  const secret = getSessionSecret();
  const expectedSig = crypto.createHmac('sha256', secret).update(`${token}.${expiresAt}`).digest();
  if (providedSig.length !== expectedSig.length) return null;
  try {
    if (!crypto.timingSafeEqual(providedSig, expectedSig)) return null;
  } catch {
    return null;
  }

  return { token, expiresAt };
}

/**
 * Resolve the upstream cards402 backend URL from env. Prefers
 * `CARDS402_BACKEND_URL` (server-only) and falls back to
 * `NEXT_PUBLIC_API_BASE_URL` so existing deployments keep working without a
 * new env var. Throws on missing in production.
 */
export function getBackendBaseUrl(): string {
  const url = process.env.CARDS402_BACKEND_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!url) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CARDS402_BACKEND_URL (or NEXT_PUBLIC_API_BASE_URL) is required');
    }
    return 'http://localhost:4000';
  }
  return url.replace(/\/$/, '');
}
