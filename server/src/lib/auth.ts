import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './env';

const encoder = new TextEncoder();

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function toBase64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const decoder = new TextDecoder();

export async function signToken(secret: string): Promise<string> {
  const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 });
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return toBase64Url(encoder.encode(payload)) + '.' + toBase64Url(sig);
}

export async function verifyToken(token: string, secret: string): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  try {
    const payloadBytes = fromBase64Url(parts[0]);
    const payload = decoder.decode(payloadBytes);
    const sig = fromBase64Url(parts[1]);
    const key = await getKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key, sig, payloadBytes);
    if (!valid) return false;

    const data = JSON.parse(payload);
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}

export const requireAuth = createMiddleware<{ Bindings: AppEnv }>(async (c, next) => {
  const token = getCookie(c, 'save_session');
  if (!token || !(await verifyToken(token, c.env.AUTH_SECRET))) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  await next();
});
