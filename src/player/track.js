import { randomUUID } from 'node:crypto';

export function detectSource(url) {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'other';
  }
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return 'youtube';
  if (/(^|\.)spotify\.com$/.test(host)) return 'spotify';
  if (/(^|\.)soundcloud\.com$/.test(host)) return 'soundcloud';
  if (/(^|\.)bandcamp\.com$/.test(host)) return 'bandcamp';
  if (/(^|\.)twitch\.tv$/.test(host)) return 'twitch';
  if (/(^|\.)discordapp\.(com|net)$|(^|\.)discord\.com$/.test(host)) return 'file';
  return 'web';
}

/**
 * A queue entry. `url` is the page users see; `playUrl` is what yt-dlp streams (null until a Spotify
 * track has been matched to YouTube).
 */
export function createTrack(data) {
  const duration = Number(data.duration);
  return {
    id: randomUUID(),
    title: data.title || 'Unknown title',
    author: data.author || null,
    url: data.url || null,
    playUrl: data.playUrl ?? null,
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    thumbnail: data.thumbnail || null,
    source: data.source || detectSource(data.url),
    isLive: Boolean(data.isLive),
    needsMetadata: Boolean(data.needsMetadata),
    requester: data.requester || null,
    addedAt: Date.now(),
  };
}

/** A copy with a new id, used when a track re-enters the queue (loop mode, history, "play again"). */
export function cloneTrack(track) {
  const { _resolving, ...rest } = track;
  return { ...rest, id: randomUUID(), addedAt: Date.now() };
}

export function serializeTrack(track) {
  return {
    id: track.id,
    title: track.title,
    author: track.author,
    url: track.url,
    duration: track.duration,
    thumbnail: track.thumbnail,
    source: track.source,
    isLive: track.isLive,
    requester: track.requester,
    matchedTitle: track.source === 'spotify' ? track.matchedTitle || null : undefined,
  };
}
