import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Explicit public, synthetic UI assets only. Never resolve a request path on disk.
// This module lives in src/ or dist/; both share the checkout's dashboard/web/.
export const dashboardWebFiles: Readonly<Record<string, { file: string; type: string }>> = Object.freeze({
  '/dashboard/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/dashboard/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/dashboard/dashboard.css': { file: 'dashboard.css', type: 'text/css; charset=utf-8' },
  '/dashboard/dashboard.js': { file: 'dashboard.js', type: 'text/javascript; charset=utf-8' },
  '/dashboard/demo-data.js': { file: 'demo-data.js', type: 'text/javascript; charset=utf-8' },
  ...Object.fromEntries([
    'logo', 'paperclip', 'perforationTop', 'perforationSide', 'grid', 'connections',
    'corner', 'folder', 'phone', 'plug', 'book', 'briefcase', 'search', 'settings',
    'doc', 'chart', 'cap', 'refresh', 'fold', 'change-dot',
  ].map(name => [`/dashboard/assets/${name}.svg`, { file: `assets/${name}.svg`, type: 'image/svg+xml' }])),
  '/dashboard/assets/roboto-cyrillic.woff2': { file: 'assets/roboto-cyrillic.woff2', type: 'font/woff2' },
  '/dashboard/assets/roboto-latin.woff2': { file: 'assets/roboto-latin.woff2', type: 'font/woff2' },
});

// CSSOM geometry updates from the local module do not require unsafe-inline.
// No inline scripts/handlers or remote assets are permitted by this policy.
export const dashboardContentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

function assetFor(rawUrl: string | undefined) {
  return rawUrl !== undefined && Object.hasOwn(dashboardWebFiles, rawUrl) ? dashboardWebFiles[rawUrl] : undefined;
}

/** Only exact, query-free GET/HEAD requests may skip database admission. */
export function isPublicDashboardRequest(req: IncomingMessage): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') &&
    (req.url === '/dashboard' || assetFor(req.url) !== undefined);
}

/** Called after the parent gateway's Host, Origin, HTTPS and admission checks. */
export async function serveDashboardWeb(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const asset = assetFor(req.url);
  const reply = (status: number, code: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ code }));
  };
  if (!asset && req.url !== '/dashboard') { reply(404, 'NOT_FOUND'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD'); reply(405, 'METHOD_NOT_ALLOWED'); return;
  }
  res.setHeader('Content-Security-Policy', dashboardContentSecurityPolicy);
  if (req.url === '/dashboard') {
    res.writeHead(308, { Location: '/dashboard/' }); res.end(); return;
  }
  const bytes = await readFile(new URL(`../dashboard/web/${asset!.file}`, import.meta.url));
  res.writeHead(200, { 'Content-Type': asset!.type, 'Content-Length': bytes.length });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}
