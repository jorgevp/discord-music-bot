import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import { formatDuration, truncate } from '../util.js';

export const COLORS = {
  brand: 0x8b5cf6,
  success: 0x22c55e,
  warning: 0xf59e0b,
  error: 0xef4444,
};

const SOURCE_LABELS = {
  youtube: 'YouTube',
  spotify: 'Spotify',
  soundcloud: 'SoundCloud',
  bandcamp: 'Bandcamp',
  twitch: 'Twitch',
  file: 'File',
  web: 'Web',
};

export function trackLink(track, max = 70) {
  const title = escapeMarkdown(truncate(track.title, max)).replace(/[[\]]/g, '');
  return track.url ? `[${title}](${track.url})` : `**${title}**`;
}

export function trackDuration(track) {
  return track.isLive ? 'LIVE' : formatDuration(track.duration);
}

export function progressBar(positionMs, durationSec, size = 16) {
  if (!durationSec) return '';
  const ratio = Math.min(1, Math.max(0, positionMs / 1000 / durationSec));
  const filled = Math.round(ratio * size);
  return `${'▬'.repeat(filled)}🔘${'▬'.repeat(Math.max(0, size - filled))}`;
}

const requesterName = (track) => track.requester?.name || 'someone';

export function simpleEmbed(text, color = COLORS.brand) {
  return new EmbedBuilder().setColor(color).setDescription(text);
}

export function nowPlayingEmbed(player, track = player.current, { withProgress = false } = {}) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor({ name: player.paused ? 'Paused' : 'Now playing' })
    .setDescription(`${trackLink(track, 90)}${track.author ? `\n${escapeMarkdown(truncate(track.author, 80))}` : ''}`);
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);

  if (withProgress && track.duration && !track.isLive) {
    embed.addFields({
      name: '​',
      value: `${progressBar(player.position, track.duration)}\n\`${formatDuration(player.position / 1000)} / ${formatDuration(track.duration)}\``,
    });
  } else {
    embed.addFields({ name: 'Duration', value: trackDuration(track), inline: true });
  }
  embed.addFields({ name: 'Requested by', value: escapeMarkdown(requesterName(track)), inline: true });
  if (player.queue[0]) embed.addFields({ name: 'Up next', value: trackLink(player.queue[0], 60), inline: true });

  const footer = [`Volume ${player.volume}%`, `Loop: ${player.loop}`, `${player.queue.length} in queue`, SOURCE_LABELS[track.source] || track.source];
  if (track.source === 'spotify' && track.matchedTitle) footer.push(`matched "${truncate(track.matchedTitle, 40)}"`);
  return embed.setFooter({ text: footer.join(' • ') });
}

export function queuedEmbed(track, position, player) {
  const ahead = player.queue.slice(0, position - 1).reduce((sum, t) => sum + (t.duration || 0), 0);
  const remaining = player.current?.duration ? Math.max(0, player.current.duration - player.position / 1000) : 0;
  const eta = player.current ? formatDuration(ahead + remaining) : 'now';
  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setAuthor({ name: 'Added to queue' })
    .setDescription(trackLink(track, 90))
    .addFields(
      { name: 'Position', value: `#${position}`, inline: true },
      { name: 'Duration', value: trackDuration(track), inline: true },
      { name: 'Plays in', value: eta, inline: true },
    );
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

export function playlistEmbed(playlist, added, dropped, notice) {
  const lines = [`Queued **${added}** track${added === 1 ? '' : 's'} from ${playlist.url ? `[${escapeMarkdown(truncate(playlist.title, 80))}](${playlist.url})` : `**${escapeMarkdown(playlist.title)}**`}.`];
  if (dropped) lines.push(`${dropped} track${dropped === 1 ? ' was' : 's were'} skipped because the queue is full.`);
  if (notice) lines.push(`-# ${notice}`);
  return new EmbedBuilder().setColor(COLORS.success).setDescription(lines.join('\n'));
}

export function queueEmbed(player, page = 1, perPage = 10) {
  const pages = Math.max(1, Math.ceil(player.queue.length / perPage));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * perPage;
  const lines = player.queue
    .slice(start, start + perPage)
    .map((t, i) => `\`${String(start + i + 1).padStart(2, ' ')}.\` ${trackLink(t, 55)} \`${trackDuration(t)}\``);

  const total = player.queue.reduce((sum, t) => sum + (t.duration || 0), 0);
  const embed = new EmbedBuilder().setColor(COLORS.brand).setAuthor({ name: 'Queue' });
  const nowPlaying = player.current
    ? `**Now playing:** ${trackLink(player.current, 60)} \`${formatDuration(player.position / 1000)} / ${trackDuration(player.current)}\``
    : '**Nothing playing.**';
  embed.setDescription([nowPlaying, '', lines.length ? lines.join('\n') : '*The queue is empty.*'].join('\n'));
  embed.setFooter({
    text: `Page ${current}/${pages} • ${player.queue.length} track${player.queue.length === 1 ? '' : 's'} • ${formatDuration(total)} total • Loop: ${player.loop}`,
  });
  return embed;
}
