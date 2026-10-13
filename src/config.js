import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';
import { hashPassword } from './security.js';
import { UserError, splitArgs } from './util.js';

const log = createLogger('config');

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const COOKIES_PATH = path.join(DATA_DIR, 'youtube-cookies.txt');

const DEFAULTS = {
  discord: {
    token: '',
    prefix: '!',
    activity: '{prefix}play <link>',
  },
  playback: {
    defaultVolume: 80,
    maxQueueSize: 1000,
    maxPlaylistSize: 300,
    idleTimeout: 300,
    emptyChannelTimeout: 60,
    announceNowPlaying: true,
    normalizeAudio: false,
    djRole: '',
    requireSameChannel: true,
    queueRoles: [],
  },
  youtube: {
    potProviderUrl: '',
    autoUpdate: true,
    extraArgs: '',
  },
  spotify: {
    clientId: '',
    clientSecret: '',
    market: 'US',
    embedFallback: true,
    refreshToken: '',
    userName: '',
  },
  web: {
    passwordHash: '',
    sessionSecret: '',
    publicUrl: '',
  },
};

/**
 * yt-dlp options an admin may add from the dashboard. This is an allowlist on purpose: options such as
 * --exec or --plugin-dirs would let the dashboard run arbitrary code inside the container.
 * The value is the number of arguments the option takes.
 */
const YTDLP_ALLOWED_OPTIONS = new Map([
  ['--proxy', 1], ['--extractor-args', 1], ['--geo-bypass-country', 1], ['--xff', 1],
  ['--source-address', 1], ['-4', 0], ['--force-ipv4', 0], ['-6', 0], ['--force-ipv6', 0],
  ['--socket-timeout', 1], ['--sleep-requests', 1], ['--limit-rate', 1], ['-r', 1],
  ['--throttled-rate', 1], ['--retries', 1], ['-R', 1], ['--fragment-retries', 1],
  ['--http-chunk-size', 1], ['--concurrent-fragments', 1], ['-N', 1], ['--impersonate', 1],
  ['--add-headers', 1], ['--user-agent', 1], ['--referer', 1], ['--format-sort', 1], ['-S', 1],
  ['--no-check-certificates', 0], ['--geo-verification-proxy', 1], ['--verbose', 0], ['-v', 0],
]);

export function validateYtdlpArgs(value) {
  const args = splitArgs(value);
  for (let i = 0; i < args.length; i++) {
    const [option, inlineValue] = args[i].split(/=(.*)/s, 2);
    const arity = YTDLP_ALLOWED_OPTIONS.get(option);
    if (arity === undefined) {
      throw new UserError(
        `yt-dlp option "${option}" is not allowed. Allowed: ${[...YTDLP_ALLOWED_OPTIONS.keys()].join(', ')}`,
      );
    }
    if (arity === 1 && inlineValue === undefined) {
      if (i + 1 >= args.length) throw new UserError(`yt-dlp option "${option}" needs a value.`);
      i++;
    }
  }
  return args;
}

/** Settings that can be changed from the dashboard, with their validation rules. */
export const SETTINGS_SCHEMA = {
  'discord.token': { type: 'secret', max: 200 },
  'discord.prefix': { type: 'string', min: 1, max: 5, noSpaces: true },
  'discord.activity': { type: 'string', max: 120 },
  'playback.defaultVolume': { type: 'int', min: 0, max: 200 },
  'playback.maxQueueSize': { type: 'int', min: 1, max: 10000 },
  'playback.maxPlaylistSize': { type: 'int', min: 1, max: 5000 },
  'playback.idleTimeout': { type: 'int', min: 0, max: 86400 },
  'playback.emptyChannelTimeout': { type: 'int', min: 0, max: 86400 },
  'playback.announceNowPlaying': { type: 'bool' },
  'playback.normalizeAudio': { type: 'bool' },
  'playback.djRole': { type: 'string', max: 100 },
  'playback.requireSameChannel': { type: 'bool' },
  // Role IDs allowed to queue songs. A server with none of its roles listed is open to everyone.
  'playback.queueRoles': { type: 'roleIds', max: 250 },
  'youtube.potProviderUrl': { type: 'url' },
  'youtube.autoUpdate': { type: 'bool' },
  'youtube.extraArgs': { type: 'string', max: 1000, validate: validateYtdlpArgs },
  'spotify.clientId': { type: 'string', max: 100 },
  'spotify.clientSecret': { type: 'secret', max: 100 },
  'spotify.market': { type: 'string', upper: true, pattern: /^[A-Z]{2}$/, message: 'Market must be a two-letter country code, e.g. US.' },
  'spotify.embedFallback': { type: 'bool' },
  'web.publicUrl': { type: 'url' },
};

/** Validates and normalises one dashboard-submitted value. Returns undefined for "leave unchanged". */
export function coerceSetting(key, value) {
  const rule = SETTINGS_SCHEMA[key];
  if (!rule) throw new UserError(`Unknown setting "${key}".`);
  const label = key.split('.').pop();

  switch (rule.type) {
    case 'secret': {
      if (value === null) return '';
      if (value === undefined || value === '') return undefined;
      if (typeof value !== 'string') throw new UserError(`${label} must be text.`);
      const trimmed = value.trim();
      if (trimmed.length > rule.max) throw new UserError(`${label} is too long.`);
      return trimmed;
    }
    case 'string': {
      if (typeof value !== 'string') throw new UserError(`${label} must be text.`);
      const trimmed = rule.upper ? value.trim().toUpperCase() : value.trim();
      if (rule.min && trimmed.length < rule.min) throw new UserError(`${label} cannot be empty.`);
      if (rule.max && trimmed.length > rule.max) throw new UserError(`${label} is too long (max ${rule.max}).`);
      if (rule.noSpaces && /\s/.test(trimmed)) throw new UserError(`${label} cannot contain spaces.`);
      if (rule.pattern && !rule.pattern.test(trimmed)) throw new UserError(rule.message || `${label} is invalid.`);
      if (rule.validate && trimmed) rule.validate(trimmed);
      return trimmed;
    }
    case 'url': {
      if (typeof value !== 'string') throw new UserError(`${label} must be text.`);
      const trimmed = value.trim().replace(/\/+$/, '');
      if (!trimmed) return '';
      let url;
      try {
        url = new URL(trimmed);
      } catch {
        throw new UserError(`${label} must be a full URL, e.g. http://example.com:8080`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UserError(`${label} must be http(s).`);
      return trimmed;
    }
    case 'int': {
      const num = typeof value === 'string' ? Number(value.trim()) : value;
      if (!Number.isInteger(num)) throw new UserError(`${label} must be a whole number.`);
      if (num < rule.min || num > rule.max) throw new UserError(`${label} must be between ${rule.min} and ${rule.max}.`);
      return num;
    }
    case 'roleIds': {
      if (!Array.isArray(value)) throw new UserError(`${label} must be a list of role IDs.`);
      const ids = [...new Set(value.map((id) => String(id).trim()))];
      if (ids.some((id) => !/^\d{17,20}$/.test(id))) throw new UserError(`${label} contains an invalid role ID.`);
      if (ids.length > rule.max) throw new UserError(`${label} can hold at most ${rule.max} roles.`);
      return ids;
    }
    case 'bool':
      if (typeof value !== 'boolean') throw new UserError(`${label} must be true or false.`);
      return value;
    default:
      throw new UserError(`Unsupported setting type for ${key}.`);
  }
}

function mergeDeep(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (!(key in target)) continue; // drop unknown/obsolete keys
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof target[key] === 'object') {
      mergeDeep(target[key], value);
    } else if (typeof value === typeof target[key]) {
      target[key] = value;
    }
  }
  return target;
}

const sameValue = (a, b) =>
  a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

class ConfigStore extends EventEmitter {
  constructor() {
    super();
    this.data = structuredClone(DEFAULTS);
  }

  async load() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let stored = {};
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      } catch (err) {
        const backup = `${CONFIG_PATH}.corrupt-${Date.now()}`;
        fs.copyFileSync(CONFIG_PATH, backup);
        log.error(`Could not parse ${CONFIG_PATH} (${err.message}); starting from defaults. Old file saved to ${backup}`);
      }
    }
    this.data = mergeDeep(structuredClone(DEFAULTS), stored);
    await this.#applyEnvironmentSeeds();
    if (!this.data.web.sessionSecret) this.data.web.sessionSecret = crypto.randomBytes(32).toString('hex');
    this.save();
    log.info(`Settings loaded from ${CONFIG_PATH}`);
  }

  /** Environment variables pre-fill empty settings, so the dashboard stays the source of truth afterwards. */
  async #applyEnvironmentSeeds() {
    const seeds = {
      'discord.token': process.env.DISCORD_TOKEN,
      'discord.prefix': process.env.COMMAND_PREFIX,
      'spotify.clientId': process.env.SPOTIFY_CLIENT_ID,
      'spotify.clientSecret': process.env.SPOTIFY_CLIENT_SECRET,
      'youtube.potProviderUrl': process.env.POT_PROVIDER_URL,
      'web.publicUrl': process.env.PUBLIC_URL,
    };
    for (const [key, value] of Object.entries(seeds)) {
      if (!value || this.getPath(key)) continue;
      try {
        const coerced = coerceSetting(key, value);
        if (coerced !== undefined) this.setPath(key, coerced);
      } catch (err) {
        log.warn(`Ignoring environment value for ${key}: ${err.message}`);
      }
    }
    if (process.env.ADMIN_PASSWORD && !this.data.web.passwordHash) {
      if (process.env.ADMIN_PASSWORD.length < 8) {
        log.warn('ADMIN_PASSWORD is shorter than 8 characters and was ignored.');
      } else {
        this.data.web.passwordHash = await hashPassword(process.env.ADMIN_PASSWORD);
        log.info('Dashboard password set from ADMIN_PASSWORD.');
      }
    }
  }

  get() {
    return this.data;
  }

  getPath(key) {
    return key.split('.').reduce((node, part) => node?.[part], this.data);
  }

  setPath(key, value) {
    const parts = key.split('.');
    const last = parts.pop();
    const parent = parts.reduce((node, part) => node[part], this.data);
    parent[last] = value;
  }

  /** Applies { 'section.key': value } changes, persists them and emits "change" with the changed keys. */
  update(changes) {
    const changed = [];
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      if (!sameValue(this.getPath(key), value)) {
        this.setPath(key, value);
        changed.push(key);
      }
    }
    if (changed.length) {
      this.save();
      this.emit('change', changed);
    }
    return changed;
  }

  save() {
    const tmp = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CONFIG_PATH);
  }
}

export const config = new ConfigStore();
