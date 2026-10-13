/** An error whose message is safe and useful to show to end users (Discord replies, dashboard toasts). */
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 75 -> "1:15", 3725 -> "1:02:05". Unknown durations render as "--:--". */
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Parses "90", "1:30", "1:02:03" or "1h2m3s" into seconds. Returns null when unparseable. */
export function parseTimestamp(input) {
  const str = String(input ?? '').trim().toLowerCase();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str);
  if (/^\d+(:\d{1,2}){1,2}$/.test(str)) {
    return str.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  }
  const match = str.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/);
  if (match && (match[1] || match[2] || match[3])) {
    return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  }
  return null;
}

export function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function truncate(text, max) {
  const str = String(text ?? '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Splits a command-line style string into arguments, honouring single and double quotes. */
export function splitArgs(input) {
  const args = [];
  let current = '';
  let quote = null;
  let hasToken = false;
  for (const char of String(input ?? '')) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) args.push(current);
      current = '';
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (quote) throw new UserError('Unbalanced quotes in arguments.');
  if (hasToken) args.push(current);
  return args;
}
