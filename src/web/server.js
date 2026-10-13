import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { bot } from '../bot/bot.js';
import { DATA_DIR, coerceSetting, config } from '../config.js';
import { createLogger, logHub } from '../logger.js';
import { players } from '../player/manager.js';
import { hashPassword, verifyPassword } from '../security.js';
import { clearCookies, cookieStatus, saveCookies } from '../sources/cookies.js';
import { resolveQuery } from '../sources/resolver.js';
import { spotify } from '../sources/spotify.js';
import { VIEWER_PREFIX, cancelLogin, finishLogin, loginBrowserHost, loginStatus, startLogin } from '../sources/youtubeLogin.js';
import * as ytdlp from '../sources/ytdlp.js';
import { UserError } from '../util.js';
import {
  checkLoginRateLimit,
  clearSessionCookie,
  isAllowedOrigin,
  isAuthenticatedCookieHeader,
  requireAuth,
  resetLoginRateLimit,
  setSessionCookie,
} from './auth.js';
import { handleLoginViewerUpgrade, loginViewerHttp } from './loginProxy.js';

const log = createLogger('web');
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PKG = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const DASHBOARD_REQUESTER = { id: 'dashboard', name: 'Dashboard' };
const SPOTIFY_STATE_TTL_MS = 10 * 60 * 1000;

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const requestOrigin = (req) => `${req.protocol}://${req.get('host')}`;
const spotifyRedirectUri = (req) => `${config.get().web.publicUrl || requestOrigin(req)}/api/spotify/callback`;

function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new UserError('Use a password of at least 8 characters.');
  if (password.length > 200) throw new UserError('That password is too long.');
  return password;
}

function emptyState(guildId) {
  return {
    guildId,
    connected: false,
    connectionStatus: 'disconnected',
    voiceChannel: null,
    textChannelId: null,
    status: 'idle',
    current: null,
    position: 0,
    volume: config.get().playback.defaultVolume,
    loop: 'off',
    queue: [],
    queueDuration: 0,
    history: [],
  };
}

function publicSettings(req) {
  const c = config.get();
  return {
    discord: { tokenSet: Boolean(c.discord.token), prefix: c.discord.prefix, activity: c.discord.activity },
    playback: { ...c.playback },
    youtube: { ...c.youtube, cookies: cookieStatus(), loginBrowser: { available: Boolean(loginBrowserHost()) } },
    spotify: {
      clientId: c.spotify.clientId,
      clientSecretSet: Boolean(c.spotify.clientSecret),
      market: c.spotify.market,
      embedFallback: c.spotify.embedFallback,
      connected: Boolean(c.spotify.refreshToken),
      userName: c.spotify.userName,
      redirectUri: spotifyRedirectUri(req),
    },
    web: { publicUrl: c.web.publicUrl },
  };
}

/** Accepts { section: { key: value } } from the dashboard; every key is validated against SETTINGS_SCHEMA. */
function applySettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UserError('Invalid settings payload.');
  const changes = {};
  for (const [section, values] of Object.entries(body)) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new UserError(`Invalid settings section "${section}".`);
    for (const [key, value] of Object.entries(values)) changes[`${section}.${key}`] = coerceSetting(`${section}.${key}`, value);
  }
  return config.update(changes);
}

let ffmpegVersion = null;
function getFfmpegVersion() {
  if (ffmpegVersion) return Promise.resolve(ffmpegVersion);
  return new Promise((resolve) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      ffmpegVersion = out.match(/ffmpeg version (\S+)/)?.[1] ?? null;
      resolve(ffmpegVersion);
    });
  });
}

export function startWebServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new SocketServer(server, {
    // Reject cross-origin WebSocket connections (a page on another site/port must not read the dashboard).
    allowRequest: (req, callback) => callback(null, isAllowedOrigin(req)),
    // Other upgrade paths (the sign-in browser viewer) are handled by our own "upgrade" listener below.
    destroyUpgrade: false,
  });
  server.on('upgrade', (req, socket, head) => {
    if (handleLoginViewerUpgrade(req, socket, head)) return;
    if (!req.url.startsWith('/socket.io/')) socket.destroy();
  });
  const spotifyStates = new Map();

  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) {
    const value = process.env.TRUST_PROXY;
    app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value === 'true' ? true : value);
  }
  // The sign-in browser viewer (noVNC) brings its own scripts, so it is mounted before the dashboard's CSP.
  app.use(VIEWER_PREFIX, loginViewerHttp);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/healthz', (req, res) => res.json({ ok: true, bot: bot.status }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

  const api = express.Router();

  // Mutating requests must be JSON: browsers can't send that cross-site without a CORS preflight we never allow.
  api.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.is('application/json')) return next();
    res.status(415).json({ error: 'Expected a JSON request body.' });
  });

  // ------------------------------------------------------------ auth (public)
  api.get('/auth/status', (req, res) => {
    res.json({ setupRequired: !config.get().web.passwordHash, authenticated: isAuthenticatedCookieHeader(req.headers.cookie) });
  });

  api.post('/auth/setup', async (req, res) => {
    if (config.get().web.passwordHash) throw new UserError('A password has already been set.', 409);
    const password = validateNewPassword(req.body?.password);
    config.update({ 'web.passwordHash': await hashPassword(password) });
    log.info('Dashboard password created.');
    setSessionCookie(req, res);
    res.json({ ok: true });
  });

  api.post('/auth/login', async (req, res) => {
    const limit = checkLoginRateLimit(req.ip);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      throw new UserError(`Too many attempts. Try again in ${Math.ceil(limit.retryAfter / 60)} minute(s).`, 429);
    }
    const { passwordHash } = config.get().web;
    if (!passwordHash) throw new UserError('No password has been set yet.', 409);
    if (!(await verifyPassword(String(req.body?.password ?? ''), passwordHash))) {
      log.warn(`Failed dashboard sign-in from ${req.ip}`);
      throw new UserError('Wrong password.', 401);
    }
    resetLoginRateLimit(req.ip);
    setSessionCookie(req, res);
    res.json({ ok: true });
  });

  api.post('/auth/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // Spotify redirects the browser here. The one-time `state` value (issued to a signed-in admin) authorises
  // the request, so this also works when Spotify's redirect URI points at a different host (e.g. 127.0.0.1).
  const resultPage = (res, ok, message) =>
    res.status(ok ? 200 : 400).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Spotify</title><link rel="stylesheet" href="/styles.css"></head>
<body><div class="auth"><div class="auth-card"><h1>${ok ? 'Spotify connected' : 'Spotify connection failed'}</h1>
<p class="muted">${escapeHtml(message)}</p><a class="btn primary" href="/#settings">Back to the dashboard</a></div></div></body></html>`);

  async function completeSpotifyAuth(code, state) {
    const pending = spotifyStates.get(state);
    spotifyStates.delete(state);
    if (!pending || pending.expiresAt < Date.now()) {
      throw new UserError('This Spotify sign-in link expired or was already used. Click "Connect Spotify account" again.');
    }
    if (!code) throw new UserError('Spotify did not return an authorization code.');
    return spotify.exchangeCode(code, pending.redirectUri);
  }

  api.get('/spotify/callback', async (req, res) => {
    if (req.query.error) return resultPage(res, false, `Spotify said: ${req.query.error}`);
    try {
      const name = await completeSpotifyAuth(String(req.query.code || ''), String(req.query.state || ''));
      resultPage(res, true, `Signed in as ${name}. You can close this tab.`);
    } catch (err) {
      log.warn(`Spotify sign-in failed: ${err.message}`);
      resultPage(res, false, err.message);
    }
  });

  // ------------------------------------------------------------ everything below requires sign-in
  api.use(requireAuth);

  api.post('/auth/password', async (req, res) => {
    const { current, next } = req.body || {};
    if (!(await verifyPassword(String(current ?? ''), config.get().web.passwordHash))) {
      throw new UserError('The current password is wrong.', 403);
    }
    config.update({ 'web.passwordHash': await hashPassword(validateNewPassword(next)) });
    log.info('Dashboard password changed; other sessions were signed out.');
    setSessionCookie(req, res);
    io.disconnectSockets(true);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ settings & system
  api.get('/settings', (req, res) => res.json(publicSettings(req)));

  api.put('/settings', (req, res) => {
    const changed = applySettings(req.body);
    if (changed.length) log.info(`Settings changed: ${changed.join(', ')}`);
    res.json(publicSettings(req));
  });

  api.get('/system', async (req, res) => {
    const [ytdlpVersion, ffmpeg] = await Promise.all([ytdlp.version().catch(() => null), getFfmpegVersion()]);
    res.json({
      version: PKG.version,
      node: process.version,
      ytdlp: ytdlpVersion,
      ffmpeg,
      uptime: Math.round(process.uptime()),
      dataDir: DATA_DIR,
    });
  });

  api.post('/system/ytdlp/update', async (req, res) => res.json(await ytdlp.update()));

  api.get('/logs', (req, res) => res.json(logHub.recent(1000)));

  // ------------------------------------------------------------ discord bot
  api.get('/bot', (req, res) => res.json(bot.info()));

  api.post('/bot/restart', async (req, res) => {
    await bot.restart();
    res.json(bot.info());
  });

  // ------------------------------------------------------------ youtube
  api.put('/youtube/cookies', (req, res) => {
    const status = saveCookies(req.body?.content);
    log.info(`YouTube cookies saved (${status.count} cookies, signed in: ${status.loggedIn ? 'yes' : 'no'}).`);
    res.json(status);
  });

  api.delete('/youtube/cookies', (req, res) => {
    log.info('YouTube cookies removed.');
    res.json(clearCookies());
  });

  api.post('/youtube/test', async (req, res) => res.json(await ytdlp.testYoutube()));

  // "Sign in to YouTube": the admin signs in inside the sign-in browser, then the bot takes over the session.
  api.get('/youtube/login', async (req, res) => res.json(await loginStatus()));
  api.post('/youtube/login/start', async (req, res) => res.json(await startLogin()));
  api.post('/youtube/login/finish', async (req, res) => res.json(await finishLogin()));
  api.post('/youtube/login/cancel', async (req, res) => {
    await cancelLogin();
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ spotify
  api.get('/spotify/authorize', (req, res) => {
    if (!spotify.hasCredentials()) {
      return resultPage(res, false, 'Save a Spotify client ID and client secret first.');
    }
    const state = crypto.randomBytes(18).toString('base64url');
    const redirectUri = spotifyRedirectUri(req);
    for (const [key, value] of spotifyStates) if (value.expiresAt < Date.now()) spotifyStates.delete(key);
    spotifyStates.set(state, { redirectUri, expiresAt: Date.now() + SPOTIFY_STATE_TTL_MS });
    res.redirect(spotify.authorizeUrl(redirectUri, state));
  });

  // Fallback for when the redirect page can't load (e.g. it points at 127.0.0.1 on another machine):
  // the admin pastes the URL from the address bar.
  api.post('/spotify/complete', async (req, res) => {
    let url;
    try {
      url = new URL(String(req.body?.url || ''));
    } catch {
      throw new UserError('Paste the full URL from your browser\'s address bar.');
    }
    if (url.searchParams.get('error')) throw new UserError(`Spotify said: ${url.searchParams.get('error')}`);
    const name = await completeSpotifyAuth(url.searchParams.get('code'), url.searchParams.get('state'));
    res.json({ ok: true, name, settings: publicSettings(req) });
  });

  api.post('/spotify/disconnect', (req, res) => {
    spotify.disconnect();
    log.info('Spotify account disconnected.');
    res.json(publicSettings(req));
  });

  api.post('/spotify/test', async (req, res) => res.json(await spotify.test()));

  // ------------------------------------------------------------ search
  api.get('/search', async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (!query) throw new UserError('Enter something to search for.');
    if (query.length > 200) throw new UserError('That search is too long.');
    res.json({ results: await ytdlp.search(query, 8) });
  });

  // ------------------------------------------------------------ guilds & players
  function getGuild(req) {
    if (!bot.ready) throw new UserError('The bot is not connected to Discord. Check Settings → Discord.', 503);
    const guild = bot.client.guilds.cache.get(req.params.guildId);
    if (!guild) throw new UserError('The bot is not in that server.', 404);
    return guild;
  }

  const stateOf = (guild) => players.get(guild.id)?.toJSON() ?? emptyState(guild.id);

  api.get('/guilds', (req, res) => res.json(bot.guildSummaries()));

  api.get('/roles', (req, res) => res.json({ guilds: bot.rolesOverview() }));

  api.get('/guilds/:guildId', (req, res) => {
    const guild = getGuild(req);
    res.json({ guild: bot.guildDetail(guild), state: stateOf(guild) });
  });

  api.delete('/guilds/:guildId', async (req, res) => {
    const guild = getGuild(req);
    players.destroy(guild.id);
    await guild.leave();
    log.info(`Left server "${guild.name}" (requested from the dashboard).`);
    res.json({ ok: true });
  });

  api.post('/guilds/:guildId/tracks', async (req, res) => {
    const guild = getGuild(req);
    const { query, next = false, voiceChannelId = null } = req.body || {};
    if (typeof query !== 'string' || !query.trim()) throw new UserError('Enter a link or something to search for.');
    const player = players.obtain(guild);
    const result = await resolveQuery(query, { requester: DASHBOARD_REQUESTER, limit: config.get().playback.maxPlaylistSize });
    if (voiceChannelId && !(player.connected && player.current)) {
      const channel = guild.channels.cache.get(String(voiceChannelId));
      if (!channel?.isVoiceBased()) throw new UserError('That voice channel no longer exists.');
      await player.connect(channel);
    }
    const outcome = player.enqueue(result.tracks, { next: Boolean(next) });
    res.json({
      ...outcome,
      title: result.playlist?.title || result.tracks[0].title,
      playlist: Boolean(result.playlist),
      notice: result.notice || null,
      connected: player.connected,
    });
  });

  api.delete('/guilds/:guildId/tracks/:trackId', (req, res) => {
    const player = players.obtain(getGuild(req));
    player.remove(req.params.trackId);
    res.json(player.toJSON());
  });

  api.post('/guilds/:guildId/tracks/:trackId/move', (req, res) => {
    const player = players.obtain(getGuild(req));
    player.move(req.params.trackId, req.body?.to);
    res.json(player.toJSON());
  });

  api.post('/guilds/:guildId/tracks/:trackId/play', async (req, res) => {
    const player = players.obtain(getGuild(req));
    await player.jump(req.params.trackId);
    res.json(player.toJSON());
  });

  api.post('/guilds/:guildId/history/:trackId/requeue', (req, res) => {
    const player = players.obtain(getGuild(req));
    player.requeueFromHistory(req.params.trackId, { next: Boolean(req.body?.next) });
    res.json(player.toJSON());
  });

  api.post('/guilds/:guildId/queue/clear', (req, res) => {
    const player = players.obtain(getGuild(req));
    player.clear();
    res.json(player.toJSON());
  });

  api.post('/guilds/:guildId/queue/shuffle', (req, res) => {
    const player = players.obtain(getGuild(req));
    player.shuffle();
    res.json(player.toJSON());
  });

  api.post('/guilds/:guildId/player/:action', async (req, res) => {
    const player = players.obtain(getGuild(req));
    const value = req.body?.value;
    switch (req.params.action) {
      case 'start':
        if (!player.connected) throw new UserError('The bot is not in a voice channel. Pick one under Voice and press Join.');
        player.ensurePlaying();
        break;
      case 'pause': player.pause(); break;
      case 'resume': player.resume(); break;
      case 'toggle': player.togglePause(); break;
      case 'skip': await player.skip(); break;
      case 'previous': await player.previous(); break;
      case 'stop': player.stop(); break;
      case 'seek': await player.seek(Number(value)); break;
      case 'volume': player.setVolume(value); break;
      case 'loop': player.setLoop(String(value)); break;
      default: throw new UserError('Unknown player action.', 404);
    }
    res.json(player.toJSON());
  });

  api.put('/guilds/:guildId/voice', async (req, res) => {
    const guild = getGuild(req);
    const channel = guild.channels.cache.get(String(req.body?.channelId || ''));
    if (!channel?.isVoiceBased()) throw new UserError('Pick a voice channel.');
    const player = players.obtain(guild);
    await player.connect(channel);
    player.ensurePlaying();
    res.json(player.toJSON());
  });

  api.delete('/guilds/:guildId/voice', (req, res) => {
    const guild = getGuild(req);
    players.get(guild.id)?.leave();
    res.json(stateOf(guild));
  });

  api.put('/guilds/:guildId/text-channel', (req, res) => {
    const guild = getGuild(req);
    const channelId = req.body?.channelId ? String(req.body.channelId) : null;
    if (channelId && !guild.channels.cache.get(channelId)?.isTextBased()) throw new UserError('Pick a text channel.');
    const player = players.obtain(guild);
    player.textChannelId = channelId;
    player.emitUpdate();
    res.json(player.toJSON());
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large (2 MB max).' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    const status = err instanceof UserError ? err.status : 500;
    if (status >= 500) log.error(`${req.method} ${req.originalUrl} failed:`, err);
    res.status(status).json({ error: err instanceof UserError ? err.message : `Internal error: ${err.message}` });
  });

  // ------------------------------------------------------------ live updates
  io.use((socket, next) => {
    if (isAuthenticatedCookieHeader(socket.handshake.headers.cookie)) next();
    else next(new Error('unauthorized'));
  });

  io.on('connection', (socket) => {
    socket.emit('bot', bot.info());
    socket.emit('guilds', bot.guildSummaries());
    socket.on('subscribe', (guildId) => {
      if (typeof guildId !== 'string') return;
      for (const room of socket.rooms) if (room.startsWith('guild:')) socket.leave(room);
      socket.join(`guild:${guildId}`);
      socket.emit('guild:state', { guildId, state: players.get(guildId)?.toJSON() ?? emptyState(guildId) });
    });
    socket.on('logs', (enabled) => {
      if (enabled) {
        socket.join('logs');
        socket.emit('logs:init', logHub.recent(1000));
      } else {
        socket.leave('logs');
      }
    });
  });

  let guildsTimer = null;
  const broadcastGuilds = () => {
    if (guildsTimer) return;
    guildsTimer = setTimeout(() => {
      guildsTimer = null;
      io.emit('guilds', bot.guildSummaries());
    }, 500);
  };

  players.on('update', (player) => {
    io.to(`guild:${player.guildId}`).emit('guild:state', { guildId: player.guildId, state: player.toJSON() });
    broadcastGuilds();
  });
  players.on('removed', (guildId) => {
    io.to(`guild:${guildId}`).emit('guild:state', { guildId, state: emptyState(guildId) });
    broadcastGuilds();
  });
  bot.on('status', () => {
    io.emit('bot', bot.info());
    broadcastGuilds();
  });
  bot.on('guilds', () => {
    io.emit('bot', bot.info());
    broadcastGuilds();
  });
  config.on('change', (keys) => {
    if (keys.some((k) => k.startsWith('discord.'))) io.emit('bot', bot.info());
  });
  logHub.on('entry', (entry) => io.to('logs').emit('log', entry));

  const port = Number(process.env.WEB_PORT || 8080);
  const host = process.env.WEB_HOST || '0.0.0.0';
  server.listen(port, host, () => log.info(`Dashboard listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));

  return {
    close: () =>
      new Promise((resolve) => {
        io.close();
        server.close(() => resolve());
        setTimeout(resolve, 2000).unref();
      }),
  };
}
