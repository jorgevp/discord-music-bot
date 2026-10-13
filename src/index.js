import { generateDependencyReport } from '@discordjs/voice';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('main');

process.on('unhandledRejection', (err) => log.error('Unhandled promise rejection:', err));
process.on('uncaughtException', (err) => log.error('Uncaught exception:', err));

await config.load();

// Imported after the config is loaded so every module sees the stored settings.
const { bot } = await import('./bot/bot.js');
const { startWebServer } = await import('./web/server.js');
const ytdlp = await import('./sources/ytdlp.js');

log.info(`Voice dependencies:\n${generateDependencyReport().trim()}`);

const web = startWebServer();

config.on('change', (keys) => {
  if (keys.includes('discord.token')) {
    log.info('Bot token changed; reconnecting to Discord…');
    bot.restart().catch((err) => log.error('Restart failed:', err));
  } else if (keys.includes('discord.activity') || keys.includes('discord.prefix')) {
    bot.applyPresence();
  }
});

bot.start().catch((err) => log.error('Bot failed to start:', err));

if (config.get().youtube.autoUpdate) {
  ytdlp.update().catch((err) => log.warn(`yt-dlp auto-update failed: ${err.message}`));
} else {
  ytdlp.version().then((v) => log.info(`yt-dlp ${v}`)).catch((err) => log.warn(err.message));
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down…`);
  setTimeout(() => process.exit(1), 8000).unref();
  await bot.stop().catch(() => {});
  await web.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
