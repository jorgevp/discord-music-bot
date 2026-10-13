import http from 'node:http';
import net from 'node:net';
import { VIEWER_PORT, VIEWER_PREFIX, loginBrowserHost } from '../sources/youtubeLogin.js';
import { isAllowedOrigin, isAuthenticatedCookieHeader } from './auth.js';

// Proxies the sign-in browser's noVNC viewer (HTTP + WebSocket) behind the dashboard's own sign-in, so the
// browser container never needs a published port. The dashboard session cookie is not forwarded.

const STRIPPED_HEADERS = new Set(['cookie', 'authorization', 'host']);

export function loginViewerHttp(req, res) {
  const host = loginBrowserHost();
  if (!host) return res.status(404).type('text').send('The sign-in browser is not set up.');
  if (!isAuthenticatedCookieHeader(req.headers.cookie)) return res.status(401).type('text').send('Sign in to the dashboard first.');

  const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !STRIPPED_HEADERS.has(name)));
  headers.host = `${host}:${VIEWER_PORT}`;
  const upstream = http.request({ host, port: VIEWER_PORT, method: req.method, path: req.url, headers }, (response) => {
    res.writeHead(response.statusCode, {
      ...response.headers,
      'x-frame-options': 'SAMEORIGIN',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'cache-control': 'no-store',
    });
    response.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).type('text').send('The sign-in browser is not reachable.');
    else res.destroy();
  });
  req.pipe(upstream);
}

/** Handles WebSocket upgrades for the viewer. Returns false for paths it doesn't own. */
export function handleLoginViewerUpgrade(req, socket, head) {
  if (!req.url.startsWith(`${VIEWER_PREFIX}/`)) return false;
  const host = loginBrowserHost();
  if (!host || !isAuthenticatedCookieHeader(req.headers.cookie) || !isAllowedOrigin(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return true;
  }

  const upstream = net.connect(VIEWER_PORT, host, () => {
    const lines = [`${req.method} ${req.url.slice(VIEWER_PREFIX.length)} HTTP/1.1`, `Host: ${host}:${VIEWER_PORT}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!STRIPPED_HEADERS.has(req.rawHeaders[i].toLowerCase())) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on('error', close);
  upstream.on('close', close);
  socket.on('error', close);
  socket.on('close', close);
  return true;
}
