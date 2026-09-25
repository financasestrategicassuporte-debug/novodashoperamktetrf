// middleware.js — Vercel Edge Middleware
// Protege TODO o site (dashboard + rotas /api/data, /api/webinar-*) atrás
// de login. Roda antes de servir index.html ou qualquer function.
//
// Variável de ambiente exigida: AUTH_SECRET (mesma usada em api/login.js).

import { verifySession } from './api/_lib/auth.js';

export const config = {
  matcher: ['/((?!api/login|login\\.html|favicon\\.ico).*)'],
};

const COOKIE_NAME = 'dash_session';

export default async function middleware(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  const token = match ? decodeURIComponent(match[1]) : null;

  const authenticated = await verifySession(process.env.AUTH_SECRET, token);
  if (authenticated) {
    return; // sessão válida — deixa passar para o recurso pedido
  }

  const loginUrl = new URL('/login.html', request.url);
  return Response.redirect(loginUrl, 307);
}
