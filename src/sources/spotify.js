import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { UserError, sleep } from '../util.js';

const log = createLogger('spotify');

const ACCOUNTS_URL = 'https://accounts.spotify.com';
const API_URL = 'https://api.spotify.com/v1';
const SCOPES = ['playlist-read-private', 'playlist-read-collaborative', 'user-library-read'];
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ID = /^[A-Za-z0-9]{22}$/;

export class SpotifyError extends UserError {
  constructor(message, status = 502) {
    super(message, status);
    this.name = 'SpotifyError';
    this.httpStatus = status;
  }
}

/** Recognises open.spotify.com links, spotify: URIs and spotify.link short links. Returns null for anything else. */
export function parseSpotifyUrl(input) {
  const str = String(input || '').trim();
  const uri = str.match(/^spotify:(track|album|playlist|artist):([A-Za-z0-9]{22})$/);
  if (uri) return { type: uri[1], id: uri[2] };
  if (/^spotify:(user:[^:]+:)?collection(:tracks)?$/.test(str)) return { type: 'liked' };
  if (/^spotify:/.test(str)) return { type: 'unsupported' };

  let url;
  try {
    url = new URL(str);
  } catch {
    return null;
  }
  if (/^(spotify\.link|spotify\.app\.link)$/.test(url.hostname)) return { type: 'shortlink', url: str };
  if (!/^(open|play)\.spotify\.com$/.test(url.hostname)) return null;

  const parts = url.pathname.split('/').filter((p) => p && !/^intl-[\w-]+$/i.test(p));
  if (parts[0] === 'embed') parts.shift();
  if (parts[0] === 'collection' && parts[1] === 'tracks') return { type: 'liked' };
  if (parts[0] === 'user' && parts[2] === 'playlist' && ID.test(parts[3] || '')) return { type: 'playlist', id: parts[3] };
  if (['track', 'album', 'playlist', 'artist'].includes(parts[0]) && ID.test(parts[1] || '')) {
    return { type: parts[0], id: parts[1] };
  }
  return { type: 'unsupported' };
}

const trackUrl = (id) => `https://open.spotify.com/track/${id}`;

function mapApiTrack(track, fallbackImage = null) {
  if (!track || track.type === 'episode' || track.is_local || !track.id) return null;
  return {
    title: track.name,
    author: (track.artists || []).map((a) => a.name).join(', '),
    duration: track.duration_ms ? track.duration_ms / 1000 : null,
    thumbnail: track.album?.images?.[0]?.url || fallbackImage,
    url: track.external_urls?.spotify || trackUrl(track.id),
    isrc: track.external_ids?.isrc || null,
  };
}

class SpotifyService {
  constructor() {
    this.appToken = null;
    this.userToken = null;
    config.on('change', (keys) => {
      if (keys.includes('spotify.clientId') || keys.includes('spotify.clientSecret')) {
        this.appToken = null;
        this.userToken = null;
      }
    });
  }

  get settings() {
    return config.get().spotify;
  }

  hasCredentials() {
    return Boolean(this.settings.clientId && this.settings.clientSecret);
  }

  isUserConnected() {
    return this.hasCredentials() && Boolean(this.settings.refreshToken);
  }

  async #tokenRequest(params) {
    const { clientId, clientSecret } = this.settings;
    const res = await fetch(`${ACCOUNTS_URL}/api/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body.error_description || body.error || `HTTP ${res.status}`;
      const error = new SpotifyError(`Spotify rejected the credentials: ${reason}`, res.status);
      error.code = body.error;
      throw error;
    }
    return body;
  }

  async getAppToken() {
    if (!this.hasCredentials()) throw new SpotifyError('Spotify client ID/secret are not configured.', 400);
    if (this.appToken && this.appToken.expiresAt > Date.now()) return this.appToken.value;
    const body = await this.#tokenRequest({ grant_type: 'client_credentials' });
    this.appToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return this.appToken.value;
  }

  async getUserToken() {
    if (!this.isUserConnected()) throw new SpotifyError('No Spotify account is connected.', 400);
    if (this.userToken && this.userToken.expiresAt > Date.now()) return this.userToken.value;
    try {
      const body = await this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: this.settings.refreshToken });
      this.userToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
      if (body.refresh_token && body.refresh_token !== this.settings.refreshToken) {
        config.update({ 'spotify.refreshToken': body.refresh_token });
      }
      return this.userToken.value;
    } catch (err) {
      if (err.code === 'invalid_grant') {
        log.warn('The connected Spotify account revoked access; disconnecting it.');
        this.disconnect();
      }
      throw err;
    }
  }

  authorizeUrl(redirectUri, state) {
    const params = new URLSearchParams({
      client_id: this.settings.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      state,
      show_dialog: 'true',
    });
    return `${ACCOUNTS_URL}/authorize?${params}`;
  }

  async exchangeCode(code, redirectUri) {
    const body = await this.#tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    this.userToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    config.update({ 'spotify.refreshToken': body.refresh_token });
    const me = await this.request('/me', { as: 'user' }).catch(() => null);
    const name = me?.display_name || me?.id || 'Spotify user';
    config.update({ 'spotify.userName': name });
    log.info(`Connected Spotify account "${name}"`);
    return name;
  }

  disconnect() {
    this.userToken = null;
    config.update({ 'spotify.refreshToken': '', 'spotify.userName': '' });
  }

  /** Calls the Web API, preferring the connected user's token (which can see their private playlists). */
  async request(path, { as = 'auto', retry = true } = {}) {
    let useUser = as === 'user' || (as === 'auto' && this.isUserConnected());
    let token;
    try {
      token = useUser ? await this.getUserToken() : await this.getAppToken();
    } catch (err) {
      if (as !== 'auto' || !useUser) throw err;
      log.warn(`Spotify user token unavailable (${err.message}); using app credentials.`);
      useUser = false;
      token = await this.getAppToken();
    }
    const res = await fetch(path.startsWith('http') ? path : `${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 && retry) {
      if (useUser) this.userToken = null;
      else this.appToken = null;
      return this.request(path, { as, retry: false });
    }
    if (res.status === 429 && retry) {
      const wait = Math.min(Number(res.headers.get('retry-after')) || 2, 10);
      await sleep(wait * 1000);
      return this.request(path, { as, retry: false });
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new SpotifyError(body?.error?.message || `Spotify API error (HTTP ${res.status})`, res.status);
    }
    return res.json();
  }

  async #paginate(firstPage, limit, map) {
    const out = [];
    let page = firstPage;
    while (page && out.length < limit) {
      for (const entry of page.items || []) {
        const mapped = map(entry);
        if (mapped) out.push(mapped);
        if (out.length >= limit) break;
      }
      page = page.next && out.length < limit ? await this.request(page.next) : null;
    }
    return out;
  }

  /** Reads Spotify's public embed page. Works without credentials and for playlists the API won't return. */
  async #embed(type, id) {
    const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) throw new SpotifyError(`That Spotify ${type} doesn't exist or isn't public.`, 404);
    if (!res.ok) throw new SpotifyError(`Spotify returned HTTP ${res.status} for that ${type}.`, res.status);
    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    const entity = match ? JSON.parse(match[1])?.props?.pageProps?.state?.data?.entity : null;
    if (!entity) throw new SpotifyError(`Couldn't read that Spotify ${type} (the page format may have changed).`);

    const images = entity.coverArt?.sources || entity.visualIdentity?.image || [];
    const cover = [...images].sort((a, b) => (b.maxWidth || b.width || 0) - (a.maxWidth || a.width || 0))[0]?.url || null;
    const title = entity.name || entity.title || 'Spotify';

    if (type === 'track') {
      return {
        title,
        tracks: [{
          title,
          author: (entity.artists || []).map((a) => a.name).join(', ') || entity.subtitle || '',
          duration: entity.duration ? entity.duration / 1000 : null,
          thumbnail: cover,
          url: trackUrl(id),
        }],
      };
    }
    const tracks = (entity.trackList || [])
      .filter((t) => t.entityType !== 'episode' && t.isPlayable !== false)
      .map((t) => ({
        title: t.title,
        author: String(t.subtitle || '').replace(/ /g, ' '),
        duration: t.duration ? t.duration / 1000 : null,
        thumbnail: cover,
        url: t.uri ? trackUrl(t.uri.split(':').pop()) : null,
      }));
    return { title, tracks, cover };
  }

  async #withFallback(kind, apiCall, embedCall) {
    if (this.hasCredentials()) {
      try {
        const result = await apiCall();
        if (result) return result;
      } catch (err) {
        if (!this.settings.embedFallback) throw err;
        log.debug(`Spotify API failed for ${kind} (${err.message}); using public embed.`);
      }
    } else if (!this.settings.embedFallback) {
      throw new UserError('Spotify links need a Spotify client ID/secret (Settings → Spotify).');
    }
    return embedCall();
  }

  /**
   * Resolves a Spotify link into track metadata. Spotify does not allow third parties to stream its audio,
   * so these tracks are later matched to YouTube for playback (see matcher.js).
   */
  async resolve(input, { limit = 300 } = {}) {
    let ref = parseSpotifyUrl(input);
    if (ref?.type === 'shortlink') ref = parseSpotifyUrl(await this.#expandShortLink(ref.url));
    if (!ref || ref.type === 'unsupported') {
      throw new UserError('Only Spotify tracks, albums, playlists, artists and Liked Songs links are supported.');
    }
    const market = encodeURIComponent(this.settings.market || 'US');

    switch (ref.type) {
      case 'track':
        return this.#withFallback(
          'track',
          async () => {
            const track = mapApiTrack(await this.request(`/tracks/${ref.id}?market=${market}`));
            return track && { type: 'track', title: track.title, url: track.url, tracks: [track] };
          },
          async () => ({ type: 'track', url: trackUrl(ref.id), ...(await this.#embed('track', ref.id)) }),
        );

      case 'album':
        return this.#withFallback(
          'album',
          async () => {
            const album = await this.request(`/albums/${ref.id}?market=${market}`);
            const image = album.images?.[0]?.url || null;
            const tracks = await this.#paginate(album.tracks, limit, (t) => mapApiTrack(t, image));
            return { type: 'album', title: `${album.name} — ${(album.artists || []).map((a) => a.name).join(', ')}`, url: album.external_urls?.spotify, tracks };
          },
          async () => ({ type: 'album', url: `https://open.spotify.com/album/${ref.id}`, ...(await this.#embed('album', ref.id)) }),
        );

      case 'playlist':
        return this.#withFallback(
          'playlist',
          async () => {
            // Since Feb 2026, development-mode apps only get the contents of playlists the connected user
            // owns or collaborates on; everything else falls back to the public embed.
            if (!this.isUserConnected()) return null;
            const playlist = await this.request(`/playlists/${ref.id}?market=${market}`);
            const firstPage = playlist.items?.items ? playlist.items : playlist.tracks?.items ? playlist.tracks : null;
            if (!firstPage?.items?.length) return null;
            const image = playlist.images?.[0]?.url || null;
            const tracks = await this.#paginate(firstPage, limit, (entry) => mapApiTrack(entry.item ?? entry.track, image));
            return { type: 'playlist', title: playlist.name, url: playlist.external_urls?.spotify, tracks };
          },
          async () => {
            const embed = await this.#embed('playlist', ref.id);
            const notice = embed.tracks.length >= 100
              ? 'Spotify only shares the first 100 tracks of playlists you don\'t own. Connect the owner\'s account in the dashboard to load all of them.'
              : null;
            return { type: 'playlist', url: `https://open.spotify.com/playlist/${ref.id}`, ...embed, notice };
          },
        );

      case 'artist': {
        const embed = await this.#embed('artist', ref.id);
        return { type: 'artist', url: `https://open.spotify.com/artist/${ref.id}`, ...embed, title: `${embed.title} — top tracks` };
      }

      case 'liked': {
        if (!this.isUserConnected()) {
          throw new UserError('Playing Liked Songs requires connecting a Spotify account in the dashboard.');
        }
        const first = await this.request('/me/tracks?limit=50', { as: 'user' });
        const tracks = await this.#paginate(first, limit, (entry) => mapApiTrack(entry.track));
        return { type: 'playlist', title: `${this.settings.userName || 'Your'} Liked Songs`, url: 'https://open.spotify.com/collection/tracks', tracks };
      }

      default:
        throw new UserError('Unsupported Spotify link.');
    }
  }

  async #expandShortLink(url) {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(10_000) });
    if (parseSpotifyUrl(res.url)?.id) return res.url;
    const html = await res.text();
    const found = html.match(/https:\/\/open\.spotify\.com\/[a-z-]+\/[A-Za-z0-9]{22}/);
    if (!found) throw new UserError('Could not expand that spotify.link URL.');
    return found[0];
  }

  /** Used by the dashboard's "Test" button. */
  async test() {
    const result = { credentials: null, account: null, embed: null };
    if (this.hasCredentials()) {
      try {
        await this.getAppToken();
        result.credentials = { ok: true };
      } catch (err) {
        result.credentials = { ok: false, error: err.message };
      }
    }
    if (this.isUserConnected()) {
      try {
        const me = await this.request('/me', { as: 'user' });
        result.account = { ok: true, name: me.display_name || me.id };
      } catch (err) {
        result.account = { ok: false, error: err.message };
      }
    }
    try {
      const sample = await this.#embed('track', '4cOdK2wGLETKBW3PvgPWqT');
      result.embed = { ok: true, sample: `${sample.tracks[0].author} — ${sample.tracks[0].title}` };
    } catch (err) {
      result.embed = { ok: false, error: err.message };
    }
    return result;
  }
}

export const spotify = new SpotifyService();
