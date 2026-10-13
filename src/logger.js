import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_ENTRIES = 1000;

/** Collects log lines in a ring buffer so the dashboard can show (and live-stream) them. */
class LogHub extends EventEmitter {
  constructor() {
    super();
    this.entries = [];
    this.seq = 0;
    this.threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
  }

  write(level, scope, args) {
    if (LEVELS[level] < this.threshold) return;
    const message = args
      .map((arg) => {
        if (arg instanceof Error) return level === 'debug' || level === 'error' ? arg.stack || arg.message : arg.message;
        if (typeof arg === 'string') return arg;
        return inspect(arg, { depth: 3, breakLength: Infinity });
      })
      .join(' ');
    const entry = { id: ++this.seq, time: Date.now(), level, scope, message };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();

    const line = `${new Date(entry.time).toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
    this.emit('entry', entry);
  }

  recent(count = 500) {
    return this.entries.slice(-count);
  }
}

export const logHub = new LogHub();

export function createLogger(scope) {
  return {
    debug: (...args) => logHub.write('debug', scope, args),
    info: (...args) => logHub.write('info', scope, args),
    warn: (...args) => logHub.write('warn', scope, args),
    error: (...args) => logHub.write('error', scope, args),
  };
}
