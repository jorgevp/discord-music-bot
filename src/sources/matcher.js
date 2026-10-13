import { createLogger } from '../logger.js';
import { UserError } from '../util.js';
import { search } from './ytdlp.js';

const log = createLogger('matcher');
const cache = new Map();
const CACHE_LIMIT = 5000;

// Words that indicate an alternate version; penalised unless the original title contains them too.
const ALTERNATE_VERSION_WORDS = [
  'live', 'cover', 'remix', 'karaoke', 'instrumental', 'acoustic', '8d', 'slowed', 'reverb', 'sped up',
  'nightcore', 'reaction', 'tutorial', 'lesson', 'mashup', 'bass boosted', 'extended', 'hour', 'loop', 'shorts',
];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreCandidate(candidate, track) {
  const title = ` ${normalize(candidate.title)} `;
  const channel = normalize(candidate.channel);
  const baseTitle = normalize(track.title.replace(/\((feat|ft|with)\.?[^)]*\)/gi, '').replace(/\s-\s.*$/, ''));
  const original = ` ${normalize(`${track.title} ${track.author}`)} `;
  let score = 0;

  const words = baseTitle.split(' ').filter(Boolean);
  if (words.length) score += (words.filter((w) => title.includes(` ${w} `)).length / words.length) * 40;

  const artists = String(track.author || '').split(',').map(normalize).filter(Boolean);
  if (artists.some((a) => channel.includes(a) || title.includes(` ${a} `))) score += 15;
  if (/ - topic$/i.test(candidate.channel || '')) score += 10; // YouTube's auto-generated official audio
  if (/vevo$/i.test(candidate.channel || '')) score += 5;

  if (track.duration && candidate.duration) {
    const diff = Math.abs(candidate.duration - track.duration);
    if (diff <= 2) score += 25;
    else if (diff <= 5) score += 15;
    else if (diff <= 15) score += 5;
    else score -= Math.min(diff / 3, 40);
  }
  for (const word of ALTERNATE_VERSION_WORDS) {
    if (title.includes(` ${word} `) && !original.includes(` ${word} `)) score -= 15;
  }
  if (candidate.isLive) score -= 50;
  return score;
}

async function findYouTubeMatch(track) {
  const artists = String(track.author || '').split(',').slice(0, 2).join(' ').trim();
  const query = artists ? `${artists} - ${track.title}` : track.title;
  const results = await search(query, 6);
  if (!results.length) return null;
  const ranked = results
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, track) }))
    .sort((a, b) => b.score - a.score);
  log.debug(`Matched "${query}" → "${ranked[0].candidate.title}" (score ${ranked[0].score.toFixed(1)})`);
  return ranked[0].candidate;
}

/**
 * Makes sure a track has something yt-dlp can stream. Spotify tracks only carry metadata, so they are
 * matched to the closest YouTube upload (preferring same duration and official "Topic" channels).
 */
export async function resolvePlayable(track) {
  if (track.playUrl) return track.playUrl;
  if (track._resolving) return track._resolving;

  track._resolving = (async () => {
    const key = track.url || `${track.author} - ${track.title}`;
    let match = cache.get(key);
    if (!match) {
      match = await findYouTubeMatch(track);
      if (!match) throw new UserError(`No playable match found for "${track.author} - ${track.title}".`);
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
      cache.set(key, match);
    }
    track.playUrl = match.url;
    track.matchedTitle = match.title;
    return track.playUrl;
  })();

  try {
    return await track._resolving;
  } finally {
    track._resolving = null;
  }
}
