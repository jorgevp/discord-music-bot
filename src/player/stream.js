import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { YTDLP_BIN, commonArgs, friendlyYtdlpError } from '../sources/ytdlp.js';

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
// yt-dlp downloads into this in-memory buffer as fast as it can, so a slow consumer never leaves the
// HTTP connection idle long enough for the media server to drop it mid-song.
const READ_AHEAD_BYTES = 8 * 1024 * 1024;
const DETACH = process.platform !== 'win32';

function watch(child) {
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const result = { done: false, code: null, error: null, get stderr() { return stderr; } };
  const exited = new Promise((resolve) => {
    const finish = (code, error) => {
      if (result.done) return;
      Object.assign(result, { done: true, code, error });
      resolve(result);
    };
    child.once('error', (err) => finish(null, err));
    child.once('close', (code) => finish(code, null));
    // "close" waits for stdio to drain; don't let an unread pipe keep us from noticing the exit.
    child.once('exit', (code) => setTimeout(() => finish(code, null), 1000).unref());
  });
  return { result, exited };
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    // Negative pid = the whole process group, so helpers spawned by yt-dlp die too.
    if (DETACH) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Spawns `yt-dlp -o - URL | ffmpeg → 48 kHz stereo s16le PCM`. The PCM stream is what @discordjs/voice
 * turns into Opus, which lets us change volume on the fly.
 */
export function createAudioStream(url, { seek = 0, normalize = false } = {}) {
  const ytdlpArgs = [
    ...commonArgs(),
    '--quiet',
    '--no-playlist',
    '-f', 'bestaudio[acodec=opus]/bestaudio/best',
    '--retries', '10',
    '--fragment-retries', '10',
    '--http-chunk-size', '10M',
    '-o', '-',
    '--', url,
  ];
  const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0'];
  if (seek > 0) ffmpegArgs.push('-ss', seek.toFixed(3));
  if (normalize) ffmpegArgs.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
  ffmpegArgs.push('-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');

  // When piping fragmented formats (HLS/DASH) to stdout, yt-dlp stages each fragment as a file in its working
  // directory, so every stream gets a private, writable one.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicbot-stream-'));
  const ytdlp = spawn(YTDLP_BIN, ytdlpArgs, { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], detached: DETACH });
  const ffmpeg = spawn(FFMPEG_BIN, ffmpegArgs, { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], detached: DETACH });
  const readAhead = new PassThrough({ highWaterMark: READ_AHEAD_BYTES });

  const swallow = () => {};
  for (const stream of [ytdlp.stdout, ffmpeg.stdin, ffmpeg.stdout, readAhead]) stream?.on('error', swallow);
  ytdlp.stdout?.pipe(readAhead).pipe(ffmpeg.stdin);

  const yt = watch(ytdlp);
  const ff = watch(ffmpeg);
  let killed = false;
  Promise.all([yt.exited, ff.exited]).then(() => fs.rm(workDir, { recursive: true, force: true }, () => {}));

  return {
    output: ffmpeg.stdout,

    get running() {
      return !yt.result.done || !ff.result.done;
    },

    /** True when a process failed on its own (not because we stopped it). */
    get failed() {
      if (killed) return false;
      const ytFailed = yt.result.done && (yt.result.error || yt.result.code !== 0);
      const ffFailed = ff.result.done && (ff.result.error || ff.result.code !== 0);
      return Boolean(ytFailed || ffFailed);
    },

    get errorMessage() {
      if (yt.result.error?.code === 'ENOENT') return 'yt-dlp is not installed.';
      if (ff.result.error?.code === 'ENOENT') return 'ffmpeg is not installed.';
      if (yt.result.done && yt.result.code !== 0) return friendlyYtdlpError(yt.result.stderr);
      if (ff.result.done && ff.result.code !== 0) return ff.result.stderr.trim().split('\n').at(-1) || 'ffmpeg failed';
      return null;
    },

    /** Waits (up to `timeout` ms) for both processes to exit. Resolves true if they did. */
    async settled(timeout = 2000) {
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeout);
      });
      const finished = Promise.all([yt.exited, ff.exited]).then(() => true);
      const result = await Promise.race([finished, timedOut]);
      clearTimeout(timer);
      return result;
    },

    kill() {
      if (killed) return;
      killed = true;
      killTree(ytdlp);
      killTree(ffmpeg);
      for (const stream of [readAhead, ytdlp.stdout, ffmpeg.stdin, ffmpeg.stdout]) stream?.destroy();
    },
  };
}
