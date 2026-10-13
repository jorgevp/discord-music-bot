import { EventEmitter } from 'node:events';
import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { players } from '../player/manager.js';
import { truncate } from '../util.js';
import { handleMessage } from './commands.js';
import { COLORS, nowPlayingEmbed, simpleEmbed, trackLink } from './embeds.js';

const log = createLogger('discord');

export const INVITE_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
]).bitfield;

function describeLoginError(err) {
  const message = String(err?.message || err);
  if (err?.code === 'TokenInvalid' || /invalid token/i.test(message)) {
    return 'The bot token is invalid. Reset it in the Discord Developer Portal (Bot → Reset Token) and paste the new one.';
  }
  if (/disallowed intents/i.test(message)) {
    return 'Discord refused the "Message Content" intent. Enable it in the Developer Portal under Bot → Privileged Gateway Intents, then restart the bot.';
  }
  return message;
}

/** Owns the discord.js client: (re)starts it when the token changes and exposes status to the dashboard. */
class BotManager extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.status = 'stopped';
    this.error = null;
    this.queue = Promise.resolve();
    this.announcements = new Map();

    players.on('trackStart', (player, track) => this.#announceTrack(player, track));
    players.on('trackError', (player, track, error) =>
      this.#send(player, { embeds: [simpleEmbed(`⚠️ Couldn't play ${trackLink(track)}: ${truncate(error.message, 300)}`, COLORS.warning)] }),
    );
    players.on('notice', (player, message) => this.#send(player, { embeds: [simpleEmbed(message, COLORS.warning)] }));
  }

  get ready() {
    return this.status === 'online' && Boolean(this.client?.isReady());
  }

  #setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.emit('status');
  }

  /** start/stop/restart are serialised so rapid settings changes can't race each other. */
  #enqueue(task) {
    this.queue = this.queue.then(task, task);
    return this.queue;
  }

  start() {
    return this.#enqueue(() => this.#start());
  }

  stop() {
    return this.#enqueue(() => this.#stop());
  }

  restart() {
    return this.#enqueue(async () => {
      await this.#stop();
      await this.#start();
    });
  }

  async #start() {
    const { token } = config.get().discord;
    if (!token) {
      log.warn('No Discord bot token configured yet. Add one in the dashboard (Settings → Discord).');
      this.#setStatus('unconfigured');
      return;
    }

    this.#setStatus('connecting');
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      allowedMentions: { parse: [], repliedUser: false },
    });
    this.client = client;

    client.once(Events.ClientReady, (c) => {
      log.info(`Logged in as ${c.user.tag}; in ${c.guilds.cache.size} server(s).`);
      this.#setStatus('online');
      this.applyPresence();
      this.emit('guilds');
    });
    client.on(Events.MessageCreate, (message) => {
      handleMessage(message).catch((err) => log.error('Message handler failed:', err));
    });
    client.on(Events.GuildCreate, (guild) => {
      log.info(`Joined server "${guild.name}"`);
      this.emit('guilds');
    });
    client.on(Events.GuildDelete, (guild) => {
      log.info(`Removed from server "${guild.name ?? guild.id}"`);
      this.emit('guilds');
    });
    client.on(Events.ShardDisconnect, () => {
      if (this.client === client) this.#setStatus('reconnecting');
    });
    client.on(Events.ShardResume, () => this.client === client && this.#setStatus('online'));
    client.on(Events.ShardReady, () => this.client === client && client.isReady() && this.#setStatus('online'));
    client.on(Events.Error, (err) => log.error('Discord client error:', err));
    client.on(Events.Warn, (warning) => log.warn(warning));
    players.attach(client);

    try {
      await client.login(token);
    } catch (err) {
      const message = describeLoginError(err);
      log.error(`Discord login failed: ${message}`);
      if (this.client === client) this.client = null;
      await client.destroy().catch(() => {});
      this.#setStatus('error', message);
    }
  }

  async #stop() {
    players.destroyAll();
    const client = this.client;
    this.client = null;
    if (client) {
      await client.destroy().catch((err) => log.warn('Error while disconnecting:', err));
      log.info('Disconnected from Discord.');
    }
    this.#setStatus('stopped');
  }

  applyPresence() {
    if (!this.client?.user) return;
    const { activity, prefix } = config.get().discord;
    const text = (activity || '').replaceAll('{prefix}', prefix || '!').trim();
    this.client.user.setPresence({ activities: text ? [{ name: text, type: ActivityType.Listening }] : [], status: 'online' });
  }

  async #send(player, payload) {
    if (!this.client || !player.textChannelId) return null;
    try {
      const channel = await this.client.channels.fetch(player.textChannelId);
      if (!channel?.isTextBased()) return null;
      return await channel.send(payload);
    } catch (err) {
      log.warn(`Could not send a message to channel ${player.textChannelId}: ${err.message}`);
      return null;
    }
  }

  /** Posts "Now playing" and deletes the previous announcement to keep the channel tidy. */
  async #announceTrack(player, track) {
    if (!config.get().playback.announceNowPlaying) return;
    const previous = this.announcements.get(player.guildId);
    const message = await this.#send(player, { embeds: [nowPlayingEmbed(player, track)] });
    if (message) this.announcements.set(player.guildId, message);
    if (previous) previous.delete().catch(() => {});
  }

  info() {
    const user = this.client?.user;
    const applicationId = this.client?.application?.id || user?.id || null;
    return {
      status: this.status,
      error: this.error,
      user: user ? { id: user.id, tag: user.tag, name: user.displayName || user.username, avatar: user.displayAvatarURL({ size: 128 }) } : null,
      applicationId,
      inviteUrl: applicationId
        ? `https://discord.com/oauth2/authorize?client_id=${applicationId}&permissions=${INVITE_PERMISSIONS}&scope=bot&integration_type=0`
        : null,
      guildCount: this.client?.guilds.cache.size ?? 0,
      prefix: config.get().discord.prefix,
    };
  }

  guildSummaries() {
    if (!this.ready) return [];
    return [...this.client.guilds.cache.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((guild) => {
        const player = players.get(guild.id);
        return {
          id: guild.id,
          name: guild.name,
          icon: guild.iconURL({ size: 64 }),
          memberCount: guild.memberCount,
          connected: Boolean(player?.connected),
          status: player?.status ?? 'idle',
          nowPlaying: player?.current ? player.current.title : null,
          queueLength: player?.queue.length ?? 0,
        };
      });
  }

  /** Assignable roles per server (no @everyone, no bot-managed roles), highest first. Null while offline. */
  rolesOverview() {
    if (!this.ready) return null;
    return [...this.client.guilds.cache.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((guild) => ({
        id: guild.id,
        name: guild.name,
        roles: [...guild.roles.cache.values()]
          .filter((role) => role.id !== guild.id && !role.managed)
          .sort((a, b) => b.position - a.position)
          .map((role) => ({ id: role.id, name: role.name, color: role.colors?.primaryColor ? role.hexColor : null })),
      }));
  }

  guildDetail(guild) {
    const me = guild.members.me;
    const channels = [...guild.channels.cache.values()].sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
    return {
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL({ size: 128 }),
      voiceChannels: channels
        .filter((c) => c.isVoiceBased())
        .map((c) => ({
          id: c.id,
          name: c.name,
          stage: c.type === ChannelType.GuildStageVoice,
          members: c.members.filter((m) => !m.user.bot).size,
          canJoin: Boolean(me && c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])),
        })),
      textChannels: channels
        .filter((c) => c.isTextBased() && !c.isVoiceBased() && !c.isThread())
        .map((c) => ({
          id: c.id,
          name: c.name,
          canSend: Boolean(me && c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])),
        })),
    };
  }
}

export const bot = new BotManager();
