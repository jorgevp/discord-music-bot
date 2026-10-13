import { EventEmitter } from 'node:events';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { resolvePlayable } from '../sources/matcher.js';
import { hydrateTrack } from '../sources/resolver.js';
import { UserError, formatDuration, shuffleInPlace, sleep } from '../util.js';
import { createAudioStream } from './stream.js';
import { cloneTrack, serializeTrack } from './track.js';

const HISTORY_LIMIT = 50;
const MAX_STREAM_RETRIES = 3;
const MAX_CONSECUTIVE_FAILURES = 5;
export const LOOP_MODES = ['off', 'track', 'queue'];

/**
 * Queue + playback state for one Discord server.
 *
 * Events: "update" (state changed), "trackStart" (track), "trackError" (track, error), "notice" (message).
 */
export class GuildPlayer extends EventEmitter {
  constructor(guild) {
    super();
    this.guild = guild;
    this.guildId = guild.id;
    this.log = createLogger(`player:${guild.name}`);

    this.queue = [];
    this.history = [];
    this.current = null;
    this.loop = 'off';
    this.volume = config.get().playback.defaultVolume;
    this.textChannelId = null;

    this.connection = null;
    this.resource = null;
    this.stream = null;
    this.seekOffset = 0;
    this.pendingAnnounce = null;
    this.loading = false;
    this.playToken = 0;
    this.retries = 0;
    this.failures = 0;
    this.suppressIdle = false;
    this.leaving = false;
    this.idleTimer = null;
    this.emptyTimer = null;
    this.updateScheduled = false;
    this.destroyed = false;

    this.player = createAudioPlayer({
      // Pause (instead of dropping audio) while the voice connection is reconnecting, and tolerate up to
      // 5 s of missing audio data before treating the stream as stalled.
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 250 },
    });
    this.player.on('stateChange', (oldState, newState) => this.#onPlayerStateChange(oldState, newState));
    this.player.on('error', (err) => this.log.warn(`Audio player error: ${err.message}`));
  }

  // ---------------------------------------------------------------- state

  get connected() {
    return Boolean(this.connection) && this.connection.state.status !== VoiceConnectionStatus.Destroyed;
  }

  get voiceChannelId() {
    return this.connected ? this.connection.joinConfig.channelId : null;
  }

  get voiceChannel() {
    const id = this.voiceChannelId;
    return id ? this.guild.channels.cache.get(id) ?? null : null;
  }

  get paused() {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  /** Playback position of the current track in milliseconds. */
  get position() {
    return this.seekOffset + (this.resource?.playbackDuration ?? 0);
  }

  get status() {
    if (!this.current) return 'idle';
    if (this.loading) return 'loading';
    switch (this.player.state.status) {
      case AudioPlayerStatus.Playing:
        return 'playing';
      case AudioPlayerStatus.Paused:
        return 'paused';
      case AudioPlayerStatus.AutoPaused:
        return 'reconnecting';
      default:
        return 'loading';
    }
  }

  humanListeners() {
    const channel = this.voiceChannel;
    return channel ? channel.members.filter((m) => !m.user.bot).size : 0;
  }

  // ---------------------------------------------------------------- voice connection

  async connect(channel) {
    if (!channel?.isVoiceBased?.()) throw new UserError('That is not a voice channel.');
    const me = this.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.Connect)) throw new UserError(`I don't have permission to join **${channel.name}**.`);
    if (!perms.has(PermissionFlagsBits.Speak) && channel.type !== ChannelType.GuildStageVoice) {
      throw new UserError(`I don't have permission to speak in **${channel.name}**.`);
    }
    if (channel.full && !perms.has(PermissionFlagsBits.MoveMembers) && this.voiceChannelId !== channel.id) {
      throw new UserError(`**${channel.name}** is full.`);
    }
    if (this.voiceChannelId === channel.id && this.connection.state.status === VoiceConnectionStatus.Ready) return;

    this.leaving = false;
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: this.guildId,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    if (connection !== this.connection) {
      this.connection = connection;
      this.#bindConnection(connection);
      connection.subscribe(this.player);
    }

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      throw new UserError(`Couldn't connect to **${channel.name}** in time. Check my permissions and try again.`);
    }

    if (channel.type === ChannelType.GuildStageVoice) {
      await me.voice.setSuppressed(false).catch(() => me.voice.setRequestToSpeak(true).catch(() => {}));
    }
    this.log.info(`Connected to voice channel #${channel.name}`);
    if (!this.current && !this.queue.length) this.#startIdleTimer();
    else this.#clearIdleTimer();
    this.checkEmptyChannel();
    this.emitUpdate();
  }

  #bindConnection(connection) {
    connection.on('stateChange', async (oldState, newState) => {
      if (connection !== this.connection) return;
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        if (newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014) {
          // 4014 = moved to another channel or kicked. If we don't start reconnecting soon, we were kicked.
          try {
            await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
          } catch {
            if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
          }
        } else if (connection.rejoinAttempts < 5) {
          this.log.warn(`Voice connection lost; rejoining (attempt ${connection.rejoinAttempts + 1}/5)`);
          await sleep((connection.rejoinAttempts + 1) * 5_000);
          if (connection.state.status === VoiceConnectionStatus.Disconnected) connection.rejoin();
        } else {
          connection.destroy();
        }
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        this.#onConnectionDestroyed(connection);
      }
      if (oldState.status !== newState.status) this.emitUpdate();
    });
    connection.on('error', (err) => this.log.warn(`Voice connection error: ${err.message}`));
  }

  #onConnectionDestroyed(connection) {
    if (connection !== this.connection) return;
    this.connection = null;
    this.#clearEmptyTimer();
    const intentional = this.leaving;
    this.leaving = false;
    if (!intentional && this.current) {
      // Kicked or the connection could not be recovered: keep the track so playback can resume later.
      this.queue.unshift(this.current);
      this.current = null;
      this.log.warn('Voice connection was closed; playback stopped and the queue was kept.');
      this.emit('notice', 'I was disconnected from the voice channel. The queue was kept, so use play or join to continue.');
    }
    this.#stopCurrent();
    this.loading = false;
    this.emitUpdate();
  }

  /** Leaves the voice channel and clears the queue. */
  leave() {
    if (this.current) this.#pushHistory(this.current);
    this.current = null;
    this.queue = [];
    this.loading = false;
    this.#stopCurrent();
    this.#clearIdleTimer();
    this.#clearEmptyTimer();
    if (this.connected) {
      this.leaving = true;
      this.connection.destroy();
    }
    this.emitUpdate();
  }

  // ---------------------------------------------------------------- queue

  enqueue(tracks, { next = false } = {}) {
    const { maxQueueSize } = config.get().playback;
    const room = maxQueueSize - this.queue.length;
    if (room <= 0) throw new UserError(`The queue is full (${maxQueueSize} tracks).`);
    const accepted = tracks.slice(0, room);
    if (next) this.queue.unshift(...accepted);
    else this.queue.push(...accepted);
    const position = next ? 1 : this.queue.length - accepted.length + 1;
    const startsNow = !this.current && this.connected;
    this.emitUpdate();
    this.ensurePlaying();
    this.#prefetch();
    return { added: accepted.length, dropped: tracks.length - accepted.length, position, startsNow };
  }

  /** Starts the queue if we are connected and nothing is playing. */
  ensurePlaying() {
    if (!this.current && this.connected && this.queue.length) {
      this.#advance().catch((err) => this.log.error('Could not start playback:', err));
    }
  }

  #indexOf(trackId) {
    const index = this.queue.findIndex((t) => t.id === trackId);
    if (index === -1) throw new UserError('That track is no longer in the queue.', 404);
    return index;
  }

  remove(trackId) {
    const [removed] = this.queue.splice(this.#indexOf(trackId), 1);
    this.emitUpdate();
    this.#prefetch();
    return removed;
  }

  removeAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.queue.length) {
      throw new UserError(`Pick a number between 1 and ${this.queue.length}.`);
    }
    return this.remove(this.queue[index].id);
  }

  move(trackId, toIndex) {
    const from = this.#indexOf(trackId);
    const to = Math.max(0, Math.min(this.queue.length - 1, Math.trunc(Number(toIndex) || 0)));
    const [track] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, track);
    this.emitUpdate();
    this.#prefetch();
    return track;
  }

  clear() {
    const count = this.queue.length;
    this.queue = [];
    this.emitUpdate();
    return count;
  }

  shuffle() {
    if (this.queue.length < 2) throw new UserError('Need at least two queued tracks to shuffle.');
    shuffleInPlace(this.queue);
    this.emitUpdate();
    this.#prefetch();
  }

  requeueFromHistory(trackId, { next = false } = {}) {
    const track = this.history.find((t) => t.id === trackId);
    if (!track) throw new UserError('That track is no longer in the history.', 404);
    return this.enqueue([cloneTrack(track)], { next });
  }

  // ---------------------------------------------------------------- playback controls

  #requireCurrent() {
    if (!this.current) throw new UserError('Nothing is playing right now.');
  }

  #requireConnection() {
    if (!this.connected) throw new UserError('I\'m not in a voice channel.');
  }

  pause() {
    this.#requireCurrent();
    if (this.paused) throw new UserError('Already paused.');
    if (!this.player.pause(true)) throw new UserError('Can\'t pause while the track is still loading.');
    this.emitUpdate();
  }

  resume() {
    this.#requireCurrent();
    if (!this.paused) throw new UserError('Playback isn\'t paused.');
    this.player.unpause();
    this.emitUpdate();
  }

  togglePause() {
    if (this.paused) this.resume();
    else this.pause();
    return this.paused;
  }

  async skip() {
    this.#requireCurrent();
    const skipped = this.current;
    await this.#advance({ skipped: true });
    return skipped;
  }

  async previous() {
    this.#requireConnection();
    if (!this.history.length) throw new UserError('There is no previous track.');
    const previous = this.history.pop();
    if (this.current) this.queue.unshift(this.current);
    this.current = null;
    this.queue.unshift(previous);
    await this.#advance({ skipped: true });
    return previous;
  }

  /** Plays a queued track immediately; the rest of the queue stays as it is. */
  async jump(trackId) {
    this.#requireConnection();
    const [track] = this.queue.splice(this.#indexOf(trackId), 1);
    this.queue.unshift(track);
    await this.#advance({ skipped: true });
    return track;
  }

  stop() {
    if (this.current) this.#pushHistory(this.current);
    this.current = null;
    this.queue = [];
    this.loading = false;
    this.#stopCurrent();
    this.emitUpdate();
    this.#startIdleTimer();
  }

  async seek(ms) {
    this.#requireCurrent();
    const track = this.current;
    if (track.isLive) throw new UserError('You can\'t seek in a live stream.');
    if (!Number.isFinite(ms) || ms < 0) throw new UserError('Invalid position.');
    if (track.duration && ms >= track.duration * 1000) {
      throw new UserError(`That's past the end of the track (${formatDuration(track.duration)}).`);
    }
    await this.#startTrack(track, Math.floor(ms), { announce: false });
  }

  setVolume(value) {
    const volume = Math.round(Number(value));
    if (!Number.isFinite(volume) || volume < 0 || volume > 200) throw new UserError('Volume must be between 0 and 200.');
    this.volume = volume;
    this.resource?.volume?.setVolumeLogarithmic(volume / 100);
    this.emitUpdate();
    return volume;
  }

  setLoop(mode) {
    if (!LOOP_MODES.includes(mode)) throw new UserError(`Loop mode must be one of: ${LOOP_MODES.join(', ')}.`);
    this.loop = mode;
    this.emitUpdate();
    this.#prefetch();
    return mode;
  }

  // ---------------------------------------------------------------- internals

  #pushHistory(track) {
    this.history.push(cloneTrack(track));
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  /** Stops audio and kills the stream without triggering the "track ended" logic. */
  #stopCurrent() {
    this.playToken++;
    this.suppressIdle = true;
    try {
      this.player.stop(true);
    } finally {
      this.suppressIdle = false;
    }
    this.stream?.kill();
    this.stream = null;
    this.resource = null;
    this.pendingAnnounce = null;
  }

  async #advance({ skipped = false } = {}) {
    const previous = this.current;
    let next;
    if (previous && this.loop === 'track' && !skipped) {
      next = previous;
    } else {
      if (previous) {
        this.#pushHistory(previous);
        if (this.loop === 'queue') this.queue.push(cloneTrack(previous));
      }
      next = this.queue.shift() ?? null;
    }

    this.current = next;
    if (!next) {
      this.#stopCurrent();
      this.loading = false;
      this.emitUpdate();
      this.#startIdleTimer();
      return;
    }
    await this.#startTrack(next, 0, { announce: next !== previous });
  }

  async #startTrack(track, seekMs = 0, { announce = true, isRetry = false } = {}) {
    this.#stopCurrent();
    const token = ++this.playToken;
    this.loading = true;
    this.#clearIdleTimer();
    this.emitUpdate();

    try {
      if (track.needsMetadata) await hydrateTrack(track).catch((err) => this.log.debug(`Metadata lookup failed: ${err.message}`));
      await resolvePlayable(track);
      if (token !== this.playToken) return;
      if (!this.connected) throw new UserError('Not connected to a voice channel.');

      const stream = createAudioStream(track.playUrl, {
        seek: seekMs / 1000,
        normalize: config.get().playback.normalizeAudio,
      });
      const resource = createAudioResource(stream.output, {
        inputType: StreamType.Raw,
        inlineVolume: true,
        metadata: track,
      });
      resource.volume.setVolumeLogarithmic(this.volume / 100);
      this.stream = stream;
      this.resource = resource;
      this.seekOffset = seekMs;
      this.player.play(resource);
      this.loading = false;
      if (!isRetry) this.retries = 0;
      // Announced once audio actually flows (see #onPlayerStateChange), so broken links aren't announced.
      this.pendingAnnounce = announce ? resource : null;
      this.emitUpdate();
      this.#prefetch();
    } catch (err) {
      if (token !== this.playToken) return;
      this.loading = false;
      this.#handleTrackFailure(track, err);
    }
  }

  #handleTrackFailure(track, err) {
    this.log.warn(`Could not play "${track.title}": ${err.message}`);
    this.emit('trackError', track, err);
    this.failures++;
    if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
      this.failures = 0;
      this.emit('notice', `Stopped because ${MAX_CONSECUTIVE_FAILURES} tracks in a row failed to play. Check the dashboard logs.`);
      this.stop();
      return;
    }
    this.#advance({ skipped: true }).catch((e) => this.log.error('Could not advance the queue:', e));
  }

  #onPlayerStateChange(oldState, newState) {
    if (newState.status === AudioPlayerStatus.Playing && this.pendingAnnounce && newState.resource === this.pendingAnnounce) {
      // "Playing" is also reached by streams that end empty, so confirm real audio frames went out first.
      const resource = newState.resource;
      const track = this.current;
      this.pendingAnnounce = null;
      setTimeout(() => {
        if (this.resource !== resource || this.current !== track || resource.ended || resource.playbackDuration === 0) return;
        this.log.info(`Now playing: ${track.title}${track.matchedTitle ? ` (matched "${track.matchedTitle}")` : ''}`);
        this.emit('trackStart', track);
      }, 750);
    }
    if (
      newState.status === AudioPlayerStatus.Idle &&
      oldState.status !== AudioPlayerStatus.Idle &&
      !this.suppressIdle &&
      oldState.resource === this.resource
    ) {
      this.#onTrackEnd().catch((err) => this.log.error('Error while advancing the queue:', err));
    }
    if (oldState.status !== newState.status) this.emitUpdate();
  }

  /** Called when the audio resource ends: either the track finished, or the stream broke and we resume it. */
  async #onTrackEnd() {
    const track = this.current;
    const stream = this.stream;
    const token = this.playToken;
    const position = this.position;
    if (!track) return;

    const exited = stream ? await stream.settled(2_000) : true;
    if (token !== this.playToken) return;

    if (stream && (stream.failed || !exited)) {
      const remaining = track.duration ? track.duration * 1000 - position : Infinity;
      const reason = stream.errorMessage || 'stream stalled';
      // Resume if audio was already flowing or the error looks temporary; permanent errors such as
      // "video unavailable" fail straight away instead of wasting retries.
      const playedAudio = position - this.seekOffset > 1_000;
      const transient = /\b(403|429|5\d\d)\b|timed? ?out|reset|connection|temporar|network|stalled|ffmpeg/i.test(reason);
      if (remaining > 5_000 && this.retries < MAX_STREAM_RETRIES && (playedAudio || transient)) {
        this.retries++;
        this.log.warn(
          `Stream interrupted at ${formatDuration(position / 1000)} (${reason}); resuming (attempt ${this.retries}/${MAX_STREAM_RETRIES})`,
        );
        await this.#startTrack(track, track.isLive ? 0 : position, { announce: false, isRetry: true });
        return;
      }
      if (position - this.seekOffset < 2_000) {
        this.#handleTrackFailure(track, new UserError(reason));
        return;
      }
    } else if (position > 5_000) {
      this.failures = 0;
    }
    await this.#advance();
  }

  #prefetch() {
    if (this.loop === 'track') return;
    const next = this.queue[0];
    if (!next) return;
    if (next.needsMetadata) hydrateTrack(next).then(() => this.emitUpdate()).catch(() => {});
    else if (!next.playUrl) resolvePlayable(next).then(() => this.emitUpdate()).catch(() => {});
  }

  #startIdleTimer() {
    this.#clearIdleTimer();
    const { idleTimeout } = config.get().playback;
    if (!idleTimeout || !this.connected) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.current && this.connected) {
        this.emit('notice', 'Nothing has been played for a while, so I left the voice channel.');
        this.leave();
      }
    }, idleTimeout * 1000);
  }

  #clearIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Leaves after a configurable delay when no humans remain in the voice channel. */
  checkEmptyChannel() {
    const { emptyChannelTimeout } = config.get().playback;
    if (!this.connected || !emptyChannelTimeout || this.humanListeners() > 0) {
      this.#clearEmptyTimer();
      return;
    }
    if (this.emptyTimer) return;
    this.emptyTimer = setTimeout(() => {
      this.emptyTimer = null;
      if (this.connected && this.humanListeners() === 0) {
        this.emit('notice', 'Everyone left the voice channel, so I left too.');
        this.leave();
      }
    }, emptyChannelTimeout * 1000);
  }

  #clearEmptyTimer() {
    clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
  }

  /** Coalesces bursts of changes into one "update" event. */
  emitUpdate() {
    if (this.updateScheduled || this.destroyed) return;
    this.updateScheduled = true;
    setTimeout(() => {
      this.updateScheduled = false;
      if (!this.destroyed) this.emit('update');
    }, 50);
  }

  toJSON() {
    const channel = this.voiceChannel;
    return {
      guildId: this.guildId,
      connected: this.connected,
      connectionStatus: this.connection?.state.status ?? 'disconnected',
      voiceChannel: channel ? { id: channel.id, name: channel.name, listeners: this.humanListeners() } : null,
      textChannelId: this.textChannelId,
      status: this.status,
      current: this.current ? serializeTrack(this.current) : null,
      position: Math.round(this.position),
      volume: this.volume,
      loop: this.loop,
      queue: this.queue.map(serializeTrack),
      queueDuration: this.queue.reduce((sum, t) => sum + (t.duration || 0), 0),
      history: this.history.slice(-25).reverse().map(serializeTrack),
    };
  }

  destroy() {
    this.leave();
    this.destroyed = true;
    this.player.removeAllListeners();
    this.removeAllListeners();
  }
}
