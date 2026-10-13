import fs from 'node:fs';
import { COOKIES_PATH } from '../config.js';
import { UserError } from '../util.js';

const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';
// Cookies that only exist when a Google account is signed in.
const AUTH_COOKIES = new Set(['LOGIN_INFO', 'SID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', '__Secure-3PAPISID']);

function parseNetscape(text) {
  const cookies = [];
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    else if (line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length < 7) continue;
    const [domain, , pathField, secure, expires, name, ...valueParts] = fields;
    cookies.push({ domain, path: pathField, secure: secure === 'TRUE', expires: Number(expires) || 0, name, value: valueParts.join('\t') });
  }
  return cookies;
}

/** Converts the JSON export of browser extensions such as "Cookie-Editor" into Netscape format. */
function jsonToNetscape(text) {
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    throw new UserError('That looks like JSON but could not be parsed.');
  }
  if (!Array.isArray(list)) throw new UserError('Expected a JSON array of cookies.');
  const lines = [NETSCAPE_HEADER, ''];
  for (const c of list) {
    if (!c?.name || !c.domain) continue;
    const domain = c.hostOnly === false && !c.domain.startsWith('.') ? `.${c.domain}` : c.domain;
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expires = Math.floor(Number(c.expirationDate ?? c.expires ?? 0)) || 0;
    const prefix = c.httpOnly ? '#HttpOnly_' : '';
    lines.push([`${prefix}${domain}`, includeSub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value ?? ''].join('\t'));
  }
  return lines.join('\n');
}

/** Summarises cookies.txt text without saving it. */
export function inspectCookies(text) {
  const cookies = parseNetscape(String(text || '').replace(/\r\n?/g, '\n')).filter((c) =>
    /(^|\.)(youtube|google)\.com$/.test(c.domain),
  );
  return { count: cookies.length, loggedIn: cookies.some((c) => AUTH_COOKIES.has(c.name)) };
}

export function saveCookies(content) {
  if (typeof content !== 'string' || !content.trim()) throw new UserError('Paste the contents of a cookies.txt file.');
  let text = content.replace(/\r\n?/g, '\n').trim();
  if (text.startsWith('[')) text = jsonToNetscape(text);

  const cookies = parseNetscape(text);
  if (!cookies.length) {
    throw new UserError('No cookies found. Export them in Netscape "cookies.txt" format (tab-separated, 7 columns).');
  }
  if (!cookies.some((c) => /(^|\.)youtube\.com$/.test(c.domain))) {
    throw new UserError('The file contains no youtube.com cookies. Export cookies while on youtube.com.');
  }
  if (!text.startsWith('# Netscape') && !text.startsWith('# HTTP Cookie File')) text = `${NETSCAPE_HEADER}\n\n${text}`;
  fs.writeFileSync(COOKIES_PATH, `${text}\n`, { mode: 0o600 });
  return cookieStatus();
}

export function clearCookies() {
  fs.rmSync(COOKIES_PATH, { force: true });
  return cookieStatus();
}

export function hasCookies() {
  try {
    return fs.statSync(COOKIES_PATH).size > 0;
  } catch {
    return false;
  }
}

export function cookieStatus() {
  if (!hasCookies()) return { present: false, count: 0, loggedIn: false, expiresAt: null };
  const cookies = parseNetscape(fs.readFileSync(COOKIES_PATH, 'utf8')).filter((c) =>
    /(^|\.)(youtube|google)\.com$/.test(c.domain),
  );
  const auth = cookies.filter((c) => AUTH_COOKIES.has(c.name));
  const expiries = auth.map((c) => c.expires).filter((e) => e > 0);
  return {
    present: true,
    count: cookies.length,
    loggedIn: auth.length > 0,
    expiresAt: expiries.length ? Math.min(...expiries) * 1000 : null,
    updatedAt: fs.statSync(COOKIES_PATH).mtimeMs,
  };
}
