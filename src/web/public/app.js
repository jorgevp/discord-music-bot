/* global io */
// Dashboard client. All untrusted text (track titles, server names, logs) is rendered with textContent.

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const SVG_NS = 'http://www.w3.org/2000/svg';

const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  },
};

const state = {
  bot: null,
  guilds: [],
  guildId: storage.get('guildId'),
  guild: null,
  player: null,
  progress: { position: 0, at: 0, playing: false, duration: null, live: false },
  loadingGuild: false,
  settings: null,
  roleGuilds: null,
  view: null,
  socket: null,
  logs: [],
  dragId: null,
  seeking: false,
  volumeDragging: false,
  authMode: 'login',
};

// ------------------------------------------------------------------ helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name, className = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${className}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function setIcon(button, name) {
  button.querySelector('use')?.setAttribute('href', `#i-${name}`);
}

function iconButton(name, label, onClick, extraClass = '') {
  return el('button', { class: `icon-btn sm ${extraClass}`.trim(), type: 'button', title: label, 'aria-label': label, onclick: onClick }, icon(name));
}

function formatTime(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function initials(name) {
  return String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
}

const SOURCE_LABELS = { youtube: 'YouTube', spotify: 'Spotify', soundcloud: 'SoundCloud', bandcamp: 'Bandcamp', twitch: 'Twitch', file: 'File', web: 'Web' };

function toast(message, type = 'info', timeout = 4500) {
  const node = el('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
  $('#toasts').append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 300);
  }, timeout);
}

async function api(path, { method = 'GET', body } = {}) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(`/api${path}`, options);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !path.startsWith('/auth/')) {
    showAuth(false);
    throw new Error('Your session expired. Please sign in again.');
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
  return data;
}

/** Runs an async action with a busy button and error toasts. */
async function run(fn, { button, success } = {}) {
  if (button) {
    button.disabled = true;
    button.classList.add('loading');
  }
  try {
    const result = await fn();
    if (success) toast(typeof success === 'function' ? success(result) : success, 'success');
    return result;
  } catch (err) {
    toast(err.message, 'error', 7000);
    return undefined;
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove('loading');
    }
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el('textarea', { class: 'sprite' });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('Copied to clipboard', 'success', 2000);
}

function setRangeFill(input) {
  const max = Number(input.max) || 1;
  input.style.setProperty('--fill', `${(Number(input.value) / max) * 100}%`);
}

// ------------------------------------------------------------------ auth

function showAuth(setupRequired) {
  stopSocket();
  state.authMode = setupRequired ? 'setup' : 'login';
  $('#app').hidden = true;
  $('#auth').hidden = false;
  $('#auth-title').textContent = setupRequired ? 'Create a dashboard password' : 'Sign in';
  $('#auth-hint').textContent = setupRequired
    ? 'Welcome! Choose a password to protect this dashboard (at least 8 characters).'
    : 'Enter your dashboard password.';
  $('#auth-confirm-row').hidden = !setupRequired;
  $('#auth-password').autocomplete = setupRequired ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = setupRequired ? 'Create password' : 'Sign in';
  $('#auth-error').textContent = '';
  $('#auth-password').value = '';
  $('#auth-confirm').value = '';
  $('#auth-password').focus();
}

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $('#auth-password').value;
  const error = $('#auth-error');
  error.textContent = '';
  if (password.length < 8 && state.authMode === 'setup') {
    error.textContent = 'Use at least 8 characters.';
    return;
  }
  if (state.authMode === 'setup' && password !== $('#auth-confirm').value) {
    error.textContent = 'The passwords don\'t match.';
    return;
  }
  const button = $('#auth-submit');
  button.disabled = true;
  try {
    await api(state.authMode === 'setup' ? '/auth/setup' : '/auth/login', { method: 'POST', body: { password } });
    startApp();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showAuth(false);
});

// ------------------------------------------------------------------ app shell, routing, socket

function startApp() {
  $('#auth').hidden = true;
  $('#app').hidden = false;
  connectSocket();
  route();
}

function route() {
  if ($('#app').hidden) return;
  const requested = location.hash.replace(/^#/, '').split('?')[0];
  const view = ['player', 'settings', 'logs'].includes(requested) ? requested : 'player';
  const changed = state.view !== view;
  state.view = view;
  for (const section of $$('.view')) section.hidden = section.id !== `view-${view}`;
  for (const link of $$('[data-nav]')) {
    const active = link.dataset.nav === view;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (view === 'settings' && changed) loadSettings();
  state.socket?.emit('logs', view === 'logs');
  if (view === 'logs') renderLogs();
}
window.addEventListener('hashchange', route);

function connectSocket() {
  if (state.socket) return;
  const socket = io({ transports: ['websocket', 'polling'] });
  state.socket = socket;

  socket.on('connect', () => {
    $('#offline-banner').hidden = true;
    if (state.guildId) socket.emit('subscribe', state.guildId);
    socket.emit('logs', state.view === 'logs');
  });
  socket.on('disconnect', (reason) => {
    if (state.socket !== socket) return;
    $('#offline-banner').hidden = false;
    // The server drops sockets after a password change; reconnect with the refreshed cookie.
    if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 500);
  });
  socket.on('connect_error', async (err) => {
    if (err.message !== 'unauthorized') {
      $('#offline-banner').hidden = false;
      return;
    }
    const status = await api('/auth/status').catch(() => null);
    if (status && !status.authenticated) showAuth(status.setupRequired);
  });
  socket.on('bot', (info) => {
    state.bot = info;
    renderBot();
    renderPlayerVisibility();
  });
  socket.on('guilds', (guilds) => {
    state.guilds = guilds;
    renderGuilds();
  });
  socket.on('guild:state', ({ guildId, state: playerState }) => {
    if (guildId === state.guildId) setPlayerState(playerState);
  });
  socket.on('logs:init', (entries) => {
    state.logs = entries;
    renderLogs();
  });
  socket.on('log', (entry) => {
    state.logs.push(entry);
    if (state.logs.length > 1000) state.logs.shift();
    appendLog(entry);
  });
}

function stopSocket() {
  const socket = state.socket;
  state.socket = null;
  socket?.disconnect();
}

// ------------------------------------------------------------------ bot card

const STATUS_TEXT = {
  online: 'Online',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  error: 'Login failed',
  unconfigured: 'No token configured',
  stopped: 'Stopped',
};

function renderBot() {
  const bot = state.bot;
  if (!bot) return;
  $('#bot-name').textContent = bot.user?.name || 'Music Bot';
  $('#bot-status').textContent = STATUS_TEXT[bot.status] || bot.status;
  $('#bot-dot').className = `dot ${bot.status}`;
  const avatar = $('#bot-avatar');
  avatar.hidden = !bot.user?.avatar;
  $('#bot-avatar-placeholder').hidden = Boolean(bot.user?.avatar);
  if (bot.user?.avatar) avatar.src = bot.user.avatar;
  $('#bot-error').hidden = !bot.error;
  $('#bot-error').textContent = bot.error || '';
  const invite = $('#bot-invite');
  invite.hidden = !bot.inviteUrl;
  if (bot.inviteUrl) invite.href = bot.inviteUrl;

  // Settings page bits that depend on the bot
  $('#invite-box').hidden = !bot.inviteUrl;
  if (bot.inviteUrl) {
    $('#invite-url').value = bot.inviteUrl;
    $('#invite-open').href = bot.inviteUrl;
  }
  const pill = $('#discord-pill');
  pill.textContent = bot.status === 'online' ? `Online as ${bot.user?.tag ?? ''} · ${bot.guildCount} server${bot.guildCount === 1 ? '' : 's'}` : STATUS_TEXT[bot.status] || bot.status;
  pill.className = `pill ${bot.status === 'online' ? 'ok' : bot.status === 'error' ? 'bad' : 'warn'}`;
}

// ------------------------------------------------------------------ guilds

function renderGuilds() {
  const bar = $('#guild-bar');
  bar.replaceChildren(
    ...state.guilds.map((guild) =>
      el(
        'button',
        {
          class: `guild-chip${guild.id === state.guildId ? ' active' : ''}`,
          type: 'button',
          role: 'tab',
          'aria-selected': String(guild.id === state.guildId),
          title: guild.nowPlaying ? `${guild.name}: ${guild.nowPlaying}` : guild.name,
          onclick: () => selectGuild(guild.id),
        },
        guild.icon ? el('img', { src: guild.icon, alt: '' }) : el('span', { class: 'guild-initials' }, initials(guild.name)),
        el('span', { class: 'guild-name' }, guild.name),
        guild.status === 'playing' ? el('span', { class: 'eq', 'aria-label': 'Playing' }, el('i'), el('i'), el('i')) : null,
      ),
    ),
  );

  const known = state.guilds.some((g) => g.id === state.guildId);
  if (!known && state.guilds.length) selectGuild(state.guilds[0].id);
  else if (known && !state.guild && !state.loadingGuild) selectGuild(state.guildId);
  else if (!state.guilds.length) {
    state.guild = null;
    state.player = null;
  }
  renderPlayerVisibility();
}

async function selectGuild(guildId) {
  if (state.guildId !== guildId) {
    state.guildId = guildId;
    state.guild = null;
    state.player = null;
    storage.set('guildId', guildId);
    $('#search-results').hidden = true;
  }
  renderGuildsActive();
  state.socket?.emit('subscribe', guildId);
  await refreshGuildDetail();
}

function renderGuildsActive() {
  $$('.guild-chip').forEach((chip, i) => {
    const active = state.guilds[i]?.id === state.guildId;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-selected', String(active));
  });
}

async function refreshGuildDetail() {
  const guildId = state.guildId;
  if (!guildId) return;
  state.loadingGuild = true;
  try {
    const { guild, state: playerState } = await api(`/guilds/${guildId}`);
    if (guildId !== state.guildId) return;
    state.guild = guild;
    setPlayerState(playerState);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.loadingGuild = false;
  }
}

// ------------------------------------------------------------------ player rendering

function renderPlayerVisibility() {
  const bot = state.bot;
  const ready = bot?.status === 'online' && state.guilds.length > 0 && state.guild && state.player;
  $('#player-panel').hidden = !ready;
  $('#player-empty').hidden = Boolean(ready);
  $('#guild-bar').hidden = !(bot?.status === 'online' && state.guilds.length > 0);
  if (ready) return;

  const actions = $('#empty-actions');
  actions.replaceChildren();
  let title = 'Loading…';
  let text = '';
  if (!bot) {
    title = 'Connecting to the dashboard…';
  } else if (bot.status === 'unconfigured') {
    title = 'Add your Discord bot token';
    text = 'Create a bot in the Discord Developer Portal, then paste its token in Settings to bring the bot online.';
    actions.append(el('a', { class: 'btn primary', href: '#settings' }, 'Open settings'));
  } else if (bot.status === 'error') {
    title = 'The bot could not sign in to Discord';
    text = bot.error || 'Check the token in Settings.';
    actions.append(el('a', { class: 'btn primary', href: '#settings' }, 'Open settings'));
  } else if (bot.status !== 'online') {
    title = STATUS_TEXT[bot.status] || 'Connecting…';
    text = 'Waiting for the bot to connect to Discord.';
  } else if (!state.guilds.length) {
    title = 'Invite the bot to a server';
    text = 'The bot is online but not in any server yet. Use the invite link, pick a server, then come back here.';
    if (bot.inviteUrl) {
      actions.append(el('a', { class: 'btn primary', href: bot.inviteUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('user-plus'), 'Invite to a server'));
    }
  }
  $('#empty-title').textContent = title;
  $('#empty-text').textContent = text;
}

function setPlayerState(playerState) {
  state.player = playerState;
  const current = playerState.current;
  state.progress = {
    position: playerState.position,
    at: performance.now(),
    playing: playerState.status === 'playing',
    duration: current?.duration ?? null,
    live: Boolean(current?.isLive),
  };
  renderPlayer();
}

function voiceChannelName(id) {
  return state.guild?.voiceChannels.find((c) => c.id === id)?.name;
}

function renderPlayer() {
  renderPlayerVisibility();
  const s = state.player;
  if (!s || !state.guild) return;
  const track = s.current;

  // Now playing
  const art = $('#np-art');
  art.hidden = !track?.thumbnail;
  $('#np-art-placeholder').toggleAttribute('hidden', Boolean(track?.thumbnail)); // SVG elements have no .hidden
  if (track?.thumbnail && art.getAttribute('src') !== track.thumbnail) art.src = track.thumbnail;

  const title = $('#np-title');
  title.textContent = track ? track.title : 'Nothing playing';
  if (track?.url) title.href = track.url;
  else title.removeAttribute('href');
  $('#np-author').textContent = track ? track.author || '' : s.queue.length ? 'Press play to start the queue.' : 'Add a link or search below to get started.';

  const channelName = s.voiceChannel?.name;
  const statusText = {
    playing: channelName ? `Playing in ${channelName}` : 'Playing',
    paused: 'Paused',
    loading: 'Loading…',
    reconnecting: 'Reconnecting to voice…',
    idle: s.connected ? `Idle in ${channelName ?? 'voice'}` : 'Not in a voice channel',
  };
  $('#np-status').textContent = statusText[s.status] || s.status;

  const chips = $('#np-chips');
  chips.replaceChildren();
  if (track) {
    chips.append(el('span', { class: `badge ${track.source}` }, SOURCE_LABELS[track.source] || track.source));
    if (track.requester?.name) chips.append(el('span', { class: 'chip' }, `Requested by ${track.requester.name}`));
    if (track.matchedTitle) chips.append(el('span', { class: 'chip', title: 'Spotify tracks play from their best YouTube match' }, `Playing "${track.matchedTitle}"`));
  }

  // Controls
  const playButton = $('#btn-play');
  const isPlaying = s.status === 'playing';
  setIcon(playButton, isPlaying ? 'pause' : 'play');
  playButton.title = isPlaying ? 'Pause' : 'Play';
  playButton.setAttribute('aria-label', playButton.title);
  playButton.disabled = !track && !(s.queue.length && s.connected);
  $('#btn-prev').disabled = !s.history.length || !s.connected;
  $('#btn-next').disabled = !track;
  $('#btn-stop').disabled = !track && !s.queue.length;
  $('#btn-shuffle').disabled = s.queue.length < 2;

  const loopButton = $('#btn-loop');
  setIcon(loopButton, s.loop === 'track' ? 'repeat-1' : 'repeat');
  loopButton.classList.toggle('active', s.loop !== 'off');
  loopButton.title = { off: 'Loop: off', track: 'Loop: current track', queue: 'Loop: whole queue' }[s.loop];

  if (!state.volumeDragging) {
    const volume = $('#volume');
    volume.value = s.volume;
    setRangeFill(volume);
    $('#volume-label').textContent = `${s.volume}%`;
    setIcon($('#volume-icon'), s.volume === 0 ? 'volume-x' : 'volume');
  }

  const seek = $('#np-seek');
  seek.disabled = !track || !track.duration || track.isLive;
  seek.max = track?.duration || 100;
  $('#np-duration').textContent = track ? (track.isLive ? 'LIVE' : formatTime(track.duration)) : '0:00';
  tickProgress();

  renderQueue();
  renderHistory();
  renderVoice();
  renderAddHint();
}

function tickProgress() {
  if (state.seeking || !state.player) return;
  const p = state.progress;
  let positionMs = p.position + (p.playing ? performance.now() - p.at : 0);
  if (p.duration) positionMs = Math.min(positionMs, p.duration * 1000);
  const seek = $('#np-seek');
  seek.value = p.live ? seek.max : Math.floor(positionMs / 1000);
  setRangeFill(seek);
  $('#np-elapsed').textContent = state.player.current ? formatTime(positionMs / 1000) : '0:00';
}
setInterval(() => {
  if (state.view === 'player' && state.progress.playing) tickProgress();
}, 250);

function trackThumb(track) {
  return track.thumbnail
    ? el('img', { class: 'thumb', src: track.thumbnail, alt: '', loading: 'lazy' })
    : el('span', { class: 'thumb' }, icon('music'));
}

function trackMeta(track, { showRequester = true } = {}) {
  const titleNode = track.url
    ? el('a', { class: 'track-title', href: track.url, target: '_blank', rel: 'noopener noreferrer', title: track.title }, track.title)
    : el('span', { class: 'track-title', title: track.title }, track.title);
  const subParts = [el('span', { class: `badge ${track.source}` }, SOURCE_LABELS[track.source] || track.source)];
  if (track.author) subParts.push(el('span', {}, track.author));
  if (showRequester && track.requester?.name) subParts.push(el('span', { class: 'requester' }, `· ${track.requester.name}`));
  return el('div', { class: 'track-meta' }, titleNode, el('div', { class: 'track-sub' }, subParts));
}

function renderQueue() {
  if (state.dragId) return; // don't rebuild the list under the user's cursor mid-drag
  const s = state.player;
  const list = $('#queue-list');
  list.replaceChildren(
    ...s.queue.map((track, index) =>
      el(
        'li',
        { class: 'track', draggable: 'true', dataset: { id: track.id, index: String(index) } },
        el('span', { class: 'handle', title: 'Drag to reorder' }, icon('grip')),
        el('span', { class: 'idx' }, String(index + 1)),
        trackThumb(track),
        trackMeta(track),
        el('span', { class: 'dur' }, track.isLive ? 'LIVE' : formatTime(track.duration)),
        el(
          'div',
          { class: 'row-actions' },
          iconButton('play', 'Play now', () => queueAction(`/tracks/${track.id}/play`, 'POST')),
          index > 0 ? iconButton('to-top', 'Move to top', () => moveTrack(track.id, 0), 'to-top') : null,
          iconButton('x', 'Remove', () => queueAction(`/tracks/${track.id}`, 'DELETE')),
        ),
      ),
    ),
  );
  $('#queue-empty').hidden = s.queue.length > 0;
  $('#queue-meta').textContent = s.queue.length
    ? `${s.queue.length} track${s.queue.length === 1 ? '' : 's'} · ${formatTime(s.queueDuration)}`
    : '';
  $('#queue-shuffle').disabled = s.queue.length < 2;
  $('#queue-clear').disabled = s.queue.length === 0;
}

function renderHistory() {
  const s = state.player;
  $('#history-list').replaceChildren(
    ...s.history.map((track) =>
      el(
        'li',
        { class: 'track' },
        trackThumb(track),
        trackMeta(track, { showRequester: false }),
        el('span', { class: 'dur' }, track.isLive ? 'LIVE' : formatTime(track.duration)),
        el(
          'div',
          { class: 'row-actions' },
          iconButton('list-plus', 'Play next', () => queueAction(`/history/${track.id}/requeue`, 'POST', { next: true }, 'Added to the front of the queue')),
          iconButton('plus', 'Add to queue', () => queueAction(`/history/${track.id}/requeue`, 'POST', { next: false }, 'Added to the queue')),
        ),
      ),
    ),
  );
  $('#history-empty').hidden = s.history.length > 0;
}

function renderVoice() {
  const s = state.player;
  const guild = state.guild;
  const pill = $('#voice-pill');
  const status = s.connectionStatus;
  pill.textContent = s.connected
    ? status === 'ready'
      ? `${s.voiceChannel?.name ?? 'Connected'} · ${s.voiceChannel?.listeners ?? 0} listening`
      : `Connecting (${status})`
    : 'Disconnected';
  pill.className = `pill ${s.connected ? (status === 'ready' ? 'ok' : 'warn') : ''}`;

  const voiceSelect = $('#voice-select');
  if (document.activeElement !== voiceSelect) {
    const previous = voiceSelect.value;
    voiceSelect.replaceChildren(
      ...guild.voiceChannels.map((c) =>
        el('option', { value: c.id, disabled: !c.canJoin }, `${c.stage ? '🎙 ' : '🔊 '}${c.name}${c.members ? ` (${c.members})` : ''}${c.canJoin ? '' : ' (no access)'}`),
      ),
    );
    const fallback = guild.voiceChannels.filter((c) => c.canJoin).sort((a, b) => b.members - a.members)[0]?.id;
    voiceSelect.value = s.voiceChannel?.id || (guild.voiceChannels.some((c) => c.id === previous) ? previous : fallback) || '';
  }
  const join = $('#voice-join');
  join.lastChild.textContent = s.connected ? 'Move here' : 'Join';
  join.disabled = !voiceSelect.value || (s.connected && voiceSelect.value === s.voiceChannel?.id);
  $('#voice-leave').disabled = !s.connected;

  const textSelect = $('#text-select');
  if (document.activeElement !== textSelect) {
    textSelect.replaceChildren(
      el('option', { value: '' }, 'Nowhere (no announcements)'),
      ...guild.textChannels.map((c) => el('option', { value: c.id, disabled: !c.canSend }, `# ${c.name}${c.canSend ? '' : ' (no access)'}`)),
    );
    textSelect.value = s.textChannelId || '';
  }
}

function renderAddHint() {
  const s = state.player;
  const hint = $('#add-hint');
  if (s.connected) {
    hint.textContent = '';
  } else {
    const name = voiceChannelName($('#voice-select').value);
    hint.textContent = name ? `The bot will join 🔊 ${name} when you add something (change it under Voice).` : 'Pick a voice channel under Voice so the bot can play.';
  }
}

// ------------------------------------------------------------------ player actions

const guildPath = (suffix = '') => `/guilds/${state.guildId}${suffix}`;

async function control(action, value, button) {
  const result = await run(() => api(guildPath(`/player/${action}`), { method: 'POST', body: { value } }), { button });
  if (result) setPlayerState(result);
}

async function queueAction(suffix, method, body, success) {
  const result = await run(() => api(guildPath(suffix), { method, body }), { success });
  if (result) setPlayerState(result);
}

async function moveTrack(trackId, to) {
  const queue = state.player.queue;
  const from = queue.findIndex((t) => t.id === trackId);
  if (from !== -1) {
    // Optimistic update; the server pushes the authoritative state right after.
    const [track] = queue.splice(from, 1);
    queue.splice(to, 0, track);
    renderQueue();
  }
  await queueAction(`/tracks/${trackId}/move`, 'POST', { to });
}

async function addTrack({ next = false, query = $('#add-input').value.trim(), button } = {}) {
  if (!query) {
    $('#add-input').focus();
    return;
  }
  const body = { query, next };
  if (!state.player?.connected && $('#voice-select').value) body.voiceChannelId = $('#voice-select').value;
  const result = await run(() => api(guildPath('/tracks'), { method: 'POST', body }), { button });
  if (!result) return;
  if (result.playlist) toast(`Queued ${result.added} track${result.added === 1 ? '' : 's'} from "${result.title}"`, 'success');
  else toast(`${result.startsNow ? 'Playing' : next ? 'Playing next:' : 'Queued'} "${result.title}"`, 'success');
  if (result.dropped) toast(`${result.dropped} track(s) were skipped because the queue is full.`, 'info', 7000);
  if (result.notice) toast(result.notice, 'info', 9000);
  if (!result.connected) toast('The bot is not in a voice channel. Pick one under Voice and press Join.', 'info', 7000);
  if (query === $('#add-input').value.trim()) $('#add-input').value = '';
}

async function searchTracks(button) {
  const query = $('#add-input').value.trim();
  if (!query) {
    $('#add-input').focus();
    return;
  }
  const result = await run(() => api(`/search?q=${encodeURIComponent(query)}`), { button });
  if (!result) return;
  const box = $('#search-results');
  box.hidden = false;
  if (!result.results.length) {
    box.replaceChildren(el('p', { class: 'empty' }, 'No results.'));
    return;
  }
  box.replaceChildren(
    el('div', { class: 'card-header' }, el('span', { class: 'muted small' }, `Results for "${query}"`), iconButton('x', 'Close results', () => { box.hidden = true; })),
    ...result.results.map((r) =>
      el(
        'div',
        { class: 'track' },
        trackThumb(r),
        trackMeta({ ...r, source: 'youtube', author: r.channel }, { showRequester: false }),
        el('span', { class: 'dur' }, r.isLive ? 'LIVE' : formatTime(r.duration)),
        el(
          'div',
          { class: 'row-actions' },
          iconButton('list-plus', 'Play next', (e) => addTrack({ query: r.url, next: true, button: e.currentTarget })),
          iconButton('plus', 'Add to queue', (e) => addTrack({ query: r.url, button: e.currentTarget })),
        ),
      ),
    ),
  );
}

$('#add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  addTrack({ button: $('#add-submit') });
});
$('#add-next').addEventListener('click', (e) => addTrack({ next: true, button: e.currentTarget }));
$('#add-search').addEventListener('click', (e) => searchTracks(e.currentTarget));

$('#btn-play').addEventListener('click', (e) => {
  const s = state.player;
  control(!s.current && s.queue.length ? 'start' : 'toggle', undefined, e.currentTarget);
});
$('#btn-next').addEventListener('click', (e) => control('skip', undefined, e.currentTarget));
$('#btn-prev').addEventListener('click', (e) => control('previous', undefined, e.currentTarget));
$('#btn-stop').addEventListener('click', (e) => {
  const count = state.player.queue.length;
  if (count && !confirm(`Stop playback and clear ${count} queued track${count === 1 ? '' : 's'}?`)) return;
  control('stop', undefined, e.currentTarget);
});
$('#btn-loop').addEventListener('click', () => {
  const modes = ['off', 'track', 'queue'];
  control('loop', modes[(modes.indexOf(state.player.loop) + 1) % modes.length]);
});
$('#btn-shuffle').addEventListener('click', () => queueAction('/queue/shuffle', 'POST', {}, 'Queue shuffled'));
$('#queue-shuffle').addEventListener('click', () => queueAction('/queue/shuffle', 'POST', {}, 'Queue shuffled'));
$('#queue-clear').addEventListener('click', () => {
  const count = state.player.queue.length;
  if (confirm(`Remove all ${count} queued track${count === 1 ? '' : 's'}?`)) queueAction('/queue/clear', 'POST', {}, 'Queue cleared');
});

// Seek bar: preview while dragging, seek on release.
const seekInput = $('#np-seek');
seekInput.addEventListener('input', () => {
  state.seeking = true;
  setRangeFill(seekInput);
  $('#np-elapsed').textContent = formatTime(Number(seekInput.value));
});
seekInput.addEventListener('change', async () => {
  const seconds = Number(seekInput.value);
  await control('seek', seconds * 1000);
  state.seeking = false;
  tickProgress();
});

// Volume: live updates while dragging (throttled), final value on release.
const volumeInput = $('#volume');
let volumeTimer = null;
volumeInput.addEventListener('input', () => {
  state.volumeDragging = true;
  setRangeFill(volumeInput);
  $('#volume-label').textContent = `${volumeInput.value}%`;
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => api(guildPath('/player/volume'), { method: 'POST', body: { value: Number(volumeInput.value) } }).catch(() => {}), 120);
});
volumeInput.addEventListener('change', async () => {
  clearTimeout(volumeTimer);
  await control('volume', Number(volumeInput.value));
  state.volumeDragging = false;
});

// Queue drag & drop
const queueList = $('#queue-list');
const clearDropMarkers = () => $$('.drop-before, .drop-after', queueList).forEach((n) => n.classList.remove('drop-before', 'drop-after'));
queueList.addEventListener('dragstart', (event) => {
  const row = event.target.closest('li.track');
  if (!row) return;
  state.dragId = row.dataset.id;
  row.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', row.dataset.id);
});
queueList.addEventListener('dragover', (event) => {
  if (!state.dragId) return;
  event.preventDefault();
  clearDropMarkers();
  const row = event.target.closest('li.track');
  if (!row || row.dataset.id === state.dragId) return;
  const rect = row.getBoundingClientRect();
  row.classList.add(event.clientY > rect.top + rect.height / 2 ? 'drop-after' : 'drop-before');
});
queueList.addEventListener('drop', (event) => {
  event.preventDefault();
  const dragId = state.dragId;
  const row = event.target.closest('li.track');
  const queue = state.player.queue;
  const from = queue.findIndex((t) => t.id === dragId);
  let to = row ? Number(row.dataset.index) + (row.classList.contains('drop-after') ? 1 : 0) : queue.length;
  if (from < to) to -= 1;
  state.dragId = null;
  clearDropMarkers();
  if (from !== -1 && to !== from && row?.dataset.id !== dragId) moveTrack(dragId, to);
  else renderQueue();
});
queueList.addEventListener('dragend', () => {
  if (!state.dragId) return;
  state.dragId = null;
  clearDropMarkers();
  renderQueue();
});

// Voice & channels
$('#voice-select').addEventListener('change', () => {
  renderVoice();
  renderAddHint();
});
$('#voice-select').addEventListener('focus', () => refreshGuildDetail());
$('#voice-join').addEventListener('click', async (e) => {
  const result = await run(() => api(guildPath('/voice'), { method: 'PUT', body: { channelId: $('#voice-select').value } }), { button: e.currentTarget });
  if (result) setPlayerState(result);
});
$('#voice-leave').addEventListener('click', async (e) => {
  const s = state.player;
  if ((s.current || s.queue.length) && !confirm('Disconnect from voice? This stops playback and clears the queue.')) return;
  const result = await run(() => api(guildPath('/voice'), { method: 'DELETE' }), { button: e.currentTarget });
  if (result) setPlayerState(result);
});
$('#text-select').addEventListener('change', async (e) => {
  const result = await run(() => api(guildPath('/text-channel'), { method: 'PUT', body: { channelId: e.target.value || null } }), {
    success: e.target.value ? 'Announcements channel updated' : 'Announcements turned off for this server',
  });
  if (result) setPlayerState(result);
});
$('#guild-leave').addEventListener('click', async (e) => {
  const name = state.guild?.name;
  if (!confirm(`Remove the bot from "${name}"? You'll need the invite link to add it back.`)) return;
  const result = await run(() => api(guildPath(), { method: 'DELETE' }), { button: e.currentTarget, success: `Left ${name}` });
  if (result) {
    state.guild = null;
    state.player = null;
  }
});

// ------------------------------------------------------------------ settings

async function loadSettings() {
  try {
    const [settings, system, roles] = await Promise.all([api('/settings'), api('/system'), api('/roles')]);
    state.settings = settings;
    state.roleGuilds = roles.guilds; // null while the bot is offline
    fillSettings();
    renderSystem(system);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderSystem(system) {
  $('#ytdlp-version').textContent = system.ytdlp || 'not found';
  $('#system-info').textContent = `Music Bot ${system.version} · Node ${system.node} · yt-dlp ${system.ytdlp || 'n/a'} · ffmpeg ${system.ffmpeg || 'n/a'} · up ${formatUptime(system.uptime)}`;
}

function fillSettings() {
  const s = state.settings;
  for (const input of $$('[data-setting]')) {
    const [section, key] = input.dataset.setting.split('.');
    const value = s[section]?.[key];
    if (input.type === 'checkbox') {
      input.checked = Boolean(value);
    } else if ('secret' in input.dataset) {
      input.value = '';
      input.placeholder = s[section][input.dataset.setFlag] ? '•••••••• saved (type to replace)' : 'Not set';
    } else {
      input.value = value ?? '';
    }
  }

  renderRolePicker();

  // YouTube cookie status
  const cookies = s.youtube.cookies;
  const cookieBox = $('#cookie-status');
  const youtubePill = $('#youtube-pill');
  if (!cookies.present) {
    cookieBox.replaceChildren(el('span', { class: 'pill' }, 'No cookies'), el('span', { class: 'muted small' }, 'The bot plays YouTube anonymously.'));
    youtubePill.textContent = 'Anonymous';
    youtubePill.className = 'pill';
  } else {
    const expires = cookies.expiresAt ? new Date(cookies.expiresAt) : null;
    const expired = expires && expires < new Date();
    cookieBox.replaceChildren(
      el('span', { class: `pill ${cookies.loggedIn && !expired ? 'ok' : 'warn'}` }, cookies.loggedIn ? (expired ? 'Signed-in cookies expired' : 'Signed-in cookies') : 'Cookies present (not signed in)'),
      el('span', { class: 'muted small' }, `${cookies.count} cookies${expires ? ` · earliest login cookie expires ${expires.toLocaleDateString()}` : ''}`),
    );
    youtubePill.textContent = cookies.loggedIn ? 'Signed in' : 'Cookies (anonymous)';
    youtubePill.className = `pill ${cookies.loggedIn && !expired ? 'ok' : 'warn'}`;
  }

  const loginAvailable = Boolean(s.youtube.loginBrowser?.available);
  $('#youtube-login').disabled = !loginAvailable;
  $('#youtube-login').lastChild.textContent = cookies.loggedIn ? 'Sign in again' : 'Sign in to YouTube';
  $('#youtube-login-unavailable').hidden = loginAvailable;
  if (!loginAvailable) $('#cookies-manual').open = true;
  $('#cookies-clear').disabled = !cookies.present;

  // Spotify status
  const sp = s.spotify;
  const spotifyPill = $('#spotify-pill');
  if (sp.connected) {
    spotifyPill.textContent = `Connected as ${sp.userName || 'Spotify user'}`;
    spotifyPill.className = 'pill ok';
  } else if (sp.clientId && sp.clientSecretSet) {
    spotifyPill.textContent = 'App credentials saved';
    spotifyPill.className = 'pill accent';
  } else {
    spotifyPill.textContent = sp.embedFallback ? 'Public links only' : 'Not configured';
    spotifyPill.className = 'pill';
  }
  $('#spotify-redirect').value = sp.redirectUri;
  const canConnect = Boolean(sp.clientId && sp.clientSecretSet);
  $('#spotify-connect').setAttribute('aria-disabled', String(!canConnect));
  $('#spotify-connect').textContent = sp.connected ? 'Reconnect Spotify account' : 'Connect Spotify account';
  $('#spotify-disconnect').disabled = !sp.connected;
  let redirectHost = '';
  try { redirectHost = new URL(sp.redirectUri).hostname; } catch { /* ignore */ }
  $('#spotify-localhost-warning').hidden = redirectHost !== 'localhost';
  renderBot();
}

function roleGroupLabel(count) {
  return count ? `${count} role${count === 1 ? '' : 's'} can queue` : 'Everyone can queue';
}

function renderRolePicker() {
  const box = $('#queue-roles');
  const guilds = state.roleGuilds;
  if (!guilds) {
    box.replaceChildren(el('p', { class: 'hint' }, 'Bring the bot online (Settings → Discord) to pick roles.'));
    return;
  }
  if (!guilds.length) {
    box.replaceChildren(el('p', { class: 'hint' }, 'The bot is not in any server yet.'));
    return;
  }
  const selected = new Set(state.settings.playback.queueRoles || []);
  box.replaceChildren(
    ...guilds.map((guild) => {
      const count = guild.roles.filter((r) => selected.has(r.id)).length;
      const pill = el('span', { class: `pill ${count ? 'accent' : ''}` }, roleGroupLabel(count));
      const chips = guild.roles.map((role) => {
        const input = el('input', { type: 'checkbox', value: role.id, checked: selected.has(role.id) });
        const dot = el('span', { class: 'role-dot' });
        if (/^#[0-9a-f]{6}$/i.test(role.color || '')) dot.style.setProperty('--role-color', role.color);
        input.addEventListener('change', () => {
          const n = $$('input:checked', input.closest('.role-chips')).length;
          pill.textContent = roleGroupLabel(n);
          pill.className = `pill ${n ? 'accent' : ''}`;
        });
        return el('label', { class: 'role-chip', title: `Role ID ${role.id}` }, input, dot, el('span', {}, role.name));
      });
      return el(
        'div',
        { class: 'role-group' },
        el('div', { class: 'role-group-header' }, el('strong', {}, guild.name), pill),
        chips.length ? el('div', { class: 'role-chips' }, chips) : el('p', { class: 'hint' }, 'This server has no roles to pick from.'),
      );
    }),
  );
}

for (const form of $$('[data-settings-form]')) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {};
    for (const input of $$('[data-setting]', form)) {
      const [section, key] = input.dataset.setting.split('.');
      let value;
      if (input.type === 'checkbox') value = input.checked;
      else if (input.type === 'number') value = input.value === '' ? undefined : Number(input.value);
      else value = input.value;
      if ('secret' in input.dataset && value === '') continue;
      if (value === undefined) continue;
      (payload[section] ??= {})[key] = value;
    }
    for (const picker of $$('[data-role-list]', form)) {
      if (!state.roleGuilds) continue; // bot offline: roles can't be shown, so leave the saved list untouched
      const [section, key] = picker.dataset.roleList.split('.');
      const shown = new Set($$('input[type="checkbox"]', picker).map((i) => i.value));
      // Keep roles from servers that aren't listed right now (e.g. temporarily unavailable).
      const kept = (state.settings[section][key] || []).filter((id) => !shown.has(id));
      const checked = $$('input[type="checkbox"]:checked', picker).map((i) => i.value);
      (payload[section] ??= {})[key] = [...new Set([...checked, ...kept])];
    }
    const button = $('button[type="submit"]', form);
    const result = await run(() => api('/settings', { method: 'PUT', body: payload }), { button, success: 'Settings saved' });
    if (result) {
      state.settings = result;
      fillSettings();
    }
  });
}

for (const button of $$('[data-clear]')) {
  button.addEventListener('click', async () => {
    const [section, key] = button.dataset.clear.split('.');
    if (!confirm('Remove this saved secret?')) return;
    const result = await run(() => api('/settings', { method: 'PUT', body: { [section]: { [key]: null } } }), { button, success: 'Removed' });
    if (result) {
      state.settings = result;
      fillSettings();
    }
  });
}

for (const button of $$('[data-copy]')) {
  button.addEventListener('click', () => copyText($(button.dataset.copy).value));
}

$('#bot-restart').addEventListener('click', (e) => run(() => api('/bot/restart', { method: 'POST' }), { button: e.currentTarget, success: 'Bot restarted' }));

$('#cookies-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 1_500_000) {
    toast('That file is too large to be a cookies file.', 'error');
    return;
  }
  $('#cookies-input').value = await file.text();
  event.target.value = '';
});

$('#cookies-save').addEventListener('click', async (e) => {
  const content = $('#cookies-input').value;
  const status = await run(() => api('/youtube/cookies', { method: 'PUT', body: { content } }), { button: e.currentTarget });
  if (!status) return;
  $('#cookies-input').value = '';
  toast(status.loggedIn ? 'Cookies saved; the bot is signed in to YouTube.' : 'Cookies saved, but no signed-in session was found in them.', status.loggedIn ? 'success' : 'info', 7000);
  state.settings.youtube.cookies = status;
  fillSettings();
});

$('#cookies-clear').addEventListener('click', async (e) => {
  if (!confirm('Sign the bot out of YouTube? It will play YouTube anonymously. (Your Google account stays signed in everywhere else.)')) return;
  const status = await run(() => api('/youtube/cookies', { method: 'DELETE' }), { button: e.currentTarget, success: 'The bot is signed out of YouTube' });
  if (status) {
    state.settings.youtube.cookies = status;
    fillSettings();
  }
});

// "Sign in to YouTube": a real browser (youtube-login container) shown in a modal through noVNC.
const loginModal = $('#youtube-login-modal');

function closeLoginModal() {
  loginModal.hidden = true;
  $('#youtube-login-frame').removeAttribute('src');
  $('#youtube-login-error').textContent = '';
}

async function cancelYoutubeLogin() {
  if (loginModal.hidden) return;
  closeLoginModal();
  await api('/youtube/login/cancel', { method: 'POST' }).catch(() => {});
}

$('#youtube-login').addEventListener('click', async (e) => {
  const result = await run(() => api('/youtube/login/start', { method: 'POST' }), { button: e.currentTarget });
  if (!result) return;
  $('#youtube-login-frame').src = result.viewerUrl;
  $('#youtube-login-newtab').href = result.viewerUrl;
  $('#youtube-login-error').textContent = '';
  loginModal.hidden = false;
  $('#youtube-login-frame').focus();
});

$('#youtube-login-finish').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  $('#youtube-login-error').textContent = '';
  button.disabled = true;
  button.classList.add('loading');
  try {
    const status = await api('/youtube/login/finish', { method: 'POST' });
    closeLoginModal();
    toast('Signed in: the bot now uses this YouTube account.', 'success', 6000);
    state.settings.youtube.cookies = status;
    fillSettings();
  } catch (err) {
    // The browser reopens on YouTube so the sign-in can be completed.
    $('#youtube-login-error').textContent = err.message;
    const frame = $('#youtube-login-frame');
    frame.src = frame.src;
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
  }
});

$('#youtube-login-cancel').addEventListener('click', cancelYoutubeLogin);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !loginModal.hidden) cancelYoutubeLogin();
});

function showResult(selector, ok, text) {
  const box = $(selector);
  box.hidden = false;
  box.className = `result-box ${ok ? 'ok' : 'bad'}`;
  box.textContent = text;
}

$('#youtube-test').addEventListener('click', async (e) => {
  const result = await run(() => api('/youtube/test', { method: 'POST' }), { button: e.currentTarget });
  if (!result) return;
  if (result.ok) showResult('#youtube-test-result', true, `✓ Playback works (${(result.ms / 1000).toFixed(1)} s)\nVideo: ${result.title}\nAudio format: ${result.format}`);
  else showResult('#youtube-test-result', false, `✗ ${result.error}\n\n${result.details || ''}`.trim());
});

$('#ytdlp-update').addEventListener('click', async (e) => {
  const result = await run(() => api('/system/ytdlp/update', { method: 'POST' }), { button: e.currentTarget });
  if (!result) return;
  toast(result.before === result.after ? `yt-dlp is already up to date (${result.after})` : `yt-dlp updated to ${result.after}`, 'success');
  $('#ytdlp-version').textContent = result.after;
});

$('#spotify-connect').addEventListener('click', (event) => {
  if ($('#spotify-connect').getAttribute('aria-disabled') === 'true') {
    event.preventDefault();
    toast('Save a Spotify client ID and secret first.', 'error');
  }
});

$('#spotify-disconnect').addEventListener('click', async (e) => {
  if (!confirm('Disconnect the Spotify account?')) return;
  const result = await run(() => api('/spotify/disconnect', { method: 'POST' }), { button: e.currentTarget, success: 'Spotify account disconnected' });
  if (result) {
    state.settings = result;
    fillSettings();
  }
});

$('#spotify-complete').addEventListener('click', async (e) => {
  const url = $('#spotify-paste').value.trim();
  const result = await run(() => api('/spotify/complete', { method: 'POST', body: { url } }), { button: e.currentTarget });
  if (!result) return;
  toast(`Spotify connected as ${result.name}`, 'success');
  $('#spotify-paste').value = '';
  state.settings = result.settings;
  fillSettings();
});

$('#spotify-test').addEventListener('click', async (e) => {
  const result = await run(() => api('/spotify/test', { method: 'POST' }), { button: e.currentTarget });
  if (!result) return;
  const line = (label, r, ok) => (r ? `${r.ok ? '✓' : '✗'} ${label}: ${r.ok ? ok(r) : r.error}` : `– ${label}: not configured`);
  const lines = [
    line('App credentials', result.credentials, () => 'valid'),
    line('Connected account', result.account, (r) => r.name),
    line('Public page reader', result.embed, (r) => r.sample),
  ];
  const ok = [result.credentials, result.account, result.embed].every((r) => !r || r.ok);
  showResult('#spotify-test-result', ok, lines.join('\n'));
});

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const next = $('#pw-next').value;
  if (next !== $('#pw-confirm').value) {
    toast('The new passwords don\'t match.', 'error');
    return;
  }
  const button = $('button[type="submit"]', event.target);
  const ok = await run(() => api('/auth/password', { method: 'POST', body: { current: $('#pw-current').value, next } }), {
    button,
    success: 'Password changed. Other sessions were signed out.',
  });
  if (ok) event.target.reset();
});

// ------------------------------------------------------------------ logs

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };

function logMatches(entry) {
  const minLevel = $('#log-level').value;
  const filter = $('#log-filter').value.trim().toLowerCase();
  if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[minLevel]) return false;
  return !filter || `${entry.scope} ${entry.message}`.toLowerCase().includes(filter);
}

function logRow(entry) {
  const time = new Date(entry.time);
  return el(
    'div',
    { class: `log-row ${entry.level}` },
    el('time', { datetime: time.toISOString(), title: time.toLocaleString() }, time.toLocaleTimeString([], { hour12: false })),
    el('span', { class: 'lvl' }, entry.level),
    el('span', { class: 'scope', title: entry.scope }, entry.scope),
    el('span', { class: 'msg' }, entry.message),
  );
}

function scrollLogs() {
  if ($('#log-autoscroll').checked) {
    const list = $('#log-list');
    list.scrollTop = list.scrollHeight;
  }
}

function renderLogs() {
  if (state.view !== 'logs') return;
  $('#log-list').replaceChildren(...state.logs.filter(logMatches).map(logRow));
  scrollLogs();
}

function appendLog(entry) {
  if (state.view !== 'logs' || !logMatches(entry)) return;
  const list = $('#log-list');
  list.append(logRow(entry));
  while (list.childElementCount > 1000) list.firstElementChild.remove();
  scrollLogs();
}

$('#log-level').addEventListener('change', renderLogs);
$('#log-filter').addEventListener('input', renderLogs);
$('#log-copy').addEventListener('click', () => {
  const text = state.logs
    .filter(logMatches)
    .map((e) => `${new Date(e.time).toISOString()} ${e.level.toUpperCase()} [${e.scope}] ${e.message}`)
    .join('\n');
  copyText(text);
});

// ------------------------------------------------------------------ boot

(async function boot() {
  try {
    const status = await api('/auth/status');
    if (status.authenticated) startApp();
    else showAuth(status.setupRequired);
  } catch (err) {
    document.body.textContent = `Could not reach the server: ${err.message}`;
  }
})();
