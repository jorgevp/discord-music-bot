import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import { GuildPlayer } from './guildPlayer.js';

/** Owns one GuildPlayer per Discord server and re-emits their events with the player attached. */
class PlayerManager extends EventEmitter {
  constructor() {
    super();
    this.players = new Map();
  }

  attach(client) {
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      const player = this.players.get(newState.guild.id);
      if (!player) return;
      player.checkEmptyChannel();
      player.emitUpdate();
    });
    client.on(Events.GuildDelete, (guild) => this.destroy(guild.id));
  }

  get(guildId) {
    return this.players.get(guildId) ?? null;
  }

  obtain(guild) {
    let player = this.players.get(guild.id);
    if (!player) {
      player = new GuildPlayer(guild);
      player.on('update', () => this.emit('update', player));
      player.on('trackStart', (track) => this.emit('trackStart', player, track));
      player.on('trackError', (track, error) => this.emit('trackError', player, track, error));
      player.on('notice', (message) => this.emit('notice', player, message));
      this.players.set(guild.id, player);
    }
    return player;
  }

  destroy(guildId) {
    const player = this.players.get(guildId);
    if (!player) return;
    this.players.delete(guildId);
    player.destroy();
    this.emit('removed', guildId);
  }

  destroyAll() {
    for (const guildId of [...this.players.keys()]) this.destroy(guildId);
  }
}

export const players = new PlayerManager();
