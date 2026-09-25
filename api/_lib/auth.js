// api/_lib/auth.js
// Funções de sessão e hash compartilhadas entre a middleware (Edge Runtime)
// e a function de login (Node Runtime). Usa só Web Crypto (crypto.subtle),
// sem Buffer nem pacotes externos, para funcionar nos dois runtimes.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret, cryptoImpl) {
  return cryptoImpl.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signSession(secret, ttlMs, cryptoImpl = globalThis.crypto) {
  const payloadB64 = bytesToBase64url(encoder.encode(JSON.stringify({ exp: Date.now() + ttlMs })));
  const key = await hmacKey(secret, cryptoImpl);
  const sig = await cryptoImpl.subtle.sign('HMAC', key, encoder.encode(payloadB64));
  return `${payloadB64}.${bytesToBase64url(new Uint8Array(sig))}`;
}

export async function verifySession(secret, token, cryptoImpl = globalThis.crypto) {
  if (!token || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  try {
    const key = await hmacKey(secret, cryptoImpl);
    const valid = await cryptoImpl.subtle.verify(
      'HMAC',
      key,
      base64urlToBytes(sigB64),
      encoder.encode(payloadB64)
    );
    if (!valid) return false;
    const payload = JSON.parse(decoder.decode(base64urlToBytes(payloadB64)));
    return typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

export async function sha256Hex(text, cryptoImpl = globalThis.crypto) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
