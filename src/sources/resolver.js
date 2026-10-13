import { createTrack } from '../player/track.js';
import { UserError, isHttpUrl, truncate } from '../util.js';
import { parseSpotifyUrl, spotify } from './spotify.js';
import { extractInfo, search, youtubeThumbnail } from './ytdlp.js';

/** For YouTube links that point at a single video (even inside a playlist/mix), play only that video. */
function isSingleVideoLink(input) {
  const url = new URL(input);
  const host = url.hostname.replace(/^(www|m)\./, '');
  if (host === 'youtu.be') return true;
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    return url.searchParams.has('v') || /^\/(shorts|live|embed)\//.test(url.pathname);
  }
  return false;
}

function isContainerEntry(entry) {
  return entry?._type === 'playlist' || entry?.ie_key === 'YoutubeTab';
}

function isPlayableEntry(entry) {
  if (!entry || isContainerEntry(entry)) return false;
  if (entry.title === '[Private video]' || entry.title === '[Deleted video]') return false;
  return Boolean(entry.url || entry.webpage_url);
}

function bestThumbnail(info) {
  return info.thumbnail || info.thumbnails?.at(-1)?.url || null;
}

function trackFromInfo(info, fallbackUrl, requester) {
  const url = info.webpage_url || info.original_url || fallbackUrl;
  return createTrack({
    title: info.title || info.fulltitle,
    author: info.artist || info.uploader || info.channel || info.creator || null,
    url,
    playUrl: url,
    duration: info.duration,
    thumbnail: bestThumbnail(info),
    isLive: info.is_live || info.live_status === 'is_live',
    requester,
  });
}

function trackFromEntry(entry, requester) {
  const isYoutube = entry.ie_key === 'Youtube' || /youtube\.com|youtu\.be/.test(entry.url || '');
  const playUrl = entry.url || entry.webpage_url;
  return createTrack({
    title: entry.title || playUrl,
    author: entry.channel || entry.uploader || null,
    url: entry.webpage_url || playUrl,
    playUrl,
    duration: entry.duration,
    thumbnail: (isYoutube && youtubeThumbnail(entry.id)) || bestThumbnail(entry),
    isLive: entry.live_status === 'is_live',
    needsMetadata: !entry.title,
    requester,
  });
}

/**
 * Turns user input (a link of any supported kind, or free-text search) into queueable tracks.
 * @returns {Promise<{ tracks: object[], playlist: { title: string, url: string } | null, notice?: string }>}
 */
export async function resolveQuery(rawInput, { requester = null, limit = 300 } = {}) {
  const input = String(rawInput || '').trim().replace(/^<(.+)>$/, '$1');
  if (!input) throw new UserError('Give me a link or something to search for.');

  if (parseSpotifyUrl(input)) {
    const result = await spotify.resolve(input, { limit });
    const tracks = result.tracks.slice(0, limit).map((t) => createTrack({ ...t, source: 'spotify', requester }));
    if (!tracks.length) throw new UserError(`That Spotify ${result.type || 'link'} has no playable tracks.`);
    const playlist = result.type === 'track' ? null : { title: result.title, url: result.url };
    return { tracks, playlist, notice: result.notice || null };
  }

  if (isHttpUrl(input)) return resolveUrl(input, { requester, limit });

  const [first] = await search(input, 1);
  if (!first) throw new UserError(`No results for "${truncate(input, 80)}".`);
  return {
    tracks: [createTrack({
      title: first.title,
      author: first.channel,
      url: first.url,
      playUrl: first.url,
      duration: first.duration,
      thumbnail: first.thumbnail,
      isLive: first.isLive,
      source: 'youtube',
      requester,
    })],
    playlist: null,
  };
}

async function resolveUrl(input, { requester, limit, depth = 0 }) {
  const info = await extractInfo(input, { flat: true, noPlaylist: isSingleVideoLink(input), playlistEnd: limit });

  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    const entries = (info.entries || []).filter(Boolean);
    // Channel pages list their tabs (Videos, Shorts, …) as entries; descend into the first one.
    if (depth === 0 && entries.length && entries.every(isContainerEntry) && entries[0].url) {
      return resolveUrl(entries[0].url, { requester, limit, depth: 1 });
    }
    const tracks = entries.filter(isPlayableEntry).slice(0, limit).map((e) => trackFromEntry(e, requester));
    if (!tracks.length) throw new UserError('That playlist is empty or none of its items are available.');
    return { tracks, playlist: { title: info.title || 'Playlist', url: info.webpage_url || input } };
  }

  return { tracks: [trackFromInfo(info, input, requester)], playlist: null };
}

/** Fills in title/duration for tracks that came from a flat playlist listing without metadata. */
export async function hydrateTrack(track) {
  if (!track.needsMetadata) return track;
  const info = await extractInfo(track.playUrl || track.url, { noPlaylist: true, timeout: 45_000 });
  track.title = info.title || track.title;
  track.author = info.uploader || info.channel || track.author;
  track.duration = Number.isFinite(info.duration) ? Math.round(info.duration) : track.duration;
  track.thumbnail = bestThumbnail(info) || track.thumbnail;
  track.url = info.webpage_url || track.url;
  track.isLive = Boolean(info.is_live || info.live_status === 'is_live');
  track.needsMetadata = false;
  return track;
}
