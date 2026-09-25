// api/login.js — Vercel Serverless Function (Node Runtime)
// POST /api/login  { email, password }
//
// Verifica contra variáveis de ambiente (NUNCA expostas ao navegador) e,
// se corretas, define um cookie de sessão assinado (HttpOnly) que a
// middleware.js valida em toda navegação.
//
// Variáveis de ambiente exigidas (Vercel → Project → Settings → Environment Variables):
//   AUTH_EMAIL          e-mail autorizado a logar
//   AUTH_PASSWORD_HASH  sha256 hex da senha (nunca a senha em texto puro)
//   AUTH_SECRET         segredo aleatório usado para assinar o cookie de sessão

import { webcrypto } from 'node:crypto';
import { signSession, sha256Hex, timingSafeEqual } from './_lib/auth.js';

const cryptoImpl = globalThis.crypto ?? webcrypto;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const COOKIE_NAME = 'dash_session';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authEmail = (process.env.AUTH_EMAIL || '').trim().toLowerCase();
  const authPasswordHash = (process.env.AUTH_PASSWORD_HASH || '').trim().toLowerCase();
  const authSecret = process.env.AUTH_SECRET || '';

  if (!authEmail || !authPasswordHash || !authSecret) {
    return res.status(500).json({
      error: 'Login não configurado. Defina AUTH_EMAIL, AUTH_PASSWORD_HASH e AUTH_SECRET nas env vars da Vercel.',
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const passwordHash = await sha256Hex(password, cryptoImpl);

  const emailOk = timingSafeEqual(email, authEmail);
  const passwordOk = timingSafeEqual(passwordHash, authPasswordHash);

  if (!emailOk || !passwordOk) {
    return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  }

  const token = await signSession(authSecret, SESSION_TTL_MS, cryptoImpl);
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);

  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
  return res.status(200).json({ ok: true });
}
