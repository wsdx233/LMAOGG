const $ = (id) => document.getElementById(id);

const EMOJI_PICKER_CDN_URL = 'https://cdn.jsdelivr.net/npm/emoji-picker-element@1/index.js';
const EMOJI_PICKER_I18N_CDN_URL = 'https://cdn.jsdelivr.net/npm/emoji-picker-element@1/i18n/zh_CN.js';
const COMMON_EMOJIS = Object.freeze([
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣',
  '😊', '😍', '😘', '🥰', '😎', '🤩', '🥳', '😇',
  '🙂', '😉', '😌', '😋', '😜', '🤔', '🫡', '🤗',
  '😢', '😭', '😤', '😡', '😱', '😳', '🥺', '😴',
  '👍', '👎', '👌', '✌️', '🤞', '👏', '🙌', '🙏',
  '💪', '🤝', '👀', '💬', '✨', '🔥', '💯', '❤️',
  '🧡', '💛', '💚', '💙', '💜', '🖤', '⭐', '🌟',
  '🎉', '🎊', '🎲', '🧭', '⚔️', '🛡️', '🏆', '🎒',
  '📜', '🗡️', '🪄', '🐉', '👻', '🤖', '☕', '🍻',
]);

const state = {
  authMode: 'login',
  me: null,
  socket: null,
  rooms: [],
  currentRoom: null,
  view: 'lobby',
  toastTimer: null,
  progressTimer: null,
  setupMode: 'random',
  playMode: 'cooperative',
  lastMessageCount: 0,
  lastMessageId: '',
  unseenMessages: 0,
  emojiPickerOpen: false,
  emojiPickerReady: false,
  emojiPickerLoading: null,
  gmInquiryPending: false,
};

const STATUS_LABELS = {
  waiting: '等待中',
  starting: '生成中',
  playing: '冒险中',
  ended: '已结束',
};

const PLAY_MODE_LABELS = {
  cooperative: '合作模式',
  independent: '独立模式',
  pvp: 'PVP 模式',
};

const PLAY_MODE_HINTS = {
  cooperative: '合作模式：玩家信息共享，共同完成目标。',
  independent: '独立模式：共同目标不变，但角色信息、行动结果与空间视角不自动共享；结局由 LLM 评选 MVP。',
  pvp: 'PVP 模式：玩家目标各不相同，可包含阵营对抗、间谍、隐藏身份或竞速胜利条件。',
};

const PRIVATE_INFO_MODES = new Set(['independent', 'pvp']);

const dom = {
  toast: $('toast'),
  authView: $('authView'),
  appView: $('appView'),
  loginTab: $('loginTab'),
  registerTab: $('registerTab'),
  authForm: $('authForm'),
  authSubmit: $('authSubmit'),
  usernameInput: $('usernameInput'),
  passwordInput: $('passwordInput'),
  meName: $('meName'),
  logoutButton: $('logoutButton'),
  lobbyView: $('lobbyView'),
  gameView: $('gameView'),
  toLobbyButton: $('toLobbyButton'),
  backToLobbyButton: $('backToLobbyButton'),
  currentRoomPill: $('currentRoomPill'),
  connectionDot: $('connectionDot'),
  drawerOverlay: $('drawerOverlay'),
  openLeftDrawerButton: $('openLeftDrawerButton'),
  openRightDrawerButton: $('openRightDrawerButton'),
  closeLeftDrawerButton: $('closeLeftDrawerButton'),
  closeRightDrawerButton: $('closeRightDrawerButton'),
  createRoomForm: $('createRoomForm'),
  roomNameInput: $('roomNameInput'),
  roomList: $('roomList'),
  roomCount: $('roomCount'),
  resumeRoomCard: $('resumeRoomCard'),
  resumeRoomName: $('resumeRoomName'),
  resumeRoomMeta: $('resumeRoomMeta'),
  resumeRoomButton: $('resumeRoomButton'),
  gameRoomName: $('gameRoomName'),
  gameRoomCode: $('gameRoomCode'),
  gameStatusLine: $('gameStatusLine'),
  gameTitle: $('gameTitle'),
  playerCountBadge: $('playerCountBadge'),
  playerList: $('playerList'),
  messageList: $('messageList'),
  newMessagesButton: $('newMessagesButton'),
  startSetupModal: $('startSetupModal'),
  closeStartSetupButton: $('closeStartSetupButton'),
  cancelStartSetupButton: $('cancelStartSetupButton'),
  startSetupForm: $('startSetupForm'),
  setupOptionButtons: [...document.querySelectorAll('[data-setup-mode]')],
  playModeOptionButtons: [...document.querySelectorAll('[data-play-mode]')],
  playModeHint: $('playModeHint'),
  randomSetupPanel: $('randomSetupPanel'),
  briefSetupPanel: $('briefSetupPanel'),
  detailedSetupPanel: $('detailedSetupPanel'),
  briefSetupInput: $('briefSetupInput'),
  detailTitleInput: $('detailTitleInput'),
  detailGenreInput: $('detailGenreInput'),
  detailSettingInput: $('detailSettingInput'),
  detailGoalInput: $('detailGoalInput'),
  detailToneInput: $('detailToneInput'),
  detailDifficultyInput: $('detailDifficultyInput'),
  detailCharactersInput: $('detailCharactersInput'),
  detailRulesInput: $('detailRulesInput'),
  confirmStartSetupButton: $('confirmStartSetupButton'),
  addBotButton: $('addBotButton'),
  retryLlmButton: $('retryLlmButton'),
  startGameButton: $('startGameButton'),
  endAdventureButton: $('endAdventureButton'),
  deleteRoomButton: $('deleteRoomButton'),
  leaveRoomButton: $('leaveRoomButton'),
  progressTrack: $('progressTrack'),
  progressFill: $('progressFill'),
  turnHint: $('turnHint'),
  turnClock: $('turnClock'),
  composerInput: $('composerInput'),
  emojiPickerButton: $('emojiPickerButton'),
  emojiPickerPopover: $('emojiPickerPopover'),
  closeEmojiPickerButton: $('closeEmojiPickerButton'),
  quickEmojiList: $('quickEmojiList'),
  emojiPicker: $('emojiPicker'),
  emojiPickerFallback: $('emojiPickerFallback'),
  sendChatButton: $('sendChatButton'),
  askGmButton: $('askGmButton'),
  submitActionButton: $('submitActionButton'),
  dossierContent: $('dossierContent'),
};

function showToast(message, tone = 'info') {
  dom.toast.textContent = message;
  dom.toast.style.background = tone === 'error' ? '#ffd1d1' : tone === 'success' ? '#c6ff00' : '#67e8f9';
  dom.toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin',
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload;
}

function setAuthMode(mode) {
  state.authMode = mode;
  dom.loginTab.classList.toggle('active', mode === 'login');
  dom.registerTab.classList.toggle('active', mode === 'register');
  dom.authSubmit.textContent = mode === 'login' ? '进入大厅' : '创建账号并进入';
  dom.passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
}

function showAuth() {
  closeDrawers();
  closeStartSetupModal();
  closeEmojiPicker();
  state.me = null;
  state.currentRoom = null;
  state.rooms = [];
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
  stopProgressLoop();
  dom.authView.classList.remove('hidden');
  dom.appView.classList.add('hidden');
  dom.appView.classList.remove('game-mode');
  dom.passwordInput.value = '';
}

function showApp() {
  dom.meName.textContent = state.me?.username || '-';
  dom.authView.classList.add('hidden');
  dom.appView.classList.remove('hidden');
  showLobby();
}

function showLobby() {
  state.view = 'lobby';
  closeDrawers();
  closeEmojiPicker();
  dom.appView.classList.remove('game-mode');
  dom.lobbyView.classList.remove('hidden');
  dom.gameView.classList.add('hidden');
  dom.toLobbyButton.classList.add('active');
  dom.currentRoomPill.classList.toggle('hidden', !state.currentRoom);
  dom.currentRoomPill.classList.remove('active');
  renderLobby();
}

function showGame() {
  if (!state.currentRoom) return showLobby();
  state.view = 'game';
  state.lastMessageCount = state.currentRoom.messages?.length || 0;
  state.lastMessageId = state.currentRoom.messages?.at(-1)?.id || '';
  state.unseenMessages = 0;
  dom.appView.classList.add('game-mode');
  dom.lobbyView.classList.add('hidden');
  dom.gameView.classList.remove('hidden');
  dom.toLobbyButton.classList.remove('active');
  dom.currentRoomPill.classList.remove('hidden');
  dom.currentRoomPill.classList.add('active');
  renderGame();
}

function openDrawer(side) {
  if (side === 'left') {
    dom.gameView.classList.add('drawer-open-left');
    dom.gameView.classList.remove('drawer-open-right');
  } else {
    dom.gameView.classList.add('drawer-open-right');
    dom.gameView.classList.remove('drawer-open-left');
  }
  dom.drawerOverlay.classList.remove('hidden');
}

function closeDrawers() {
  dom.gameView?.classList.remove('drawer-open-left', 'drawer-open-right');
  dom.drawerOverlay?.classList.add('hidden');
}

function setSetupMode(mode) {
  state.setupMode = ['brief', 'detailed'].includes(mode) ? mode : 'random';
  for (const button of dom.setupOptionButtons) {
    button.classList.toggle('active', button.dataset.setupMode === state.setupMode);
  }
  if (dom.randomSetupPanel) dom.randomSetupPanel.classList.toggle('hidden', state.setupMode !== 'random');
  if (dom.briefSetupPanel) dom.briefSetupPanel.classList.toggle('hidden', state.setupMode !== 'brief');
  if (dom.detailedSetupPanel) dom.detailedSetupPanel.classList.toggle('hidden', state.setupMode !== 'detailed');
}

function setPlayMode(mode) {
  state.playMode = ['independent', 'pvp'].includes(mode) ? mode : 'cooperative';
  for (const button of dom.playModeOptionButtons) {
    button.classList.toggle('active', button.dataset.playMode === state.playMode);
  }
  if (dom.playModeHint) dom.playModeHint.textContent = PLAY_MODE_HINTS[state.playMode] || PLAY_MODE_HINTS.cooperative;
}

function openStartSetupModal() {
  if (!state.currentRoom) return;
  setSetupMode(state.setupMode || 'random');
  setPlayMode(state.currentRoom?.playMode || state.currentRoom?.game?.playMode || state.playMode || 'cooperative');
  dom.startSetupModal.classList.remove('hidden');
  requestAnimationFrame(() => {
    if (state.setupMode === 'brief') dom.briefSetupInput.focus();
    else dom.confirmStartSetupButton.focus();
  });
}

function closeStartSetupModal() {
  dom.startSetupModal.classList.add('hidden');
}

function readStartSetupPayload() {
  if (state.setupMode === 'brief') {
    return {
      mode: 'brief',
      playMode: state.playMode,
      brief: dom.briefSetupInput.value.trim(),
    };
  }
  if (state.setupMode === 'detailed') {
    return {
      mode: 'detailed',
      playMode: state.playMode,
      details: {
        title: dom.detailTitleInput.value.trim(),
        genre: dom.detailGenreInput.value.trim(),
        setting: dom.detailSettingInput.value.trim(),
        goal: dom.detailGoalInput.value.trim(),
        tone: dom.detailToneInput.value.trim(),
        difficulty: dom.detailDifficultyInput.value.trim(),
        characters: dom.detailCharactersInput.value.trim(),
        rules: dom.detailRulesInput.value.trim(),
      },
    };
  }
  return { mode: 'random', playMode: state.playMode };
}

function isNearMessageBottom(threshold = 120) {
  const list = dom.messageList;
  return list.scrollHeight - list.scrollTop - list.clientHeight < threshold;
}

function scrollMessagesToBottom() {
  dom.messageList.scrollTop = dom.messageList.scrollHeight;
  state.lastMessageCount = state.currentRoom?.messages?.length || 0;
  state.lastMessageId = state.currentRoom?.messages?.at(-1)?.id || '';
  state.unseenMessages = 0;
  updateNewMessagesButton();
}

function updateNewMessagesButton() {
  const count = state.unseenMessages;
  if (!dom.newMessagesButton) return;
  dom.newMessagesButton.classList.toggle('hidden', count <= 0 || isNearMessageBottom());
  dom.newMessagesButton.textContent = `↓ ${count} 条新消息`;
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  const socket = io();
  state.socket = socket;

  socket.on('connect', () => {
    dom.connectionDot.classList.add('online');
  });

  socket.on('disconnect', () => {
    dom.connectionDot.classList.remove('online');
  });

  socket.on('connect_error', (error) => {
    dom.connectionDot.classList.remove('online');
    showToast(error.message === 'unauthorized' ? '登录已失效，请重新登录。' : `连接失败：${error.message}`, 'error');
  });

  socket.on('lobby:update', (rooms) => {
    state.rooms = Array.isArray(rooms) ? rooms : [];
    renderLobby();
  });

  socket.on('room:update', (room) => {
    state.currentRoom = room;
    dom.currentRoomPill.classList.remove('hidden');
    if (state.view === 'game') renderGame();
    renderLobby();
  });

  socket.on('room:closed', ({ reason }) => {
    state.currentRoom = null;
    showToast(reason || '房间已关闭。');
    showLobby();
  });
}

function emitAck(event, payload = {}, timeout = 70000) {
  return new Promise((resolve, reject) => {
    if (!state.socket?.connected) return reject(new Error('尚未连接服务器。'));
    state.socket.timeout(timeout).emit(event, payload, (error, response) => {
      if (error) return reject(new Error('服务器响应超时，请稍后再试。'));
      if (!response?.ok) return reject(new Error(response?.error || '操作失败。'));
      resolve(response);
    });
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderQuickEmojiList() {
  if (!dom.quickEmojiList || dom.quickEmojiList.childElementCount) return;
  const fragment = document.createDocumentFragment();
  for (const emoji of COMMON_EMOJIS) {
    const button = el('button', 'quick-emoji-button', emoji);
    button.type = 'button';
    button.dataset.emoji = emoji;
    button.setAttribute('aria-label', `插入 ${emoji}`);
    fragment.append(button);
  }
  dom.quickEmojiList.append(fragment);
}

function loadEmojiPickerLibrary() {
  if (state.emojiPickerReady) return Promise.resolve();
  if (state.emojiPickerLoading) return state.emojiPickerLoading;
  dom.emojiPickerFallback?.classList.add('hidden');
  dom.emojiPickerPopover?.classList.add('loading');
  state.emojiPickerLoading = Promise.all([
    import(EMOJI_PICKER_CDN_URL),
    import(EMOJI_PICKER_I18N_CDN_URL).catch((error) => {
      console.warn('[emoji] failed to load zh-CN i18n:', error);
      return null;
    }),
  ])
    .then(([, i18nModule]) => {
      if (dom.emojiPicker) {
        dom.emojiPicker.locale = 'zh';
        if (i18nModule?.default) dom.emojiPicker.i18n = i18nModule.default;
      }
      state.emojiPickerReady = true;
      dom.emojiPickerPopover?.classList.remove('loading');
    })
    .catch((error) => {
      console.warn('[emoji] failed to load emoji-picker-element:', error);
      dom.emojiPickerPopover?.classList.remove('loading');
      dom.emojiPickerFallback?.classList.remove('hidden');
      state.emojiPickerLoading = null;
    });
  return state.emojiPickerLoading;
}

function setEmojiPickerOpen(open) {
  if (!dom.emojiPickerButton || !dom.emojiPickerPopover) return;
  const shouldOpen = Boolean(open && !dom.emojiPickerButton.disabled);
  state.emojiPickerOpen = shouldOpen;
  dom.emojiPickerPopover.classList.toggle('hidden', !shouldOpen);
  dom.emojiPickerButton.classList.toggle('active', shouldOpen);
  dom.emojiPickerButton.setAttribute('aria-expanded', String(shouldOpen));
  if (shouldOpen) {
    renderQuickEmojiList();
    loadEmojiPickerLibrary();
  }
}

function closeEmojiPicker() {
  setEmojiPickerOpen(false);
}

function insertEmojiIntoComposer(emoji) {
  const text = String(emoji || '');
  const input = dom.composerInput;
  if (!text || !input || input.disabled) return;

  const value = input.value || '';
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
  const nextValue = `${value.slice(0, start)}${text}${value.slice(end)}`;
  const maxLength = Number(input.getAttribute('maxlength') || input.maxLength || 0);

  if (maxLength > 0 && nextValue.length > maxLength) {
    showToast(`最多可输入 ${maxLength} 个字符，无法继续插入 Emoji。`, 'error');
    input.focus();
    return;
  }

  input.value = nextValue;
  const caret = start + text.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function statusBadge(status) {
  const badge = el('span', `status-badge ${status || ''}`, STATUS_LABELS[status] || status || '未知');
  return badge;
}

function formatClock(value) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  } catch {
    return '--:--';
  }
}

function formatMs(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const min = String(Math.floor(seconds / 60)).padStart(2, '0');
  const sec = String(seconds % 60).padStart(2, '0');
  return `${min}:${sec}`;
}

function initials(name) {
  if (!name) return '?';
  if (name === 'LLM GM') return 'GM';
  return [...name.trim()][0]?.toUpperCase() || '?';
}

function statEntries(stats) {
  if (!stats || typeof stats !== 'object') return [];
  const preferred = ['hp', 'stamina'];
  const keys = [...preferred.filter((key) => stats[key]), ...Object.keys(stats).filter((key) => !preferred.includes(key))];
  return keys.map((key) => ({ key, ...stats[key] })).filter((stat) => stat && stat.label);
}

function statText(stats) {
  const entries = statEntries(stats).slice(0, 4);
  return entries.map((stat) => `${stat.label}:${stat.value}/${stat.max}`).join(' · ');
}

function tagList(tags) {
  return Array.isArray(tags) && tags.length ? tags : ['无状态'];
}

function isCurrentRoom(roomId) {
  return state.currentRoom?.id === roomId;
}

function renderLobby() {
  if (dom.appView.classList.contains('hidden')) return;
  dom.roomCount.textContent = String(state.rooms.length);
  dom.currentRoomPill.classList.toggle('hidden', !state.currentRoom);

  if (state.currentRoom) {
    dom.resumeRoomCard.classList.remove('hidden');
    dom.resumeRoomName.textContent = state.currentRoom.name;
    dom.resumeRoomMeta.textContent = `${state.currentRoom.playModeLabel || PLAY_MODE_LABELS[state.currentRoom.playMode] || '合作模式'} · ${STATUS_LABELS[state.currentRoom.status] || state.currentRoom.status} · ${state.currentRoom.players?.length || 0}/${state.currentRoom.maxPlayers} 人 · #${state.currentRoom.id}`;
  } else {
    dom.resumeRoomCard.classList.add('hidden');
  }

  clear(dom.roomList);
  if (!state.rooms.length) {
    dom.roomList.append(el('div', 'empty-state', '大厅还没有房间。创建第一张冒险桌吧！'));
    return;
  }

  const sortedRooms = [...state.rooms].sort((a, b) => {
    const order = { waiting: 0, starting: 1, playing: 2, ended: 3 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9) || new Date(b.createdAt) - new Date(a.createdAt);
  });

  for (const room of sortedRooms) {
    const card = el('article', `room-card ${room.status}`);
    const header = el('div', 'room-card-header');
    const titleWrap = el('div');
    titleWrap.append(el('h4', '', room.name));
    titleWrap.append(el('div', 'room-meta', `#${room.id} · 房主 ${room.hostName}`));
    header.append(titleWrap, statusBadge(room.status));

    const meta = el('div', 'room-meta');
    meta.append(
      el('span', 'badge', `${room.presentCount ?? room.playerCount}/${room.playerCount}/${room.maxPlayers} 在线/角色/上限`),
      el('span', 'badge mode-badge', room.playModeLabel || PLAY_MODE_LABELS[room.playMode] || '合作模式'),
      el('span', 'badge', room.title ? `《${room.title}》` : '未开局'),
      el('span', 'badge', room.turnNumber ? `第 ${room.turnNumber} 回合` : '大厅等待')
    );

    const isParticipant = Array.isArray(room.playerIds) && room.playerIds.includes(state.me?.id);
    const canJoinOrReturn = ['waiting', 'ended'].includes(room.status) || (room.status === 'playing' && isParticipant);
    const actionLabel = isCurrentRoom(room.id)
      ? '进入房间'
      : room.status === 'playing' && isParticipant
        ? '返回继续'
        : room.status === 'ended'
          ? '加入重开'
          : '加入房间';
    const actions = el('div', 'room-actions');
    const action = el('button', 'primary-btn small', actionLabel);
    action.type = 'button';
    action.disabled = !isCurrentRoom(room.id) && !canJoinOrReturn;
    action.addEventListener('click', async () => {
      if (isCurrentRoom(room.id)) return showGame();
      try {
        const response = await emitAck('room:join', { roomId: room.id });
        state.currentRoom = response.room;
        showGame();
        showToast('已加入房间。', 'success');
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
    actions.append(action);

    if (room.hostId === state.me?.id) {
      const deleteButton = el('button', 'danger-btn small', '删除');
      deleteButton.type = 'button';
      deleteButton.addEventListener('click', async () => {
        if (!confirm(`确定永久删除「${room.name}」吗？此操作不可恢复。`)) return;
        try {
          await emitAck('room:delete', { roomId: room.id });
          if (state.currentRoom?.id === room.id) state.currentRoom = null;
          showToast('冒险桌已删除。', 'success');
        } catch (error) {
          showToast(error.message, 'error');
        }
      });
      actions.append(deleteButton);
    }

    card.append(header, meta, actions);
    dom.roomList.append(card);
  }
}

function renderGame() {
  const room = state.currentRoom;
  if (!room) return;

  const wasNearBottom = isNearMessageBottom();
  const messages = room.messages || [];
  const previousMessageCount = state.lastMessageCount;
  const previousLastMessageId = state.lastMessageId;
  const nextMessageCount = messages.length;
  const nextLastMessageId = messages.at(-1)?.id || '';
  const hasNewMessages = Boolean(previousLastMessageId && nextLastMessageId && nextLastMessageId !== previousLastMessageId);
  const previousIndex = previousLastMessageId ? messages.findIndex((message) => message.id === previousLastMessageId) : -1;
  const newMessageCount = hasNewMessages
    ? previousIndex >= 0
      ? nextMessageCount - previousIndex - 1
      : Math.max(1, nextMessageCount - previousMessageCount)
    : 0;

  if (!previousLastMessageId) {
    state.lastMessageCount = nextMessageCount;
    state.lastMessageId = nextLastMessageId;
  }

  dom.gameRoomName.textContent = room.name;
  dom.gameRoomCode.textContent = room.id;
  dom.gameStatusLine.textContent = `${room.playModeLabel || PLAY_MODE_LABELS[room.playMode] || '合作模式'} · ${STATUS_LABELS[room.status] || room.status}${room.currentTurn?.paused ? ' · 已暂停' : ''} · ${room.players.filter((player) => player.present).length}/${room.players.length}/${room.maxPlayers} 在线/角色/上限`;
  dom.gameTitle.textContent = room.game?.title || (room.status === 'starting' ? 'LLM 正在织梦……' : '等待开局');
  dom.playerCountBadge.textContent = `${room.players.length}/${room.maxPlayers}`;

  const isHost = room.hostId === state.me?.id;
  const canStart = ['waiting', 'ended'].includes(room.status) && isHost;
  const canRetryLlm = Boolean(isHost && room.currentTurn?.llmError);
  dom.addBotButton.classList.toggle('hidden', !(isHost && ['waiting', 'ended'].includes(room.status)));
  dom.addBotButton.disabled = !(isHost && ['waiting', 'ended'].includes(room.status));
  dom.retryLlmButton.classList.toggle('hidden', !canRetryLlm);
  dom.retryLlmButton.disabled = !canRetryLlm;
  dom.startGameButton.classList.toggle('hidden', !canStart);
  dom.startGameButton.disabled = !canStart;
  dom.startGameButton.textContent = room.status === 'ended' || room.game ? '重新开始' : '开始游戏';
  dom.startGameButton.dataset.mobileIcon = room.status === 'ended' || room.game ? '↻' : '▶';
  dom.startGameButton.setAttribute('aria-label', dom.startGameButton.textContent);
  dom.startGameButton.title = dom.startGameButton.textContent;
  const canEndAdventure = isHost && ['starting', 'playing'].includes(room.status);
  dom.endAdventureButton.classList.toggle('hidden', !canEndAdventure);
  dom.endAdventureButton.disabled = !canEndAdventure;
  dom.deleteRoomButton.classList.toggle('hidden', !isHost);
  dom.deleteRoomButton.disabled = !isHost;

  renderPlayers(room);
  renderMessages(room);
  renderDossier(room);
  updateComposer(room);
  startProgressLoop();

  if (hasNewMessages && !wasNearBottom) {
    state.unseenMessages += newMessageCount;
  }
  state.lastMessageCount = nextMessageCount;
  state.lastMessageId = nextLastMessageId;

  if (wasNearBottom) {
    requestAnimationFrame(scrollMessagesToBottom);
  } else {
    updateNewMessagesButton();
  }
}

function renderPlayers(room) {
  clear(dom.playerList);
  const canManageBots = room.hostId === state.me?.id && ['waiting', 'ended'].includes(room.status);
  for (const player of room.players) {
    const row = el('div', `player-row ${player.canAct ? '' : 'unable'} ${player.isBot ? 'bot' : ''}`);
    const dot = el('span', `player-dot ${player.online ? 'online' : ''}`);
    const main = el('div', 'player-main');
    main.append(el('span', 'player-name', `${player.username}${player.isBot ? ' · Bot' : ''}${player.isSelf ? ' · 你' : ''}`));
    main.append(el('span', 'player-role', player.infoPrivate ? player.infoNote : (player.role || (room.status === 'waiting' ? '等待角色生成' : '未知角色'))));
    main.append(el('span', 'player-stats', player.infoPrivate ? '信息未共享' : (statText(player.stats) || '生命值:10/10 · 体力:10/10')));
    const tags = el('div', 'mini-tags');
    if (player.location?.label) tags.append(el('span', 'mini-tag location-tag', player.location.label));
    for (const tag of tagList(player.statusTags).slice(0, 4)) tags.append(el('span', 'mini-tag', tag));
    if (player.sameSpace && !player.isSelf && room.isPrivateInfoMode) tags.append(el('span', 'mini-tag', '同空间'));
    if (!player.present && !player.isBot) tags.append(el('span', 'mini-tag', '离席'));
    main.append(tags);

    let side;
    if (player.isBot && canManageBots) {
      side = el('button', 'mini-remove-btn', '移除');
      side.type = 'button';
      side.addEventListener('click', async () => {
        try {
          await emitAck('room:bot:remove', { roomId: room.id, botId: player.id });
          showToast(`${player.username} 已移除。`, 'success');
        } catch (error) {
          showToast(error.message, 'error');
        }
      });
    } else {
      side = el('span', 'host-crown', player.id === room.hostId ? '♛' : (player.condition?.canAct === false ? '×' : ''));
    }
    row.append(dot, main, side);
    dom.playerList.append(row);
  }
}

function stateChangeText(change) {
  if (!change) return '';
  if (change.kind === 'stat') {
    const delta = Number(change.delta || 0);
    const sign = delta > 0 ? '+' : '';
    return `${change.label} ${change.before} → ${change.after}${delta ? ` (${sign}${delta})` : ''}`;
  }
  if (change.kind === 'inventory') return `${change.action === 'add' ? '获得' : '失去'}：${(change.items || []).join('、')}`;
  if (change.kind === 'status') return `${change.action === 'add' ? '新增状态' : '移除状态'}：${(change.tags || []).join('、')}`;
  if (change.kind === 'location') return `位置：${change.beforeLabel || '未知'} → ${change.afterLabel || '未知'}`;
  return change.summary || '';
}

function stateChangeIcon(change) {
  if (change?.kind === 'stat') return Number(change.delta || 0) >= 0 ? '✦' : '🔥';
  if (change?.kind === 'inventory') return change.action === 'add' ? '🎒' : '🧺';
  if (change?.kind === 'status') return change.action === 'add' ? '🏷️' : '✨';
  if (change?.kind === 'location') return '🧭';
  return '⚡';
}

function renderStateMessage(message) {
  const item = el('article', 'message state');
  const body = el('div', 'state-card');
  const header = el('div', 'state-card-header');
  header.append(el('span', 'state-burst', '⚡'), el('strong', '', message.title || '状态变化'));
  if (message.visibilityLabel || message.privateTo) header.append(el('span', 'state-visibility', message.visibilityLabel || '仅你可见'));
  body.append(header);

  const events = Array.isArray(message.events) ? message.events : [];
  if (!events.length) {
    body.append(el('p', 'state-summary', message.summary || message.text || '状态发生变化。'));
  } else {
    const grid = el('div', 'state-event-grid');
    for (const event of events) {
      const eventCard = el('section', 'state-event');
      const eventHeader = el('div', 'state-event-title');
      eventHeader.append(el('span', 'state-player', event.username || '角色'));
      if (event.reason) eventHeader.append(el('span', 'state-reason', event.reason));
      eventCard.append(eventHeader);
      const changes = el('div', 'state-change-list');
      for (const change of event.changes || []) {
        const row = el('div', `state-change ${change.kind || ''}`);
        row.append(el('span', 'state-change-icon', stateChangeIcon(change)), el('span', '', stateChangeText(change)));
        if (change.kind === 'stat' && Number(change.max) > 0) {
          const bar = el('span', 'state-mini-bar');
          const fill = el('span', 'state-mini-bar-fill');
          fill.style.width = `${Math.max(0, Math.min(100, (Number(change.after || 0) / Math.max(1, Number(change.max || 1))) * 100))}%`;
          bar.append(fill);
          row.append(bar);
        }
        changes.append(row);
      }
      eventCard.append(changes);
      grid.append(eventCard);
    }
    body.append(grid);
  }
  item.append(body);
  return item;
}

function renderAwardMessage(message) {
  const item = el('article', 'message award');
  const body = el('div', 'award-card');
  body.append(el('div', 'award-crown', '🏆'));
  const content = el('div');
  content.append(el('div', 'award-title', `${message.title || 'MVP'}｜${message.mvp?.username || '未揭晓'}`));
  content.append(el('p', '', message.mvp?.reason || message.text || 'LLM GM 评定的本局高光玩家。'));
  body.append(content);
  item.append(body);
  return item;
}

function renderMessages(room) {
  clear(dom.messageList);
  if (!room.messages?.length) {
    state.unseenMessages = 0;
    dom.messageList.append(el('div', 'empty-state', '还没有消息。可以先在房间里打个招呼。'));
    updateNewMessagesButton();
    return;
  }

  for (const message of room.messages) {
    const type = message.type || 'chat';
    if (type === 'state') {
      dom.messageList.append(renderStateMessage(message));
      continue;
    }
    if (type === 'award') {
      dom.messageList.append(renderAwardMessage(message));
      continue;
    }

    const item = el('article', `message ${type}`);
    const author = type === 'gm' ? 'LLM GM' : type === 'system' ? '系统' : message.username || '玩家';
    const label = type === 'action' ? '行动' : type === 'ask' ? '询问' : type === 'say' ? '说话' : type === 'chat' ? '聊天' : type === 'gm' ? (message.inquiryId ? '回答' : '播报') : '系统';

    if (type !== 'system') {
      item.append(el('div', 'message-avatar', initials(author)));
    }

    const body = el('div', 'message-body');
    const meta = el('div', 'message-meta');
    meta.append(el('span', 'message-author', author), el('span', '', label));
    if (message.visibilityLabel || message.audienceLabel) meta.append(el('span', 'visibility-chip', message.visibilityLabel || message.audienceLabel));
    meta.append(el('span', '', formatClock(message.createdAt)));
    const text = el('div', 'message-text', message.text);
    body.append(meta, text);
    item.append(body);
    dom.messageList.append(item);
  }
}

function renderDossier(room) {
  clear(dom.dossierContent);
  if (!room.game) {
    const card = el('section', 'dossier-card');
    card.append(el('h4', '', '尚未生成'), el('p', '', '房主开始游戏后，LLM 会自动生成世界背景、玩家角色和游戏目标。'));
    dom.dossierContent.append(card);
    return;
  }

  const world = el('section', 'dossier-card');
  world.append(el('h4', '', room.game.title || '世界设定'), el('p', '', room.game.setting || '暂无设定'));

  const goal = el('section', 'dossier-card');
  goal.append(el('h4', '', room.playMode === 'pvp' || room.game.playMode === 'pvp' ? '公开局势' : '共同目标'), el('p', '', room.game.globalGoal || '暂无目标'));

  const tone = el('section', 'dossier-card');
  tone.append(el('h4', '', '叙事风格'), el('p', '', `${room.game.tone || '未知'} · ${room.playModeLabel || room.game.playModeLabel || '合作模式'} · Provider: ${room.game.provider || 'unknown'}`));

  dom.dossierContent.append(world, goal, tone);

  for (const player of room.players) {
    const card = el('section', 'dossier-card');
    card.append(el('h4', '', `${player.username}${player.isBot ? ' · LLM Bot' : ''}${player.isSelf ? ' · 你' : ''}｜${player.role || '未知角色'}`));
    if (player.infoPrivate) {
      card.classList.add('private-dossier');
      card.append(el('p', '', `信息未共享：${player.infoNote || '你暂时不知道该角色的目标、状态和物品。'}`));
      if (player.location?.label) card.append(el('p', '', `可见空间：${player.location.label}`));
      dom.dossierContent.append(card);
      continue;
    }
    card.append(el('p', '', player.personalGoal ? `个人目标：${player.personalGoal}` : '个人目标：等待揭晓'));
    if (player.location?.label) card.append(el('p', '', `当前位置：${player.location.label}`));

    const condition = el('div', 'dossier-tags');
    condition.append(el('span', `condition-pill ${player.condition?.state || 'active'}`, player.condition?.label || '可行动'));
    for (const tag of tagList(player.statusTags)) condition.append(el('span', 'mini-tag', tag));
    card.append(condition);

    const stats = el('div', 'stat-grid');
    for (const stat of statEntries(player.stats)) {
      const statBox = el('div', 'stat-box');
      statBox.append(el('span', 'stat-label', stat.label), el('strong', '', `${stat.value}/${stat.max}`));
      const bar = el('div', 'stat-bar');
      const fill = el('div', 'stat-bar-fill');
      fill.style.width = `${Math.max(0, Math.min(100, (Number(stat.value || 0) / Math.max(1, Number(stat.max || 1))) * 100))}%`;
      bar.append(fill);
      statBox.append(bar);
      stats.append(statBox);
    }
    card.append(stats);

    const inventoryTitle = el('p', 'inventory-title', '物品栏');
    const items = el('ul');
    const inventory = Array.isArray(player.inventory) && player.inventory.length ? player.inventory : ['暂无物品'];
    for (const item of inventory) items.append(el('li', '', item));
    card.append(inventoryTitle, items);
    dom.dossierContent.append(card);
  }
}

function updateComposer(room) {
  const turn = room.currentTurn;
  const inPlayingTurn = room.status === 'playing' && turn;
  const isResolving = Boolean(turn?.resolving);
  const isPaused = Boolean(turn?.paused);
  const canSubmitDuringNoResponsePause = Boolean(isPaused && turn?.pauseKind === 'no-response');
  const submitted = Boolean(turn?.viewerSubmitted);
  const canWithdraw = Boolean(turn?.viewerCanWithdraw);
  const inquiryLimit = Number(turn?.viewerInquiryLimit || 3);
  const inquiryCount = Number(turn?.viewerInquiryCount || 0);
  const inquiryRemaining = Math.max(0, inquiryLimit - inquiryCount);
  const canAskGm = Boolean(turn?.viewerCanAskGm && inquiryRemaining > 0);
  const viewer = room.players.find((player) => player.id === state.me?.id);
  const viewerCanAct = Boolean(turn?.viewerCanAct);
  const inquiryCue = inPlayingTurn && viewerCanAct && !submitted
    ? `(询问${inquiryRemaining}/${inquiryLimit})`
    : '';
  const viewerCanPerceive = viewer?.condition?.canPerceive !== false;
  const privateMode = PRIVATE_INFO_MODES.has(room.playMode || room.game?.playMode);

  dom.sendChatButton.textContent = privateMode ? '说话' : '聊天';
  dom.askGmButton.textContent = '询问';
  dom.submitActionButton.textContent = submitted ? (canWithdraw ? '撤销' : '完成') : (privateMode ? '行动' : '行动');
  dom.submitActionButton.classList.toggle('danger-btn', submitted && canWithdraw);
  dom.submitActionButton.classList.toggle('primary-btn', !(submitted && canWithdraw));
  dom.progressTrack.classList.toggle('hidden', !inPlayingTurn);
  dom.progressTrack.classList.toggle('resolving', isResolving);
  dom.progressTrack.classList.toggle('paused', isPaused);
  dom.progressTrack.classList.toggle('error', Boolean(turn?.llmError));
  const blocksPrivateSpeech = room.status === 'playing' && privateMode && !viewerCanPerceive;
  const composerDisabled = room.status === 'starting' || blocksPrivateSpeech;
  dom.submitActionButton.disabled = submitted
    ? !canWithdraw
    : !(inPlayingTurn && !isResolving && (!isPaused || canSubmitDuringNoResponsePause) && viewerCanAct);
  dom.askGmButton.disabled = state.gmInquiryPending || composerDisabled || !canAskGm;
  dom.sendChatButton.disabled = composerDisabled;
  dom.composerInput.disabled = composerDisabled;
  dom.emojiPickerButton.disabled = composerDisabled;
  if (composerDisabled) closeEmojiPicker();

  if (room.status === 'waiting') {
    dom.turnHint.textContent = room.hostId === state.me?.id ? '你是房主：可等待玩家加入，或直接开始。' : '等待房主开始游戏。';
    dom.turnClock.textContent = '--:--';
    dom.composerInput.placeholder = privateMode ? '可以先说话；只有同空间角色能听见。' : '可以先发送聊天，讨论要不要开局。';
  } else if (room.status === 'starting') {
    dom.turnHint.textContent = 'LLM 正在生成背景、角色与目标……';
    dom.turnClock.textContent = '生成中';
    dom.composerInput.placeholder = '生成中，请稍候。';
  } else if (room.status === 'ended') {
    dom.turnHint.textContent = privateMode ? '冒险已结束。可说话复盘。' : '冒险已结束。仍可聊天复盘。';
    dom.turnClock.textContent = 'END';
    dom.composerInput.placeholder = privateMode ? '冒险结束，可说话复盘。' : '写下你的复盘或彩蛋。';
  } else if (isResolving) {
    dom.turnHint.textContent = '本回合已锁定，LLM GM 正在结算……';
    dom.turnClock.textContent = '结算中';
    dom.composerInput.placeholder = '结算中，可以稍后继续行动。';
  } else if (turn?.llmError) {
    dom.turnHint.textContent = `LLM 调用失败，已暂停。${room.hostId === state.me?.id ? '点击顶部 ↺ 重试。' : '等待房主重试。'}`;
    dom.turnClock.textContent = '失败';
    dom.composerInput.placeholder = privateMode ? 'LLM 失败暂停中，可以说话讨论（同空间可听）或等待重试。' : 'LLM 失败暂停中，可以发送聊天讨论或等待重试。';
  } else if (blocksPrivateSpeech) {
    dom.turnHint.textContent = `你当前${viewer?.condition?.label || '意识中断'}，无法交互、说话或获取外界信息；需要外界唤醒/救助。`;
    dom.turnClock.textContent = '意识中断';
    dom.composerInput.placeholder = '意识中断，暂时无法说话或行动。';
  } else if (isPaused) {
    dom.turnClock.textContent = '暂停';
    if (turn.pauseKind === 'no-response') {
      dom.turnHint.textContent = `本回合没有真人玩家提交行动，已强制暂停避免空转；输入行动并提交即可继续倒计时${inquiryCue}。`;
      dom.composerInput.placeholder = privateMode ? '可先询问 GM、说话，或写下你的私下行动来继续本回合。' : '可先询问 GM，或写下你的行动来继续本回合。';
    } else if (turn.pauseKind === 'bot-only') {
      dom.turnHint.textContent = '回合已暂停：当前可行动角色里没有真人玩家，避免只由 LLM Bot 自动推进。';
      dom.composerInput.placeholder = privateMode ? '可说话复盘；需要真人角色恢复可行动或由房主中止/重开。' : '可聊天复盘；需要真人角色恢复可行动或由房主中止/重开。';
    } else if (turn.pauseKind === 'no-able-players') {
      dom.turnHint.textContent = '冒险已暂停：所有角色当前都无法行动。';
      dom.composerInput.placeholder = privateMode ? '可说话复盘；等待救助机会或由房主中止/重开。' : '可聊天复盘；等待救助机会或由房主中止/重开。';
    } else {
      const missing = turn.missingUserNames?.length ? turn.missingUserNames.join('、') : (turn.pauseReason || '真人玩家');
      dom.turnHint.textContent = `回合已暂停，等待 ${missing} 返回后继续倒计时。`;
      dom.composerInput.placeholder = privateMode ? '回合暂停中，可以说话；同空间角色才会听见。' : '回合暂停中，可以发送聊天。';
    }
  } else if (turn && !viewerCanAct) {
    dom.turnHint.textContent = privateMode
      ? `你当前${viewer?.condition?.label || '无法行动'}，不能行动，但仍可说话。`
      : `你当前${viewer?.condition?.label || '无法行动'}，不能提交行动，但仍可聊天。`;
    dom.composerInput.placeholder = privateMode ? '你现在无法行动；可以说话（同空间可听）或等待局势改变。' : '你现在无法行动；可以发送聊天或等待同伴/剧情改变状态。';
  } else if (submitted) {
    const pending = turn.pendingCount ?? turn.pendingUserIds?.length ?? 0;
    dom.turnHint.textContent = canWithdraw
      ? `你已提交行动。等待 ${pending} 名玩家；LLM 结算前可撤回修改。`
      : `你已提交行动。等待 ${pending} 名玩家，或倒计时结束。`;
    dom.composerInput.placeholder = privateMode ? '已提交行动；也可以说话，只有同空间角色能听见。' : '已提交行动；也可以发送聊天。';
  } else if (turn) {
    dom.turnHint.textContent = `第 ${turn.turn} 回合：请开始行动${inquiryCue}。`;
    dom.composerInput.placeholder = privateMode
      ? '输入你要说的话、询问 GM，或私下行动'
      : '输入本回合行动，或先询问 GM';
  }

  updateProgress();
}

function startProgressLoop() {
  if (state.progressTimer) return;
  state.progressTimer = setInterval(updateProgress, 250);
}

function stopProgressLoop() {
  if (state.progressTimer) clearInterval(state.progressTimer);
  state.progressTimer = null;
}

function updateProgress() {
  const room = state.currentRoom;
  const turn = room?.currentTurn;
  if (!room || room.status !== 'playing' || !turn) {
    dom.progressTrack.classList.add('hidden');
    return;
  }
  dom.progressTrack.classList.remove('hidden');
  dom.progressTrack.classList.toggle('resolving', Boolean(turn.resolving));
  dom.progressTrack.classList.toggle('paused', Boolean(turn.paused));
  dom.progressTrack.classList.toggle('error', Boolean(turn.llmError));

  if (turn.paused) {
    const total = Math.max(1, Number(turn.totalMs || 180000));
    const remaining = Math.max(0, Number(turn.remainingMs || total));
    const percent = Math.max(0, Math.min(100, (remaining / total) * 100));
    dom.progressFill.style.width = `${percent}%`;
    dom.turnClock.textContent = turn.llmError ? '失败' : '暂停';
    return;
  }

  if (turn.resolving) {
    dom.progressFill.style.width = '100%';
    dom.turnClock.textContent = '结算中';
    return;
  }

  const startedAt = Number(turn.startedAt || Date.now());
  const deadline = Number(turn.deadline || Date.now());
  const total = Math.max(1, deadline - startedAt);
  const remaining = Math.max(0, deadline - Date.now());
  const percent = Math.max(0, Math.min(100, (remaining / total) * 100));
  dom.progressFill.style.width = `${percent}%`;
  dom.turnClock.textContent = formatMs(remaining);
}

async function submitAuth(event) {
  event.preventDefault();
  dom.authSubmit.disabled = true;
  try {
    const payload = await api(`/api/${state.authMode}`, {
      method: 'POST',
      body: {
        username: dom.usernameInput.value,
        password: dom.passwordInput.value,
      },
    });
    state.me = payload.user;
    showApp();
    connectSocket();
    showToast(state.authMode === 'login' ? '欢迎回来。' : '账号已创建。', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    dom.authSubmit.disabled = false;
  }
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    // Ignore stale sessions.
  }
  showAuth();
}

async function createRoom(event) {
  event.preventDefault();
  try {
    const response = await emitAck('room:create', { name: dom.roomNameInput.value.trim() });
    state.currentRoom = response.room;
    dom.roomNameInput.value = '';
    showGame();
    showToast('房间已创建。', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function addBot() {
  if (!state.currentRoom) return;
  const name = prompt('给 LLM Bot 队友取个名字（可留空）：', 'LLM队友');
  if (name === null) return;
  dom.addBotButton.disabled = true;
  try {
    await emitAck('room:bot:add', { roomId: state.currentRoom.id, name: name.trim() });
    showToast('LLM Bot 队友已加入。', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    dom.addBotButton.disabled = false;
  }
}

async function retryLlm() {
  if (!state.currentRoom) return;
  dom.retryLlmButton.disabled = true;
  try {
    await emitAck('llm:retry', { roomId: state.currentRoom.id }, 90000);
    showToast('已开始重试 LLM。', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    dom.retryLlmButton.disabled = false;
  }
}

async function submitStartSetup(event) {
  event.preventDefault();
  if (!state.currentRoom) return;
  const setup = readStartSetupPayload();
  if (setup.mode === 'brief' && !setup.brief) return showToast('请填写一句话冒险描述。', 'error');
  if (setup.mode === 'detailed' && !Object.values(setup.details || {}).some(Boolean)) return showToast('请至少填写一个详细设定参数。', 'error');

  closeStartSetupModal();
  dom.confirmStartSetupButton.disabled = true;
  dom.startGameButton.disabled = true;
  try {
    showToast('LLM 正在生成开局，请稍候……');
    const response = await emitAck('room:start', { roomId: state.currentRoom.id, setup }, 90000);
    if (response.room) state.currentRoom = response.room;
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    dom.confirmStartSetupButton.disabled = false;
    dom.startGameButton.disabled = false;
  }
}

function startGame() {
  openStartSetupModal();
}

async function endAdventure() {
  if (!state.currentRoom) return;
  if (!confirm(`确定中止「${state.currentRoom.name}」当前冒险吗？房间不会删除，之后可重新开始。`)) return;
  dom.endAdventureButton.disabled = true;
  try {
    const response = await emitAck('room:end', { roomId: state.currentRoom.id });
    if (response.room) state.currentRoom = response.room;
    if (state.view === 'game') renderGame();
    showToast('冒险已中止，房间仍保留。', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    dom.endAdventureButton.disabled = false;
  }
}

async function deleteCurrentRoom() {
  if (!state.currentRoom) return;
  if (!confirm(`确定永久删除「${state.currentRoom.name}」吗？此操作不可恢复。`)) return;
  try {
    await emitAck('room:delete', { roomId: state.currentRoom.id });
    state.currentRoom = null;
    showLobby();
    showToast('冒险桌已删除。', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function leaveRoom() {
  if (!state.currentRoom) return;
  const roomStatus = state.currentRoom.status;
  if (roomStatus === 'playing' && !confirm('正在冒险中，确定要离开房间吗？')) return;
  try {
    await emitAck('room:leave');
    state.currentRoom = null;
    showLobby();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function withdrawAction() {
  if (!state.currentRoom) return;
  const turnNumber = Number(state.currentRoom.currentTurn?.turn || 0);
  const withdrawnText = [...(state.currentRoom.messages || [])]
    .reverse()
    .find((message) => message.type === 'action' && message.userId === state.me?.id && Number(message.turn) === turnNumber)
    ?.text || '';

  dom.submitActionButton.disabled = true;
  try {
    const response = await emitAck('turn:withdraw', { roomId: state.currentRoom.id });
    if (response.room) {
      state.currentRoom = response.room;
      if (state.view === 'game') renderGame();
    }
    if (!dom.composerInput.value.trim() && withdrawnText) dom.composerInput.value = withdrawnText;
    showToast('已撤回行动，可修改后重新提交。', 'success');
    dom.composerInput.focus();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    dom.submitActionButton.disabled = false;
  }
}

async function submitAction() {
  const turn = state.currentRoom?.currentTurn;
  if (turn?.viewerSubmitted) {
    if (turn.viewerCanWithdraw) return withdrawAction();
    return showToast('行动已提交，当前无法撤回。', 'error');
  }
  const text = dom.composerInput.value.trim();
  if (!text) return showToast('先写下你的行动。', 'error');
  try {
    await emitAck('turn:action', { roomId: state.currentRoom?.id, text });
    dom.composerInput.value = '';
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function sendChat() {
  const text = dom.composerInput.value.trim();
  if (!text) return showToast('先输入聊天内容。', 'error');
  try {
    await emitAck('chat:send', { roomId: state.currentRoom?.id, text });
    dom.composerInput.value = '';
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function askGm() {
  const text = dom.composerInput.value.trim();
  if (!text) return showToast('先输入想询问 GM 的问题。', 'error');
  if (state.gmInquiryPending) return;
  state.gmInquiryPending = true;
  dom.askGmButton.disabled = true;
  dom.askGmButton.textContent = '询问';
  try {
    await emitAck('gm:ask', { roomId: state.currentRoom?.id, question: text }, 140000);
    dom.composerInput.value = '';
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    state.gmInquiryPending = false;
    if (state.currentRoom && state.view === 'game') renderGame();
  }
}

function bindEvents() {
  renderQuickEmojiList();
  dom.loginTab.addEventListener('click', () => setAuthMode('login'));
  dom.registerTab.addEventListener('click', () => setAuthMode('register'));
  dom.authForm.addEventListener('submit', submitAuth);
  dom.logoutButton.addEventListener('click', logout);
  dom.createRoomForm.addEventListener('submit', createRoom);
  dom.toLobbyButton.addEventListener('click', showLobby);
  dom.backToLobbyButton.addEventListener('click', showLobby);
  dom.currentRoomPill.addEventListener('click', showGame);
  dom.resumeRoomButton.addEventListener('click', showGame);
  dom.openLeftDrawerButton.addEventListener('click', () => openDrawer('left'));
  dom.openRightDrawerButton.addEventListener('click', () => openDrawer('right'));
  dom.closeLeftDrawerButton.addEventListener('click', closeDrawers);
  dom.closeRightDrawerButton.addEventListener('click', closeDrawers);
  dom.drawerOverlay.addEventListener('click', closeDrawers);
  dom.closeStartSetupButton.addEventListener('click', closeStartSetupModal);
  dom.cancelStartSetupButton.addEventListener('click', closeStartSetupModal);
  dom.startSetupModal.addEventListener('click', (event) => {
    if (event.target === dom.startSetupModal) closeStartSetupModal();
  });
  dom.startSetupForm.addEventListener('submit', submitStartSetup);
  for (const button of dom.setupOptionButtons) {
    button.addEventListener('click', () => setSetupMode(button.dataset.setupMode));
  }
  for (const button of dom.playModeOptionButtons) {
    button.addEventListener('click', () => setPlayMode(button.dataset.playMode));
  }
  dom.newMessagesButton.addEventListener('click', scrollMessagesToBottom);
  dom.messageList.addEventListener('scroll', () => {
    if (isNearMessageBottom()) {
      state.unseenMessages = 0;
      updateNewMessagesButton();
    } else {
      updateNewMessagesButton();
    }
  });
  dom.addBotButton.addEventListener('click', addBot);
  dom.retryLlmButton.addEventListener('click', retryLlm);
  dom.startGameButton.addEventListener('click', startGame);
  dom.endAdventureButton.addEventListener('click', endAdventure);
  dom.deleteRoomButton.addEventListener('click', deleteCurrentRoom);
  dom.leaveRoomButton.addEventListener('click', leaveRoom);
  dom.emojiPickerButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setEmojiPickerOpen(!state.emojiPickerOpen);
  });
  dom.closeEmojiPickerButton.addEventListener('click', (event) => {
    event.stopPropagation();
    closeEmojiPicker();
    dom.composerInput.focus();
  });
  dom.emojiPickerPopover.addEventListener('click', (event) => event.stopPropagation());
  dom.quickEmojiList.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-emoji]') : null;
    if (!button) return;
    insertEmojiIntoComposer(button.dataset.emoji);
    closeEmojiPicker();
  });
  dom.emojiPicker.addEventListener('emoji-click', (event) => {
    const emoji = event.detail?.unicode || event.detail?.emoji?.unicode || event.detail?.emoji?.emoji || event.detail?.emoji?.native || '';
    insertEmojiIntoComposer(emoji);
    closeEmojiPicker();
  });
  dom.askGmButton.addEventListener('click', askGm);
  dom.submitActionButton.addEventListener('click', submitAction);
  dom.sendChatButton.addEventListener('click', sendChat);
  dom.composerInput.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submitAction();
    }
  });
  document.addEventListener('click', (event) => {
    if (!state.emojiPickerOpen) return;
    if (dom.emojiPickerButton.contains(event.target) || dom.emojiPickerPopover.contains(event.target)) return;
    closeEmojiPicker();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeStartSetupModal();
      closeEmojiPicker();
    }
  });
  document.addEventListener('visibilitychange', updateProgress);
}

async function boot() {
  bindEvents();
  setAuthMode('login');
  setSetupMode('random');
  setPlayMode('cooperative');
  try {
    const { user } = await api('/api/me');
    if (user) {
      state.me = user;
      showApp();
      connectSocket();
    } else {
      showAuth();
    }
  } catch {
    showAuth();
  }
}

boot();
