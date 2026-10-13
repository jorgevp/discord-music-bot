import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { LOOP_MODES } from '../player/guildPlayer.js';
import { players } from '../player/manager.js';
import { resolveQuery } from '../sources/resolver.js';
import { UserError, formatDuration, parseTimestamp } from '../util.js';
import { COLORS, nowPlayingEmbed, playlistEmbed, queueEmbed, queuedEmbed, simpleEmbed, trackLink } from './embeds.js';

const log = createLogger('commands');

export function requesterFromMember(member) {
  return { id: member.id, name: member.displayName, avatar: member.displayAvatarURL({ size: 64 }) };
}

/** Parses a 1-based queue position argument. */
function queueIndex(arg, player) {
  const n = Number.parseInt(arg, 10);
  if (!Number.isInteger(n) || n < 1 || n > player.queue.length) {
    throw new UserError(player.queue.length ? `Pick a queue position between 1 and ${player.queue.length}.` : 'The queue is empty.');
  }
  return n - 1;
}

function requirePlayer(ctx) {
  const player = players.get(ctx.guild.id);
  if (!player || (!player.current && !player.queue.length && !player.connected)) {
    throw new UserError('Nothing is playing right now.');
  }
  return player;
}

/** True if the member has a role matching an ID or (case-insensitive) name. */
function hasRole(member, nameOrId) {
  const wanted = nameOrId.toLowerCase();
  return member.roles.cache.some((r) => r.id === nameOrId || r.name.toLowerCase() === wanted);
}

/**
 * Queueing is limited to the server's allowed roles (Settings → Playback). Servers without any allowed
 * roles stay open to everyone; admins and the DJ role can always queue.
 */
export function checkQueuePermission(member) {
  const { queueRoles, djRole } = config.get().playback;
  const allowed = queueRoles.filter((id) => member.guild.roles.cache.has(id));
  if (!allowed.length) return;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return;
  if (member.roles.cache.some((r) => allowed.includes(r.id))) return;
  if (djRole && hasRole(member, djRole)) return;
  throw new UserError(
    allowed.length === 1
      ? `You need the <@&${allowed[0]}> role to queue songs.`
      : `Only members with one of these roles can queue songs: ${allowed.map((id) => `<@&${id}>`).join(', ')}.`,
  );
}

/** Control commands: optional DJ role, and the member must be listening with the bot. */
function checkControl(ctx, player) {
  const { djRole, requireSameChannel } = config.get().playback;
  const member = ctx.member;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return;
  if (requireSameChannel && player?.connected && member.voice.channelId !== player.voiceChannelId) {
    throw new UserError(`You need to be in <#${player.voiceChannelId}> to do that.`);
  }
  if (djRole) {
    const aloneWithBot = player?.connected && member.voice.channelId === player.voiceChannelId && player.humanListeners() === 1;
    if (!hasRole(member, djRole) && !aloneWithBot) throw new UserError(`You need the **${djRole}** role to do that.`);
  }
}

async function play(ctx, { next = false } = {}) {
  checkQueuePermission(ctx.member); // before joining voice or resolving anything
  const query = ctx.args || ctx.message.attachments.first()?.url;
  if (!query) throw new UserError(`Usage: \`${ctx.prefix}play <link or search terms>\``);
  const voice = ctx.member.voice.channel;
  if (!voice) throw new UserError('Join a voice channel first.');

  const player = players.obtain(ctx.guild);
  if (player.connected && player.voiceChannelId !== voice.id && player.current) {
    throw new UserError(`I'm already playing in <#${player.voiceChannelId}>. Join me there!`);
  }
  if (next) checkControl(ctx, player);
  player.textChannelId = ctx.message.channelId;
  ctx.message.channel.sendTyping().catch(() => {});

  // Resolve the link and join voice in parallel; if resolving fails the idle timer makes the bot leave again.
  const { maxPlaylistSize } = config.get().playback;
  const [result] = await Promise.all([
    resolveQuery(query, { requester: requesterFromMember(ctx.member), limit: maxPlaylistSize }),
    player.connect(voice),
  ]);

  const { added, dropped, position, startsNow } = player.enqueue(result.tracks, { next });
  if (result.playlist) {
    await ctx.reply({ embeds: [playlistEmbed(result.playlist, added, dropped, result.notice)] });
  } else if (startsNow && config.get().playback.announceNowPlaying) {
    await ctx.message.react('🎶').catch(() => {});
  } else if (startsNow) {
    await ctx.reply({ embeds: [simpleEmbed(`Playing ${trackLink(result.tracks[0])}`, COLORS.success)] });
  } else {
    await ctx.reply({ embeds: [queuedEmbed(result.tracks[0], position, player)] });
  }
}

const COMMANDS = [
  {
    name: 'play', aliases: ['p'], usage: '<link | search>',
    description: 'Play a song or playlist from YouTube, Spotify, SoundCloud and more.',
    run: (ctx) => play(ctx),
  },
  {
    name: 'playnext', aliases: ['pn', 'playtop'], usage: '<link | search>',
    description: 'Add a song to the front of the queue.',
    run: (ctx) => play(ctx, { next: true }),
  },
  {
    name: 'skip', aliases: ['s', 'next'], control: true,
    description: 'Skip the current track.',
    run: async (ctx, player) => {
      const skipped = await player.skip();
      await ctx.reply({ embeds: [simpleEmbed(`⏭️ Skipped ${trackLink(skipped)}`)] });
    },
  },
  {
    name: 'previous', aliases: ['prev', 'back'], control: true,
    description: 'Play the previous track again.',
    run: async (ctx, player) => {
      const track = await player.previous();
      await ctx.reply({ embeds: [simpleEmbed(`⏮️ Back to ${trackLink(track)}`)] });
    },
  },
  {
    name: 'pause', control: true, description: 'Pause playback.',
    run: async (ctx, player) => {
      player.pause();
      await ctx.reply({ embeds: [simpleEmbed('⏸️ Paused.')] });
    },
  },
  {
    name: 'resume', aliases: ['unpause', 'continue'], control: true, description: 'Resume playback.',
    run: async (ctx, player) => {
      player.resume();
      await ctx.reply({ embeds: [simpleEmbed('▶️ Resumed.')] });
    },
  },
  {
    name: 'stop', control: true, description: 'Stop playback and clear the queue.',
    run: async (ctx, player) => {
      player.stop();
      await ctx.reply({ embeds: [simpleEmbed('⏹️ Stopped and cleared the queue.')] });
    },
  },
  {
    name: 'leave', aliases: ['disconnect', 'dc'], control: true, description: 'Leave the voice channel and clear the queue.',
    run: async (ctx, player) => {
      player.leave();
      await ctx.reply({ embeds: [simpleEmbed('👋 Left the voice channel.')] });
    },
  },
  {
    name: 'join', aliases: ['summon'], description: 'Join your voice channel (and resume the queue, if any).',
    run: async (ctx) => {
      const voice = ctx.member.voice.channel;
      if (!voice) throw new UserError('Join a voice channel first.');
      const player = players.obtain(ctx.guild);
      if (player.connected && player.current && player.voiceChannelId !== voice.id) checkControl(ctx, player);
      player.textChannelId = ctx.message.channelId;
      await player.connect(voice);
      player.ensurePlaying();
      await ctx.reply({ embeds: [simpleEmbed(`🔊 Joined <#${voice.id}>.`)] });
    },
  },
  {
    name: 'queue', aliases: ['q', 'list'], usage: '[page]', description: 'Show the queue.',
    run: async (ctx) => {
      const player = requirePlayer(ctx);
      await ctx.reply({ embeds: [queueEmbed(player, Number.parseInt(ctx.args, 10) || 1)] });
    },
  },
  {
    name: 'nowplaying', aliases: ['np', 'current'], description: 'Show the current track.',
    run: async (ctx) => {
      const player = requirePlayer(ctx);
      if (!player.current) throw new UserError('Nothing is playing right now.');
      await ctx.reply({ embeds: [nowPlayingEmbed(player, player.current, { withProgress: true })] });
    },
  },
  {
    name: 'remove', aliases: ['rm'], usage: '<position>', control: true, description: 'Remove a track from the queue.',
    run: async (ctx, player) => {
      const removed = player.removeAt(queueIndex(ctx.args, player));
      await ctx.reply({ embeds: [simpleEmbed(`🗑️ Removed ${trackLink(removed)}`)] });
    },
  },
  {
    name: 'move', aliases: ['mv'], usage: '<from> <to>', control: true, description: 'Move a track within the queue.',
    run: async (ctx, player) => {
      const [fromArg, toArg] = ctx.args.split(/\s+/);
      const from = queueIndex(fromArg, player);
      const to = queueIndex(toArg, player);
      const track = player.move(player.queue[from].id, to);
      await ctx.reply({ embeds: [simpleEmbed(`↕️ Moved ${trackLink(track)} to position #${to + 1}`)] });
    },
  },
  {
    name: 'jump', aliases: ['skipto', 'playnow'], usage: '<position>', control: true,
    description: 'Play a queued track right now (the rest of the queue stays).',
    run: async (ctx, player) => {
      const track = await player.jump(player.queue[queueIndex(ctx.args, player)].id);
      await ctx.reply({ embeds: [simpleEmbed(`⏩ Jumped to ${trackLink(track)}`)] });
    },
  },
  {
    name: 'clear', control: true, description: 'Remove every upcoming track (keeps the current one).',
    run: async (ctx, player) => {
      const count = player.clear();
      await ctx.reply({ embeds: [simpleEmbed(`🧹 Cleared ${count} track${count === 1 ? '' : 's'} from the queue.`)] });
    },
  },
  {
    name: 'shuffle', control: true, description: 'Shuffle the queue.',
    run: async (ctx, player) => {
      player.shuffle();
      await ctx.reply({ embeds: [simpleEmbed(`🔀 Shuffled ${player.queue.length} tracks.`)] });
    },
  },
  {
    name: 'loop', aliases: ['repeat'], usage: '[off | track | queue]', control: true,
    description: 'Set the loop mode (cycles through modes when no argument is given).',
    run: async (ctx, player) => {
      const arg = ctx.args.toLowerCase();
      const aliases = { song: 'track', single: 'track', one: 'track', all: 'queue', none: 'off', disable: 'off' };
      const mode = arg ? aliases[arg] || arg : LOOP_MODES[(LOOP_MODES.indexOf(player.loop) + 1) % LOOP_MODES.length];
      player.setLoop(mode);
      const labels = { off: '➡️ Loop is off.', track: '🔂 Looping the current track.', queue: '🔁 Looping the whole queue.' };
      await ctx.reply({ embeds: [simpleEmbed(labels[mode])] });
    },
  },
  {
    name: 'volume', aliases: ['vol', 'v'], usage: '[0-200]', control: true, description: 'Show or change the volume.',
    run: async (ctx, player) => {
      if (!ctx.args) {
        await ctx.reply({ embeds: [simpleEmbed(`🔊 Volume is **${player.volume}%**.`)] });
        return;
      }
      const volume = player.setVolume(Number.parseInt(ctx.args.replace('%', ''), 10));
      await ctx.reply({ embeds: [simpleEmbed(`🔊 Volume set to **${volume}%**.`)] });
    },
  },
  {
    name: 'seek', usage: '<1:23 | 83 | 1m23s>', control: true, description: 'Jump to a position in the current track.',
    run: async (ctx, player) => {
      const seconds = parseTimestamp(ctx.args);
      if (seconds == null) throw new UserError(`Usage: \`${ctx.prefix}seek 1:23\``);
      await player.seek(seconds * 1000);
      await ctx.reply({ embeds: [simpleEmbed(`⏩ Seeked to \`${formatDuration(seconds)}\`.`)] });
    },
  },
  {
    name: 'dashboard', aliases: ['web'], description: 'Link to the web dashboard.',
    run: async (ctx) => {
      const { publicUrl } = config.get().web;
      await ctx.reply({
        embeds: [simpleEmbed(publicUrl ? `🖥️ Dashboard: ${publicUrl}` : 'The dashboard URL is not configured (set a Public URL in its settings).')],
      });
    },
  },
  {
    name: 'help', aliases: ['h', 'commands'], description: 'Show this list.',
    run: async (ctx) => {
      const lines = COMMANDS.map((c) => {
        const aliases = c.aliases?.length ? ` *(${c.aliases.map((a) => ctx.prefix + a).join(', ')})*` : '';
        return `\`${ctx.prefix}${c.name}${c.usage ? ` ${c.usage}` : ''}\`${aliases}\n${c.description}`;
      });
      const embed = new EmbedBuilder()
        .setColor(COLORS.brand)
        .setTitle('Music commands')
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Links: YouTube, YouTube Music, Spotify, SoundCloud, Bandcamp, direct audio files and more.' });
      await ctx.reply({ embeds: [embed] });
    },
  },
];

const LOOKUP = new Map();
for (const command of COMMANDS) {
  for (const name of [command.name, ...(command.aliases || [])]) LOOKUP.set(name, command);
}

export async function handleMessage(message) {
  if (message.author.bot || !message.inGuild() || !message.member) return;
  const prefix = config.get().discord.prefix || '!';
  if (!message.content.startsWith(prefix)) return;

  const body = message.content.slice(prefix.length).trim();
  const name = body.split(/\s+/, 1)[0]?.toLowerCase();
  const command = name && LOOKUP.get(name);
  if (!command) return; // unknown commands are ignored so we don't clash with other bots

  const ctx = {
    message,
    prefix,
    guild: message.guild,
    member: message.member,
    args: body.slice(name.length).trim(),
    reply: (payload) => message.reply({ allowedMentions: { repliedUser: false, parse: [] }, ...payload }),
  };

  try {
    let player = null;
    if (command.control) {
      player = requirePlayer(ctx);
      checkControl(ctx, player);
      player.textChannelId = message.channelId;
    }
    await command.run(ctx, player);
  } catch (err) {
    const userFacing = err instanceof UserError;
    if (!userFacing) log.error(`Command "${name}" failed:`, err);
    const text = userFacing ? err.message : 'Something went wrong running that command. Check the dashboard logs for details.';
    await ctx.reply({ embeds: [simpleEmbed(`❌ ${text}`, COLORS.error)] }).catch((replyErr) => {
      log.warn(`Could not reply in #${message.channel?.name}: ${replyErr.message}`);
    });
  }
}
