import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';
import { UserError } from '../util.js';
import { inspectCookies, saveCookies } from './cookies.js';

const log = createLogger('youtube-login');

// The "youtube-login" container (see docker-compose.yml): Chromium + noVNC that the admin signs in with.
const HOST = process.env.LOGIN_BROWSER_HOST || '';
const PROFILE_DIR = process.env.LOGIN_PROFILE_DIR || '/login-profile';
const PYTHON = process.env.YTDLP_PYTHON || 'python3';
const EXPORT_SCRIPT = fileURLToPath(new URL('../tools/export_youtube_cookies.py', import.meta.url));

export const VIEWER_PREFIX = '/youtube-login';
export const VIEWER_PORT = 6080;
const CONTROL_PORT = 6081;

export function loginBrowserHost() {
  return HOST || null;
}

async function control(pathname, method = 'POST') {
  if (!HOST) throw new UserError('The sign-in browser container is not set up (see the youtube-login service in docker-compose.yml).', 503);
  let token;
  try {
    token = fs.readFileSync(path.join(PROFILE_DIR, 'control-token'), 'utf8').trim();
  } catch {
    throw new UserError('The sign-in browser container is not running yet. Start it with "docker compose up -d" and try again.', 503);
  }
  let res;
  try {
    res = await fetch(`http://${HOST}:${CONTROL_PORT}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new UserError(`Can't reach the sign-in browser container (${err.cause?.code || err.message}).`, 503);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new UserError(`Sign-in browser error: ${body.error || `HTTP ${res.status}`}`, 502);
  return body;
}

export async function loginStatus() {
  if (!HOST) return { available: false, running: false };
  try {
    const status = await control('/status', 'GET');
    return { available: true, running: Boolean(status.browser) };
  } catch (err) {
    return { available: true, running: false, error: err.message };
  }
}

/** Opens a fresh browser on Google's sign-in page and returns the dashboard URL that shows it. */
export async function startLogin() {
  await control('/start?fresh=1');
  log.info('Sign-in browser opened.');
  const query = new URLSearchParams({
    autoconnect: '1',
    resize: 'scale',
    reconnect: '1',
    show_dot: '1',
    path: `${VIEWER_PREFIX.slice(1)}/websockify`,
  });
  return { viewerUrl: `${VIEWER_PREFIX}/vnc.html?${query}` };
}

/** Reads the YouTube/Google cookies from the browser profile (via yt-dlp) as Netscape cookies.txt text. */
function exportCookies() {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-login-'));
    const output = path.join(dir, 'cookies.txt');
    const child = spawn(PYTHON, [EXPORT_SCRIPT, path.join(PROFILE_DIR, 'chromium'), output], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', (err) => {
      fs.rmSync(dir, { recursive: true, force: true });
      reject(err);
    });
    child.on('close', (code) => {
      try {
        if (code !== 0) {
          const reason = stderr.trim().split('\n').at(-1) || `exit code ${code}`;
          reject(new UserError(`Couldn't read the sign-in browser's cookies: ${reason}`, 500));
        } else {
          resolve(fs.readFileSync(output, 'utf8'));
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

/**
 * Takes over the signed-in session: closes the browser (which flushes its cookies to disk), saves the
 * cookies for yt-dlp and wipes the browser, so nothing else keeps using (and rotating) that session.
 */
export async function finishLogin() {
  await control('/stop');
  let content;
  try {
    content = await exportCookies();
  } catch (err) {
    await control('/start').catch(() => {});
    throw err;
  }
  if (!inspectCookies(content).loggedIn) {
    await control('/start').catch(() => {});
    throw new UserError('No signed-in Google account was found yet. Finish signing in (until YouTube shows your profile picture in the top-right corner), then click Finish again.');
  }
  const status = saveCookies(content);
  await control('/wipe').catch((err) => log.warn(`Could not wipe the sign-in browser: ${err.message}`));
  log.info(`Signed in to YouTube via the sign-in browser (${status.count} cookies saved).`);
  return status;
}

export async function cancelLogin() {
  await control('/wipe');
  log.info('Sign-in browser closed without signing in.');
}
