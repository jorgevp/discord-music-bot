import { spawn } from 'node:child_process';
import os from 'node:os';
import { COOKIES_PATH, config } from '../config.js';
import { createLogger } from '../logger.js';
import { UserError, splitArgs } from '../util.js';
import { hasCookies } from './cookies.js';

const log = createLogger('yt-dlp');

export const YTDLP_BIN = process.env.YTDLP_PATH || 'yt-dlp';
const PIP_BIN = process.env.YTDLP_PIP || '';
const TEST_VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

let cachedVersion = null;

/** Arguments shared by every yt-dlp invocation: auth cookies, PO-token provider, JS runtime, admin extras. */
export function commonArgs() {
  const settings = config.get().youtube;
  const args = ['--ignore-config', '--no-warnings', '--no-progress'];
  // YouTube needs a JavaScript runtime to solve its player challenges; reuse the Node binary we run on.
  if (process.platform !== 'win32') args.push('--js-runtimes', `node:${process.execPath}`);
  if (hasCookies()) args.push('--cookies', COOKIES_PATH);
  if (settings.potProviderUrl) {
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${settings.potProviderUrl}`);
  }
  if (settings.extraArgs) args.push(...splitArgs(settings.extraArgs));
  return args;
}

/** Turns yt-dlp's stderr into a short message that tells the user what to do about it. */
export function friendlyYtdlpError(stderr) {
  const lines = String(stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const errorLine = [...lines].reverse().find((l) => l.startsWith('ERROR:')) || lines.at(-1) || 'Unknown error';
  const message = errorLine.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '');

  if (/not a bot|sign in to confirm/i.test(message)) {
    return 'YouTube is asking the bot to sign in ("confirm you\'re not a bot"). Add YouTube account cookies in the dashboard (Settings → YouTube).';
  }
  if (/age|inappropriate for some users/i.test(message) && /sign in/i.test(message)) {
    return 'This video is age-restricted. Add cookies from an age-verified YouTube account in the dashboard.';
  }
  if (/private video/i.test(message)) return 'That video is private.';
  if (/members[- ]only|join this channel/i.test(message)) return 'That video is for channel members only.';
  if (/Unsupported URL/i.test(message)) return 'That link is not supported.';
  if (/HTTP Error 403/i.test(message)) return 'The media host refused the download (HTTP 403). Updating yt-dlp or adding cookies usually fixes this.';
  if (/HTTP Error 429/i.test(message)) return 'Rate limited by the media host (HTTP 429). Add cookies or wait a little while.';
  return message;
}

export class YtdlpError extends UserError {
  constructor(stderr) {
    super(friendlyYtdlpError(stderr));
    this.name = 'YtdlpError';
    this.stderr = stderr;
  }
}

export function runYtdlp(args, { timeout = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(YTDLP_BIN, args, { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-20_000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`yt-dlp was not found ("${YTDLP_BIN}"). Is it installed?`) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) stderr += '\nERROR: yt-dlp timed out';
      resolve({ code, stdout, stderr });
    });
  });
}

/** Fetches metadata as JSON. With flat=true, playlists list their entries without resolving each one. */
export async function extractInfo(url, { flat = true, noPlaylist = false, playlistEnd = null, timeout } = {}) {
  const args = [...commonArgs(), '-J', '--ignore-no-formats-error'];
  if (flat) args.push('--flat-playlist');
  if (noPlaylist) args.push('--no-playlist');
  if (playlistEnd) args.push('--playlist-end', String(playlistEnd));
  args.push('--', url);
  const result = await runYtdlp(args, { timeout });
  if (result.code !== 0) throw new YtdlpError(result.stderr);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new UserError('yt-dlp returned unreadable output.');
  }
}

export function youtubeThumbnail(id) {
  return /^[\w-]{11}$/.test(id || '') ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
}

/** YouTube search. Returns lightweight results (no stream resolution), so it is fast. */
export async function search(query, limit = 5) {
  const info = await extractInfo(`ytsearch${limit}:${query}`, { flat: true, timeout: 45_000 });
  return (info.entries || [])
    .filter((e) => e && e.id)
    .map((e) => ({
      id: e.id,
      title: e.title || 'Untitled',
      url: e.url && e.url.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
      duration: Number.isFinite(e.duration) ? e.duration : null,
      channel: e.channel || e.uploader || null,
      thumbnail: youtubeThumbnail(e.id) || e.thumbnails?.at(-1)?.url || null,
      isLive: e.live_status === 'is_live',
    }));
}

export async function version({ refresh = false } = {}) {
  if (cachedVersion && !refresh) return cachedVersion;
  const result = await runYtdlp(['--version'], { timeout: 20_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Could not read the yt-dlp version');
  cachedVersion = result.stdout.trim();
  return cachedVersion;
}

let updating = null;

/** Updates yt-dlp in place. YouTube changes often; a current yt-dlp is the best defence against breakage. */
export function update() {
  if (updating) return updating;
  updating = (async () => {
    const before = await version().catch(() => null);
    const [bin, args] = PIP_BIN
      ? [PIP_BIN, ['install', '--no-cache-dir', '--disable-pip-version-check', '-U', 'yt-dlp[default]']]
      : [YTDLP_BIN, ['-U']];
    log.info(`Updating yt-dlp (current: ${before ?? 'unknown'})…`);
    const output = await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(out.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`))));
    });
    const after = await version({ refresh: true });
    if (before !== after) log.info(`yt-dlp updated: ${before ?? 'unknown'} → ${after}`);
    else log.info(`yt-dlp is up to date (${after})`);
    return { before, after, output: output.trim().split('\n').slice(-15).join('\n') };
  })().finally(() => {
    updating = null;
  });
  return updating;
}

/** Resolves a known public video end-to-end, which verifies cookies, PO tokens and challenge solving. */
export async function testYoutube() {
  const started = Date.now();
  const args = [
    ...commonArgs(),
    '--simulate',
    '--no-playlist',
    '-f', 'bestaudio/best',
    '--print', '%(title)s\t%(format_id)s\t%(acodec)s\t%(abr)s',
    '--', TEST_VIDEO,
  ];
  const result = await runYtdlp(args, { timeout: 90_000 });
  const ms = Date.now() - started;
  if (result.code !== 0) {
    return { ok: false, ms, error: friendlyYtdlpError(result.stderr), details: result.stderr.trim().split('\n').slice(-6).join('\n') };
  }
  const [title, formatId, codec, bitrate] = result.stdout.trim().split('\t');
  return { ok: true, ms, title, format: `${formatId} (${codec}${bitrate && bitrate !== 'NA' ? `, ${Math.round(bitrate)} kbps` : ''})` };
}
