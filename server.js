import 'dotenv/config';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { Server } from 'socket.io';

import { createUser, findUserById, findUserByUsername } from './src/store.js';
import { generateBotAction, generateBotChatReply, generateGameSetup, generateTurnNarration, getTurnTimeoutMs } from './src/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = 8;
const MAX_ROOMS = 80;
const MAX_MESSAGES_PER_ROOM = 220;
const MAX_BOTS_PER_ROOM = 4;
const MAX_BOT_CHAT_RESPONSES_PER_MESSAGE = 2;
const MAX_BOT_CHAT_CHAIN_DEPTH = 2;
const BOT_CHAT_COOLDOWN_MS = 12000;
const BOT_CHAT_RESPONSE_DELAY_MS = 700;
const ROOMS_FILE = path.resolve('data', 'rooms.json');
const USERNAME_RE = /^[\p{L}\p{N}_-]{3,20}$/u;
const DEFAULT_STATS = {
  hp: { label: '生命值', value: 10, max: 10 },
  stamina: { label: '体力', value: 10, max: 10 },
};
const SHOCK_STATUS_RE = /(休克|昏迷|晕倒|无意识|失去意识|沉睡)/;
const EXHAUSTION_STATUS_RE = /(力竭|体力耗尽|精疲力尽|脱力|虚脱)/;
const INJURY_STATUS_RE = /(受伤|重伤|轻伤|流血|出血|骨折|内伤|创伤|伤口|烧伤|冻伤|中毒|感染|濒死)/;
const DISABLING_STATUS_RE = /(休克|昏迷|晕倒|无意识|失去意识|无法行动|瘫痪|石化|沉睡|眩晕|麻痹)/;
const RESUMABLE_PAUSE_KINDS = new Set(['missing', 'no-human']);
const GAME_MODE_LABELS = {
  cooperative: '合作模式',
  independent: '独立模式',
  pvp: 'PVP 模式',
};
const PRIVATE_INFO_MODES = new Set(['independent', 'pvp']);
const DEFAULT_LOCATION = { id: 'together', label: '同一地点' };

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
});

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  name: 'magol.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 14,
  },
});

app.use(express.json({ limit: '32kb' }));
app.use(sessionMiddleware);

const rooms = new Map();
const userRooms = new Map();
const userSockets = new Map();
const botChatJobs = new Set();

function publicUser(user) {
  return user ? { id: user.id, username: user.username } : null;
}

function normalizeUsername(username) {
  return String(username || '').trim();
}

function validateCredentials(username, password) {
  const cleanUsername = normalizeUsername(username);
  const cleanPassword = String(password || '');
  if (!USERNAME_RE.test(cleanUsername)) {
    return { error: '用户名需为 3-20 位，可包含中文、字母、数字、下划线或短横线。' };
  }
  if (cleanPassword.length < 6 || cleanPassword.length > 72) {
    return { error: '密码需为 6-72 位。' };
  }
  return { username: cleanUsername, password: cleanPassword };
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录。' });
  const user = findUserById(req.session.user.id);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: '登录已失效。' });
  }
  req.user = user;
  next();
}

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const user = findUserById(req.session.user.id);
  if (!user) return res.json({ user: null });
  res.json({ user: publicUser(user) });
});

app.post('/api/register', (req, res) => {
  const validation = validateCredentials(req.body?.username, req.body?.password);
  if (validation.error) return res.status(400).json({ error: validation.error });
  if (findUserByUsername(validation.username)) return res.status(409).json({ error: '用户名已被注册。' });

  const passwordHash = bcrypt.hashSync(validation.password, 12);
  const user = createUser({ id: crypto.randomUUID(), username: validation.username, passwordHash });
  req.session.user = publicUser(user);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = String(req.body?.password || '');
  const user = findUserByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: '用户名或密码错误。' });
  }
  req.session.user = publicUser(user);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

function nowIso() {
  return new Date().toISOString();
}

function roomPublicId() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function trimText(input, maxLength) {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function clampNumber(value, fallback = 0, min = 0, max = 9999) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeStateText(input, maxLength = 120) {
  const text = String(input || '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeGameMode(input) {
  const mode = String(input || 'cooperative').trim().toLowerCase();
  if (['independent', 'solo', 'realistic'].includes(mode)) return 'independent';
  if (['pvp', 'versus', 'competitive', 'competition'].includes(mode)) return 'pvp';
  return 'cooperative';
}

function gameModeLabel(mode) {
  return GAME_MODE_LABELS[normalizeGameMode(mode)] || GAME_MODE_LABELS.cooperative;
}

function normalizeLocationId(input, fallback = DEFAULT_LOCATION.id) {
  const text = normalizeStateText(input || fallback, 60).toLowerCase();
  return text.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || fallback;
}

function normalizeLocation(input, fallback = DEFAULT_LOCATION) {
  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_LOCATION;
  if (typeof input === 'string') {
    const label = normalizeStateText(input, 60) || base.label || DEFAULT_LOCATION.label;
    return { id: normalizeLocationId(label, base.id || DEFAULT_LOCATION.id), label };
  }
  if (input && typeof input === 'object') {
    const label = normalizeStateText(input.label || input.name || input.title || input.spaceLabel, 60) || base.label || DEFAULT_LOCATION.label;
    return {
      id: normalizeLocationId(input.id || input.key || input.spaceId || label, base.id || DEFAULT_LOCATION.id),
      label,
    };
  }
  return { id: base.id || DEFAULT_LOCATION.id, label: base.label || DEFAULT_LOCATION.label };
}

function isPrivateInfoMode(roomOrMode) {
  const mode = typeof roomOrMode === 'string'
    ? roomOrMode
    : roomOrMode?.game?.playMode || roomOrMode?.playMode || 'cooperative';
  return PRIVATE_INFO_MODES.has(normalizeGameMode(mode));
}

function normalizeSetupOptions(input = {}) {
  const mode = ['brief', 'detailed'].includes(input?.mode) ? input.mode : 'random';
  const playMode = normalizeGameMode(input?.playMode || input?.gameMode || input?.adventureMode);
  if (mode === 'brief') {
    const brief = normalizeStateText(input.brief || input.prompt || input.description, 260);
    if (!brief) throw new Error('请填写一句话冒险描述。');
    return { mode, playMode, brief };
  }
  if (mode === 'detailed') {
    const rawDetails = input.details && typeof input.details === 'object' ? input.details : input;
    const details = {
      title: normalizeStateText(rawDetails.title, 90),
      genre: normalizeStateText(rawDetails.genre, 140),
      setting: normalizeStateText(rawDetails.setting, 1200),
      goal: normalizeStateText(rawDetails.goal, 500),
      tone: normalizeStateText(rawDetails.tone, 180),
      difficulty: normalizeStateText(rawDetails.difficulty, 120),
      characters: normalizeStateText(rawDetails.characters, 260),
      rules: normalizeStateText(rawDetails.rules, 360),
    };
    if (!Object.values(details).some(Boolean)) throw new Error('请至少填写一个详细设定参数。');
    return { mode, playMode, details };
  }
  return { mode: 'random', playMode };
}

function setupModeLabel(options) {
  if (options?.mode === 'brief') return '一句话描述生成';
  if (options?.mode === 'detailed') return '详细设定参数';
  return '全随机生成';
}

function normalizeStatKey(key) {
  const raw = String(key || '').trim();
  const aliases = {
    health: 'hp',
    life: 'hp',
    '生命值': 'hp',
    '生命': 'hp',
    hp: 'hp',
    stamina: 'stamina',
    energy: 'stamina',
    '体力': 'stamina',
    '精力': 'stamina',
  };
  const lower = raw.toLowerCase();
  if (aliases[lower]) return aliases[lower];
  if (aliases[raw]) return aliases[raw];
  return lower.replace(/[^a-z0-9_-]/g, '_').slice(0, 32) || 'custom';
}

function defaultStats() {
  return JSON.parse(JSON.stringify(DEFAULT_STATS));
}

function normalizeStats(input, fallback = defaultStats()) {
  const stats = JSON.parse(JSON.stringify(fallback || DEFAULT_STATS));
  const source = input && typeof input === 'object' ? input : {};

  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = normalizeStatKey(rawKey);
    const defaultLabel = key === 'hp' ? '生命值' : key === 'stamina' ? '体力' : rawKey;

    if (typeof rawValue === 'number') {
      const value = clampNumber(rawValue, 0);
      stats[key] = { label: normalizeStateText(defaultLabel, 32), value, max: Math.max(value, 1) };
      continue;
    }

    if (rawValue && typeof rawValue === 'object') {
      const max = clampNumber(rawValue.max ?? rawValue.maximum ?? rawValue.value ?? 10, 10, 1);
      const value = clampNumber(rawValue.value ?? rawValue.current ?? max, max, 0, max);
      stats[key] = {
        label: normalizeStateText(rawValue.label || rawValue.name || defaultLabel, 32),
        value,
        max,
      };
    }
  }

  for (const [key, stat] of Object.entries(DEFAULT_STATS)) {
    if (!stats[key]) stats[key] = { ...stat };
  }
  return stats;
}

function normalizeInventory(items) {
  if (!Array.isArray(items)) return [];
  return [...new Set(items.map((item) => normalizeStateText(item, 80)).filter(Boolean))].slice(0, 24);
}

function normalizeStatusTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((tag) => normalizeStateText(tag, 24)).filter(Boolean))].slice(0, 12);
}

function addStatusTag(player, tag) {
  const clean = normalizeStateText(tag, 24);
  if (!clean) return false;
  player.statusTags = normalizeStatusTags(player.statusTags);
  if (player.statusTags.includes(clean)) return false;
  player.statusTags.push(clean);
  return true;
}

function removeStatusTag(player, tag) {
  const clean = normalizeStateText(tag, 24);
  if (!clean) return false;
  const before = player.statusTags?.length || 0;
  player.statusTags = normalizeStatusTags(player.statusTags).filter((item) => item !== clean);
  return player.statusTags.length !== before;
}

function hasStatusMatching(player, pattern) {
  return normalizeStatusTags(player?.statusTags).some((tag) => pattern.test(tag));
}

function hasShockStatus(player) {
  return hasStatusMatching(player, SHOCK_STATUS_RE);
}

function hasExhaustionStatus(player) {
  return hasStatusMatching(player, EXHAUSTION_STATUS_RE);
}

function hasInjuryStatus(player) {
  return hasStatusMatching(player, INJURY_STATUS_RE);
}

function applyVitalsRules(player) {
  player.stats = normalizeStats(player.stats);
  player.statusTags = normalizeStatusTags(player.statusTags);
  player.inventory = normalizeInventory(player.inventory);

  const hp = player.stats.hp?.value ?? 0;
  const stamina = player.stats.stamina?.value ?? 0;
  if (hp <= 0) addStatusTag(player, '死亡');
  else removeStatusTag(player, '死亡');

  if (hp > 0 && stamina <= 0) addStatusTag(player, '力竭');
  else if (stamina > 0) {
    for (const tag of normalizeStatusTags(player.statusTags)) {
      if (EXHAUSTION_STATUS_RE.test(tag)) removeStatusTag(player, tag);
    }
  }

  return player;
}

function getPlayerCondition(player) {
  applyVitalsRules(player);
  const hp = player.stats.hp?.value ?? 0;
  const stamina = player.stats.stamina?.value ?? 0;
  if (hp <= 0 || player.statusTags.includes('死亡')) {
    return { state: 'dead', label: '死亡', reason: '生命值耗尽', canAct: false, canPerceive: false };
  }

  const shockTag = player.statusTags.find((tag) => SHOCK_STATUS_RE.test(tag));
  if (shockTag) {
    return { state: shockTag.includes('休克') ? 'shock' : 'unconscious', label: shockTag, reason: `状态：${shockTag}`, canAct: false, canPerceive: false };
  }

  if (stamina <= 0 || hasExhaustionStatus(player)) {
    return { state: 'exhausted', label: '力竭', reason: '体力耗尽', canAct: false, canPerceive: true };
  }

  const disablingTag = player.statusTags.find((tag) => DISABLING_STATUS_RE.test(tag));
  if (disablingTag) {
    return { state: 'disabled', label: disablingTag, reason: `状态：${disablingTag}`, canAct: false, canPerceive: true };
  }
  return { state: 'active', label: '可行动', reason: '', canAct: true, canPerceive: true };
}

function canPlayerAct(player) {
  return getPlayerCondition(player).canAct;
}

function canPlayerPerceive(player) {
  return getPlayerCondition(player).canPerceive !== false;
}

function activeUserIds(room) {
  return [...room.players.values()].filter((player) => canPlayerAct(player)).map((player) => player.id);
}

function makePlayerRecord(user) {
  return applyVitalsRules({
    id: user.id,
    username: user.username,
    joinedAt: nowIso(),
    isBot: false,
    role: '',
    personalGoal: '',
    inventory: [],
    statusTags: ['清醒'],
    stats: defaultStats(),
    location: normalizeLocation(),
  });
}

function isBotId(id) {
  return String(id || '').startsWith('bot:');
}

function makeBotRecord(room, requestedName = '') {
  const existingNames = new Set([...room.players.values()].map((player) => player.username));
  const base = normalizeStateText(requestedName, 20) || 'LLM队友';
  let username = base;
  let index = 1;
  while (existingNames.has(username)) {
    index += 1;
    username = `${base}${index}`;
  }

  return applyVitalsRules({
    id: `bot:${crypto.randomUUID()}`,
    username,
    joinedAt: nowIso(),
    isBot: true,
    role: '等待 LLM 生成角色',
    personalGoal: '',
    inventory: [],
    statusTags: ['清醒', 'Bot'],
    stats: defaultStats(),
    location: normalizeLocation(),
  });
}

function appendMessage(room, type, text, extra = {}) {
  const safeExtra = { ...extra };
  if (Array.isArray(safeExtra.recipients)) {
    safeExtra.recipients = [...new Set(safeExtra.recipients.map((id) => String(id || '')).filter((id) => room.players?.has(id)))];
    if (!safeExtra.recipients.length) delete safeExtra.recipients;
  }
  const message = {
    id: crypto.randomUUID(),
    type,
    text: String(text || ''),
    createdAt: nowIso(),
    ...safeExtra,
  };
  room.messages.push(message);
  if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
    room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM);
  }
  return message;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

function summarizeStateChange(change) {
  if (!change) return '';
  if (change.kind === 'stat') return `${change.label} ${change.before}→${change.after}`;
  if (change.kind === 'inventory') return `${change.action === 'add' ? '+物品' : '-物品'} ${change.items.join('、')}`;
  if (change.kind === 'status') return `${change.action === 'add' ? '+状态' : '-状态'} ${change.tags.join('、')}`;
  if (change.kind === 'location') return `位置 ${change.beforeLabel || '未知'}→${change.afterLabel}`;
  return change.summary || '';
}

function setCharacterStat(player, rawKey, rawValue) {
  const key = normalizeStatKey(rawKey);
  const previous = player.stats?.[key] || { label: key, value: 0, max: 10 };
  let next;

  if (typeof rawValue === 'number') {
    const max = Math.max(previous.max || 1, rawValue, 1);
    next = { label: previous.label || key, value: clampNumber(rawValue, previous.value || 0, 0, max), max };
  } else if (rawValue && typeof rawValue === 'object') {
    const max = clampNumber(rawValue.max ?? rawValue.maximum ?? previous.max ?? rawValue.value ?? 10, previous.max || 10, 1);
    const value = clampNumber(rawValue.value ?? rawValue.current ?? previous.value ?? max, previous.value || max, 0, max);
    next = {
      label: normalizeStateText(rawValue.label || rawValue.name || previous.label || rawKey, 32),
      value,
      max,
    };
  } else {
    return null;
  }

  player.stats[key] = next;
  return {
    kind: 'stat',
    key,
    label: next.label,
    before: previous.value ?? 0,
    after: next.value,
    max: next.max,
    delta: next.value - (previous.value ?? 0),
  };
}

function deltaCharacterStat(player, rawKey, rawDelta) {
  const delta = Number(rawDelta);
  if (!Number.isFinite(delta) || delta === 0) return null;
  const key = normalizeStatKey(rawKey);
  const previous = player.stats?.[key] || {
    label: key === 'hp' ? '生命值' : key === 'stamina' ? '体力' : rawKey,
    value: 0,
    max: Math.max(Math.abs(delta), 10),
  };
  const max = Math.max(previous.max || 1, 1);
  const value = clampNumber((previous.value || 0) + delta, previous.value || 0, 0, max);
  player.stats[key] = { ...previous, value, max };
  return {
    kind: 'stat',
    key,
    label: previous.label || key,
    before: previous.value ?? 0,
    after: value,
    max,
    delta: value - (previous.value ?? 0),
  };
}

function removeInventoryItems(player, items) {
  const removeSet = new Set(asArray(items).map((item) => normalizeStateText(item, 80)).filter(Boolean));
  if (!removeSet.size) return [];
  const removed = [];
  player.inventory = normalizeInventory(player.inventory).filter((item) => {
    if (removeSet.has(item)) {
      removed.push(item);
      return false;
    }
    return true;
  });
  return removed;
}

function canNaturallyRecoverStamina(player) {
  applyVitalsRules(player);
  const hp = player.stats.hp?.value ?? 0;
  const stamina = player.stats.stamina?.value ?? 0;
  if (hp <= 0 || stamina > 0) return false;
  if (hasShockStatus(player) || hasInjuryStatus(player)) return false;
  const hardDisablingTag = normalizeStatusTags(player.statusTags)
    .find((tag) => DISABLING_STATUS_RE.test(tag) && !EXHAUSTION_STATUS_RE.test(tag));
  return !hardDisablingTag;
}

function applyNaturalStaminaRecovery(room) {
  if (!room?.players?.size) return [];
  const events = [];

  for (const player of room.players.values()) {
    if (!canNaturallyRecoverStamina(player)) continue;

    const previous = player.stats.stamina || { label: '体力', value: 0, max: 10 };
    const max = Math.max(1, previous.max || 10);
    const before = clampNumber(previous.value, 0, 0, max);
    const recovery = Math.max(1, Math.ceil(max * 0.2));
    const after = clampNumber(before + recovery, Math.min(recovery, max), 0, max);
    if (after <= before) continue;

    player.stats.stamina = { ...previous, label: previous.label || '体力', value: after, max };
    const changes = [{
      kind: 'stat',
      key: 'stamina',
      label: player.stats.stamina.label,
      before,
      after,
      max,
      delta: after - before,
    }];

    const removedTags = [];
    for (const tag of normalizeStatusTags(player.statusTags)) {
      if (EXHAUSTION_STATUS_RE.test(tag) && removeStatusTag(player, tag)) removedTags.push(tag);
    }
    if (removedTags.length) changes.push({ kind: 'status', action: 'remove', tags: removedTags });

    applyVitalsRules(player);
    events.push({
      userId: player.id,
      username: player.username,
      reason: '单纯力竭后的自然喘息恢复',
      changes,
      summary: `${player.username}：单纯力竭后的自然喘息恢复；${changes.map(summarizeStateChange).filter(Boolean).join('；')}`,
    });
  }

  return events;
}

function applyStoryToolCalls(room, calls = []) {
  if (!Array.isArray(calls) || !calls.length) return [];
  const events = [];

  for (const call of calls.slice(0, 40)) {
    const tool = String(call?.tool || call?.name || 'updateCharacter');
    if (!/updateCharacter|update_character/i.test(tool)) continue;

    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    const username = normalizeStateText(args.username || args.player || args.target, 80);
    const player = [...room.players.values()].find((entry) => entry.username.toLowerCase() === username.toLowerCase());
    if (!player) continue;

    applyVitalsRules(player);
    const changes = [];
    const reason = normalizeStateText(args.reason, 140);

    const statDeltas = args.statsDelta || args.statDeltas || args.deltaStats || args.attributesDelta || {};
    if (statDeltas && typeof statDeltas === 'object') {
      for (const [key, delta] of Object.entries(statDeltas)) {
        const change = deltaCharacterStat(player, key, delta);
        if (change) changes.push(change);
      }
    }

    const statSets = args.statsSet || args.setStats || args.attributesSet || {};
    if (statSets && typeof statSets === 'object') {
      for (const [key, value] of Object.entries(statSets)) {
        const change = setCharacterStat(player, key, value);
        if (change) changes.push(change);
      }
    }

    const inventoryAdd = asArray(args.inventoryAdd || args.addItems || args.itemsAdd || args.inventory?.add)
      .map((item) => normalizeStateText(item, 80))
      .filter(Boolean);
    for (const item of inventoryAdd) {
      player.inventory = normalizeInventory([...(player.inventory || []), item]);
    }
    if (inventoryAdd.length) changes.push({ kind: 'inventory', action: 'add', items: inventoryAdd });

    const inventoryRemoved = removeInventoryItems(player, args.inventoryRemove || args.removeItems || args.itemsRemove || args.inventory?.remove);
    if (inventoryRemoved.length) changes.push({ kind: 'inventory', action: 'remove', items: inventoryRemoved });

    const statusAdd = asArray(args.statusAdd || args.addStatusTags || args.statusTagsAdd || args.statusTags?.add)
      .map((tag) => normalizeStateText(tag, 24))
      .filter(Boolean);
    const addedTags = [];
    for (const tag of statusAdd) {
      if (addStatusTag(player, tag)) addedTags.push(tag);
    }
    if (addedTags.length) changes.push({ kind: 'status', action: 'add', tags: addedTags });

    const statusRemove = asArray(args.statusRemove || args.removeStatusTags || args.statusTagsRemove || args.statusTags?.remove)
      .map((tag) => normalizeStateText(tag, 24))
      .filter(Boolean);
    const removedTags = [];
    for (const tag of statusRemove) {
      if (removeStatusTag(player, tag)) removedTags.push(tag);
    }
    if (removedTags.length) changes.push({ kind: 'status', action: 'remove', tags: removedTags });

    const rawLocation = args.location || args.locationSet || args.moveTo || args.space || args.spaceSet;
    if (rawLocation) {
      const before = normalizeLocation(player.location);
      const after = normalizeLocation(rawLocation, before);
      if (after.id !== before.id || after.label !== before.label) {
        player.location = after;
        changes.push({
          kind: 'location',
          beforeId: before.id,
          beforeLabel: before.label,
          afterId: after.id,
          afterLabel: after.label,
        });
      }
    }

    applyVitalsRules(player);
    if (changes.length) {
      const summary = `${player.username}：${reason ? `${reason}；` : ''}${changes.map(summarizeStateChange).filter(Boolean).join('；')}`;
      events.push({
        userId: player.id,
        username: player.username,
        reason,
        changes,
        summary,
      });
    }
  }

  return events;
}

function socketRoom(roomId) {
  return `room:${roomId}`;
}

function isOnline(userId) {
  if (isBotId(userId)) return true;
  return (userSockets.get(userId)?.size || 0) > 0;
}

function isUserPresentInRoom(userId, roomId) {
  if (isBotId(userId)) return true;
  return userRooms.get(userId) === roomId && isOnline(userId);
}

function presentUserIds(room) {
  return [...room.players.keys()].filter((userId) => isUserPresentInRoom(userId, room.id));
}

function presentHumanUserIds(room) {
  return [...room.players.values()].filter((player) => !player.isBot && isUserPresentInRoom(player.id, room.id)).map((player) => player.id);
}

function playerLocationKey(player) {
  return normalizeLocation(player?.location).id;
}

function playerLocationLabel(player) {
  return normalizeLocation(player?.location).label;
}

function arePlayersInSameSpace(room, firstId, secondId) {
  const first = room.players.get(firstId);
  const second = room.players.get(secondId);
  if (!first || !second) return false;
  return playerLocationKey(first) === playerLocationKey(second);
}

function locationGroups(room) {
  const groups = new Map();
  for (const player of room.players.values()) {
    const location = normalizeLocation(player.location);
    if (!groups.has(location.id)) groups.set(location.id, { id: location.id, label: location.label, players: [] });
    groups.get(location.id).players.push({ id: player.id, username: player.username, isBot: Boolean(player.isBot) });
  }
  return [...groups.values()];
}

function audibleUserIds(room, speakerId, { respectPerception = true } = {}) {
  const speaker = room.players.get(speakerId);
  if (!speaker || (respectPerception && !canPlayerPerceive(speaker))) return [speakerId];
  const key = playerLocationKey(speaker);
  return [...room.players.values()]
    .filter((player) => playerLocationKey(player) === key && (!respectPerception || canPlayerPerceive(player)))
    .map((player) => player.id);
}

function messageVisibleToViewer(message, viewerId) {
  if (!Array.isArray(message?.recipients) || !message.recipients.length) return true;
  return message.recipients.includes(viewerId);
}

function serializeMessageForViewer(message, viewerId) {
  const { recipients, botChatAttemptedResponderIds, ...safe } = message;
  if (Array.isArray(recipients) && recipients.length) {
    safe.isPrivate = recipients.length === 1 && recipients[0] === viewerId;
    safe.isSpatial = safe.type === 'say' && recipients.length > 1;
  }
  return safe;
}

function messagesForViewer(room, viewerId) {
  return (room.messages || [])
    .filter((message) => messageVisibleToViewer(message, viewerId))
    .map((message) => serializeMessageForViewer(message, viewerId));
}

function llmMessageContext(room, message) {
  const audience = Array.isArray(message?.recipients) && message.recipients.length
    ? message.recipients.map((id) => room.players.get(id)?.username).filter(Boolean)
    : [];
  return {
    type: message?.type || 'chat',
    username: message?.username,
    text: message?.text,
    isBot: Boolean(message?.isBot || isBotId(message?.userId)),
    botChatDepth: clampNumber(message?.botChatDepth, 0, 0, MAX_BOT_CHAT_CHAIN_DEPTH),
    audienceUsernames: audience,
    audienceLabel: message?.audienceLabel || message?.visibilityLabel || '',
    locationLabel: message?.location?.label || message?.locationLabel || '',
    privateTo: message?.privateTo || '',
  };
}

function pendingEligibleUserIds(room, eligibleUserIds = room.currentTurn?.eligibleUserIds || activeUserIds(room)) {
  const actions = room.currentTurn?.actions || new Map();
  return eligibleUserIds.filter((id) => room.players.has(id) && canPlayerAct(room.players.get(id)) && !actions.has(id));
}

function eligibleHumanUserIds(room, eligibleUserIds = room.currentTurn?.eligibleUserIds || activeUserIds(room)) {
  return eligibleUserIds.filter((id) => room.players.has(id) && !room.players.get(id)?.isBot);
}

function submittedHumanUserIds(room, turn = room.currentTurn) {
  if (!turn?.actions) return [];
  return [...turn.actions.keys()].filter((id) => room.players.has(id) && !room.players.get(id)?.isBot);
}

function pendingOtherEligibleUserIds(room, userId, turn = room.currentTurn) {
  if (!turn?.actions) return [];
  const eligibleUserIds = (turn.eligibleUserIds || activeUserIds(room))
    .filter((id) => room.players.has(id) && canPlayerAct(room.players.get(id)));
  return eligibleUserIds.filter((id) => id !== userId && !turn.actions.has(id));
}

function canWithdrawTurnAction(room, userId) {
  const turn = room?.currentTurn;
  if (!room || room.status !== 'playing' || !turn || !turn.actions?.has(userId)) return false;
  if (turn.resolving || turn.llmError) return false;
  const player = room.players.get(userId);
  if (!player || player.isBot) return false;
  return pendingOtherEligibleUserIds(room, userId, turn).length > 0;
}

function removeSubmittedActionMessage(room, userId, turn, actionRecord) {
  const messages = room.messages || [];
  const messageId = actionRecord?.messageId || '';
  const actionId = actionRecord?.actionId || '';
  let index = -1;

  if (messageId || actionId) {
    index = messages.findIndex((message) => (
      (messageId && message.id === messageId)
      || (actionId && message.actionId === actionId)
    ));
  }

  if (index < 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.type === 'action' && message.userId === userId && Number(message.turn) === Number(turn.turn) && !message.isBot) {
        index = i;
        break;
      }
    }
  }

  if (index >= 0) {
    messages.splice(index, 1);
    return true;
  }
  return false;
}

function hasPresentHumanPlayer(room) {
  return presentHumanUserIds(room).length > 0;
}

function missingEligibleUsers(room, eligibleUserIds = room.currentTurn?.eligibleUserIds || activeUserIds(room)) {
  return pendingEligibleUserIds(room, eligibleUserIds)
    .filter((id) => !room.players.get(id)?.isBot && !isUserPresentInRoom(id, room.id))
    .map((id) => room.players.get(id)?.username || id);
}

function areEligibleUsersPresent(room, eligibleUserIds = room.currentTurn?.eligibleUserIds || activeUserIds(room)) {
  if (!hasPresentHumanPlayer(room)) return false;
  const pendingHumans = pendingEligibleUserIds(room, eligibleUserIds).filter((id) => !room.players.get(id)?.isBot);
  return pendingHumans.every((id) => isUserPresentInRoom(id, room.id));
}

function serializeLobbyRoom(room) {
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    hostName: room.hostName,
    status: room.status,
    playerCount: room.players.size,
    presentCount: presentUserIds(room).length,
    maxPlayers: room.maxPlayers,
    playerIds: [...room.players.keys()],
    createdAt: room.createdAt,
    title: room.game?.title || '',
    playMode: normalizeGameMode(room.game?.playMode || room.playMode),
    playModeLabel: gameModeLabel(room.game?.playMode || room.playMode),
    turnNumber: room.turnNumber || 0,
  };
}

function serializeRoom(room, viewerId) {
  const playMode = normalizeGameMode(room.game?.playMode || room.playMode);
  const privateMode = isPrivateInfoMode(playMode);
  const viewerPlayer = room.players.get(viewerId);
  const viewerCanPerceive = !privateMode || !viewerPlayer || canPlayerPerceive(viewerPlayer);
  const eligibleUserIds = room.currentTurn?.eligibleUserIds || activeUserIds(room);
  const pendingUserIds = eligibleUserIds.filter((id) => room.players.has(id) && !room.currentTurn?.actions?.has(id));
  const currentTurn = room.currentTurn
    ? {
        turn: room.currentTurn.turn,
        deadline: room.currentTurn.deadline,
        startedAt: room.currentTurn.startedAt,
        resolving: Boolean(room.currentTurn.resolving),
        paused: Boolean(room.currentTurn.paused),
        pauseKind: room.currentTurn.pauseKind || '',
        pauseReason: room.currentTurn.pauseReason || '',
        remainingMs: room.currentTurn.paused
          ? room.currentTurn.remainingMs || getTurnTimeoutMs()
          : Math.max(0, (room.currentTurn.deadline || Date.now()) - Date.now()),
        totalMs: room.currentTurn.totalMs || getTurnTimeoutMs(),
        llmError: room.currentTurn.llmError || null,
        missingUserNames: missingEligibleUsers(room, eligibleUserIds),
        submittedUserIds: privateMode
          ? (room.currentTurn.actions.has(viewerId) ? [viewerId] : [])
          : [...room.currentTurn.actions.keys()],
        eligibleUserIds: privateMode ? eligibleUserIds.filter((id) => id === viewerId) : eligibleUserIds,
        pendingUserIds: privateMode ? [] : pendingUserIds,
        pendingCount: pendingUserIds.length,
        unableUserIds: privateMode
          ? [...room.players.keys()].filter((id) => id === viewerId && !eligibleUserIds.includes(id))
          : [...room.players.keys()].filter((id) => !eligibleUserIds.includes(id)),
        viewerSubmitted: room.currentTurn.actions.has(viewerId),
        viewerCanWithdraw: canWithdrawTurnAction(room, viewerId),
        viewerCanAct: eligibleUserIds.includes(viewerId),
      }
    : null;

  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    hostName: room.hostName,
    status: room.status,
    maxPlayers: room.maxPlayers,
    createdAt: room.createdAt,
    turnNumber: room.turnNumber || 0,
    game: room.game ? { ...room.game, playMode, playModeLabel: gameModeLabel(playMode) } : null,
    playMode,
    playModeLabel: gameModeLabel(playMode),
    isPrivateInfoMode: privateMode,
    llmError: room.llmError || null,
    locationGroups: privateMode
      ? (viewerCanPerceive
          ? locationGroups(room).map((group) => ({
              id: group.id,
              label: group.players.some((player) => player.id === viewerId) ? group.label : '未知空间',
              playerCount: group.players.length,
              viewerHere: group.players.some((player) => player.id === viewerId),
            }))
          : [{ id: 'perception-blocked', label: '感知中断', playerCount: 1, viewerHere: true }])
      : locationGroups(room),
    players: [...room.players.values()].map((player) => {
      const condition = getPlayerCondition(player);
      const isSelf = player.id === viewerId;
      const sameSpace = viewerCanPerceive && arePlayersInSameSpace(room, viewerId, player.id);
      const canReveal = !privateMode || isSelf;
      const location = normalizeLocation(player.location);
      const hiddenBecauseViewerUnconscious = privateMode && !isSelf && !viewerCanPerceive;
      return {
        id: player.id,
        username: player.username,
        isBot: Boolean(player.isBot),
        isSelf,
        sameSpace,
        infoPrivate: privateMode && !isSelf,
        infoNote: privateMode && !isSelf
          ? (hiddenBecauseViewerUnconscious ? '你当前无法感知外界' : (sameSpace ? '同处空间：只能获得可观察信息' : '不同空间：信息未共享'))
          : '',
        online: isOnline(player.id),
        present: isUserPresentInRoom(player.id, room.id),
        role: canReveal ? (player.role || '') : (sameSpace ? '可见身份未知' : '未知角色'),
        personalGoal: canReveal ? (player.personalGoal || '') : '',
        inventory: canReveal ? (player.inventory || []) : [],
        statusTags: canReveal ? (player.statusTags || []) : (sameSpace ? ['可观察'] : ['未知']),
        stats: canReveal ? (player.stats || defaultStats()) : {},
        condition: canReveal ? condition : { state: sameSpace ? 'observed' : 'unknown', label: sameSpace ? '可观察' : '未知', reason: '', canAct: true, canPerceive: true },
        canAct: canReveal ? condition.canAct : true,
        location: canReveal || sameSpace ? location : { id: 'unknown', label: '未知空间' },
        joinedAt: player.joinedAt,
      };
    }),
    messages: messagesForViewer(room, viewerId),
    currentTurn,
  };
}

let saveRoomsTimer = null;

function ensureDataDir() {
  const dir = path.dirname(ROOMS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function serializeTurnForPersistence(turn) {
  if (!turn) return null;
  const totalMs = turn.totalMs || getTurnTimeoutMs();
  const remainingMs = turn.paused
    ? clampNumber(turn.remainingMs, totalMs, 1000, totalMs)
    : clampNumber((turn.deadline || Date.now()) - Date.now(), totalMs, 1000, totalMs);
  return {
    turn: turn.turn,
    startedAt: turn.startedAt,
    deadline: turn.deadline,
    resolving: Boolean(turn.resolving),
    paused: Boolean(turn.paused),
    pauseKind: turn.pauseKind || '',
    pauseReason: turn.pauseReason || '',
    llmError: turn.llmError || null,
    remainingMs,
    totalMs,
    eligibleUserIds: Array.isArray(turn.eligibleUserIds) ? turn.eligibleUserIds : [],
    actions: [...(turn.actions || new Map()).entries()],
  };
}

function serializeRoomForPersistence(room) {
  const status = room.status === 'starting' ? 'waiting' : room.status;
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    hostName: room.hostName,
    status,
    maxPlayers: room.maxPlayers,
    createdAt: room.createdAt,
    players: [...room.players.values()].map((player) => {
      applyVitalsRules(player);
      return {
        id: player.id,
        username: player.username,
        joinedAt: player.joinedAt,
        isBot: Boolean(player.isBot || isBotId(player.id)),
        role: player.role || '',
        personalGoal: player.personalGoal || '',
        inventory: player.inventory || [],
        statusTags: player.statusTags || [],
        stats: player.stats || defaultStats(),
        location: normalizeLocation(player.location),
      };
    }),
    messages: room.messages || [],
    game: room.game || null,
    playMode: normalizeGameMode(room.game?.playMode || room.playMode),
    llmError: room.llmError || null,
    turnNumber: room.turnNumber || 0,
    currentTurn: status === 'playing' ? serializeTurnForPersistence(room.currentTurn) : null,
    persistedAt: nowIso(),
  };
}

function saveRoomsNow() {
  ensureDataDir();
  const payload = [...rooms.values()].map(serializeRoomForPersistence);
  const tempFile = `${ROOMS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2));
  fs.renameSync(tempFile, ROOMS_FILE);
}

function scheduleSaveRooms() {
  clearTimeout(saveRoomsTimer);
  saveRoomsTimer = setTimeout(() => {
    saveRoomsTimer = null;
    try {
      saveRoomsNow();
    } catch (error) {
      console.error('[rooms] failed to persist rooms:', error);
    }
  }, 150);
}

function readPersistedRooms() {
  if (!fs.existsSync(ROOMS_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('[rooms] failed to read persisted rooms:', error);
    return [];
  }
}

function rehydrateTurn(rawTurn, room) {
  if (!rawTurn || room.status !== 'playing') return null;
  const actions = new Map(Array.isArray(rawTurn.actions) ? rawTurn.actions : []);
  const eligibleUserIds = Array.isArray(rawTurn.eligibleUserIds) && rawTurn.eligibleUserIds.length
    ? rawTurn.eligibleUserIds.filter((id) => room.players.has(id) && canPlayerAct(room.players.get(id)))
    : activeUserIds(room);
  if (!eligibleUserIds.length && !rawTurn.paused && !rawTurn.pauseKind) return null;

  const now = Date.now();
  const totalMs = clampNumber(rawTurn.totalMs, getTurnTimeoutMs(), 1000, getTurnTimeoutMs());
  const remainingMs = clampNumber(rawTurn.remainingMs ?? ((rawTurn.deadline || now + totalMs) - now), totalMs, 1000, totalMs);
  const shouldPause = rawTurn.paused || Boolean(rawTurn.pauseKind) || !eligibleUserIds.length || !areEligibleUsersPresent(room, eligibleUserIds);
  const turn = {
    turn: Number(rawTurn.turn || room.turnNumber || 1),
    startedAt: shouldPause ? now - (totalMs - remainingMs) : Number(rawTurn.startedAt || now),
    deadline: shouldPause ? now + remainingMs : now + remainingMs,
    eligibleUserIds,
    actions,
    resolving: false,
    paused: Boolean(shouldPause || rawTurn.llmError),
    pauseKind: normalizeStateText(rawTurn.pauseKind || (shouldPause ? 'missing' : ''), 32),
    pauseReason: normalizeStateText(rawTurn.pauseReason || '', 140),
    llmError: rawTurn.llmError || null,
    remainingMs,
    totalMs,
    timer: null,
  };

  if (!turn.paused) {
    turn.timer = setTimeout(() => resolveTurn(room.id, 'restored-timeout'), remainingMs);
  }
  return turn;
}

function loadPersistedRooms() {
  const rawRooms = readPersistedRooms();
  let loaded = 0;

  for (const raw of rawRooms) {
    if (!raw?.id || rooms.has(raw.id)) continue;
    const room = {
      id: String(raw.id).toUpperCase(),
      name: normalizeStateText(raw.name || `${raw.hostName || '无名'} 的冒险桌`, 32),
      hostId: raw.hostId || '',
      hostName: raw.hostName || '未知房主',
      status: ['waiting', 'playing', 'ended'].includes(raw.status) ? raw.status : 'waiting',
      maxPlayers: clampNumber(raw.maxPlayers, MAX_PLAYERS, 1, MAX_PLAYERS),
      createdAt: raw.createdAt || nowIso(),
      players: new Map(),
      messages: Array.isArray(raw.messages) ? raw.messages.slice(-MAX_MESSAGES_PER_ROOM) : [],
      game: raw.game || null,
      playMode: normalizeGameMode(raw.game?.playMode || raw.playMode),
      llmError: raw.llmError || null,
      turnNumber: Number(raw.turnNumber || 0),
      currentTurn: null,
    };

    for (const player of Array.isArray(raw.players) ? raw.players : []) {
      const isBot = Boolean(player?.isBot || isBotId(player?.id));
      if (!player?.id || (!isBot && !findUserById(player.id))) continue;
      const record = applyVitalsRules({
        id: player.id,
        username: player.username || (isBot ? 'LLM队友' : findUserById(player.id)?.username) || '玩家',
        joinedAt: player.joinedAt || nowIso(),
        isBot,
        role: player.role || '',
        personalGoal: player.personalGoal || '',
        inventory: normalizeInventory(player.inventory || []),
        statusTags: normalizeStatusTags(player.statusTags || ['清醒']),
        stats: normalizeStats(player.stats || defaultStats()),
        location: normalizeLocation(player.location),
      });
      room.players.set(record.id, record);
      if (!record.isBot) userRooms.set(record.id, room.id);
    }

    if (room.status === 'playing') {
      room.currentTurn = rehydrateTurn(raw.currentTurn, room);
      if (!room.currentTurn) room.status = 'waiting';
    }

    if ((!room.hostId || !room.players.has(room.hostId)) && room.players.size) {
      const first = [...room.players.values()].find((player) => !player.isBot) || room.players.values().next().value;
      room.hostId = first.id;
      room.hostName = first.username;
    }

    rooms.set(room.id, room);
    loaded += 1;
  }

  if (loaded) {
    console.log(`[rooms] loaded ${loaded} persisted room(s).`);
    scheduleSaveRooms();
  }
}

function emitLobby() {
  io.emit('lobby:update', [...rooms.values()].map(serializeLobbyRoom));
  scheduleSaveRooms();
}

function emitRoom(room) {
  if (!room) return;
  for (const playerId of room.players.keys()) {
    if (userRooms.get(playerId) === room.id) {
      io.to(`user:${playerId}`).emit('room:update', serializeRoom(room, playerId));
    }
  }
  emitLobby();
}

function clearRoomTimer(room) {
  if (room?.currentTurn?.timer) clearTimeout(room.currentTurn.timer);
  if (room?.currentTurn) room.currentTurn.timer = null;
}

function pauseTurnIfNeeded(room, reason = '等待玩家返回') {
  if (!room || room.status !== 'playing' || !room.currentTurn || room.currentTurn.resolving) return false;
  const turn = room.currentTurn;
  turn.eligibleUserIds = (turn.eligibleUserIds || activeUserIds(room)).filter((id) => room.players.has(id) && canPlayerAct(room.players.get(id)));
  if (!turn.eligibleUserIds.length || areEligibleUsersPresent(room, turn.eligibleUserIds)) return false;

  const totalMs = turn.totalMs || getTurnTimeoutMs();
  if (!turn.paused) {
    turn.remainingMs = clampNumber((turn.deadline || Date.now()) - Date.now(), totalMs, 1000, totalMs);
    turn.totalMs = totalMs;
    turn.paused = true;
    turn.pauseKind = hasPresentHumanPlayer(room) ? 'missing' : 'no-human';
    turn.pauseReason = reason;
    clearRoomTimer(room);
    const missing = missingEligibleUsers(room, turn.eligibleUserIds).join('、') || '其他玩家';
    appendMessage(room, 'system', `回合已暂停：${reason}。等待 ${missing} 回到桌边后继续倒计时。`);
  }
  return true;
}

function resumeTurnIfReady(room, reason = '所有可行动玩家已回到桌边') {
  if (!room || room.status !== 'playing' || !room.currentTurn || room.currentTurn.resolving || !room.currentTurn.paused || room.currentTurn.llmError) return false;
  const turn = room.currentTurn;
  if (turn.pauseKind && !RESUMABLE_PAUSE_KINDS.has(turn.pauseKind)) return false;
  turn.eligibleUserIds = (turn.eligibleUserIds || activeUserIds(room)).filter((id) => room.players.has(id) && canPlayerAct(room.players.get(id)));
  if (!areEligibleUsersPresent(room, turn.eligibleUserIds)) return false;

  const allSubmitted = turn.eligibleUserIds.length > 0 && turn.eligibleUserIds.every((id) => turn.actions.has(id));
  if (allSubmitted) {
    turn.paused = false;
    turn.pauseKind = '';
    turn.pauseReason = '';
    appendMessage(room, 'system', `${reason}，且所有行动已提交。`);
    resolveTurn(room.id, 'all-submitted-after-resume');
    return true;
  }

  const totalMs = turn.totalMs || getTurnTimeoutMs();
  const remainingMs = clampNumber(turn.remainingMs || totalMs, totalMs, 1000, totalMs);
  const now = Date.now();
  turn.totalMs = totalMs;
  turn.remainingMs = remainingMs;
  turn.startedAt = now - Math.max(0, totalMs - remainingMs);
  turn.deadline = now + remainingMs;
  turn.paused = false;
  turn.pauseKind = '';
  turn.pauseReason = '';
  clearRoomTimer(room);
  turn.timer = setTimeout(() => resolveTurn(room.id, 'timeout'), remainingMs);
  appendMessage(room, 'system', `${reason}，回合倒计时继续。`);
  setTimeout(() => submitBotActions(room.id), 500);
  emitRoom(room);
  return true;
}

function markTurnLlmError(room, turn, phase, error) {
  if (!room || !turn || room.currentTurn !== turn) return;
  const message = errorMessage(error);
  turn.resolving = false;
  turn.paused = true;
  turn.pauseKind = 'llm-error';
  turn.pauseReason = message;
  turn.llmError = {
    phase,
    message,
    at: nowIso(),
  };
  turn.remainingMs = turn.remainingMs || 1000;
  clearRoomTimer(room);
  appendMessage(room, 'system', `LLM 调用连续失败，已暂停在当前回合。错误：${message}。房主可点击“重试 LLM”手动重试。`);
  emitRoom(room);
}

function retryTurnLlm(roomId, user) {
  const room = rooms.get(roomId);
  if (!room) throw new Error('房间不存在。');
  if (room.hostId !== user.id) throw new Error('只有房主可以手动重试 LLM。');
  if (room.status !== 'playing' || !room.currentTurn?.llmError) throw new Error('当前没有可重试的 LLM 错误。');
  if (!presentHumanUserIds(room).length) throw new Error('至少需要 1 名真人玩家在桌边才能重试。');

  const turn = room.currentTurn;
  turn.llmError = null;
  turn.paused = false;
  turn.pauseKind = '';
  turn.pauseReason = '';
  turn.resolving = false;
  appendMessage(room, 'system', `${user.username} 手动重试 LLM 结算。`);
  emitRoom(room);
  resolveTurn(room.id, 'manual-retry');
  return room;
}

function withdrawTurnAction(roomId, user) {
  const room = rooms.get(roomId);
  if (!room || !room.players.has(user.id)) throw new Error('你不在这个房间中。');
  if (room.status !== 'playing' || !room.currentTurn) throw new Error('当前不在行动阶段。');

  const turn = room.currentTurn;
  if (turn.resolving) throw new Error('本回合正在结算中，无法撤回行动。');
  if (turn.llmError) throw new Error('LLM 调用失败，当前回合已锁定，等待房主重试。');
  if (!turn.actions.has(user.id)) throw new Error('你还没有提交本回合行动。');

  const pendingOtherIds = pendingOtherEligibleUserIds(room, user.id, turn);
  if (!pendingOtherIds.length) throw new Error('其他可行动玩家都已提交，LLM 即将开始结算，无法撤回行动。');
  if (!canWithdrawTurnAction(room, user.id)) throw new Error('当前无法撤回行动。');

  const actionRecord = turn.actions.get(user.id);
  turn.actions.delete(user.id);
  removeSubmittedActionMessage(room, user.id, turn, actionRecord);

  if (isPrivateInfoMode(room)) {
    appendMessage(room, 'system', '你撤回了本回合行动，可重新编辑后提交。', {
      recipients: [user.id],
      privateTo: user.username,
      visibilityLabel: '仅你可见',
    });
  } else {
    appendMessage(room, 'system', `${user.username} 撤回了本回合行动，可重新提交。`);
  }

  emitRoom(room);
  return room;
}

function isChatMessageType(message) {
  return ['chat', 'say'].includes(message?.type);
}

function botChatDepth(message) {
  return clampNumber(message?.botChatDepth, 0, 0, MAX_BOT_CHAT_CHAIN_DEPTH);
}

function botMentionedInText(bot, text) {
  const content = String(text || '').toLowerCase();
  const name = String(bot?.username || '').toLowerCase();
  return Boolean(name && (content.includes(name) || content.includes(`@${name}`)));
}

function botCanHearChatMessage(room, bot, message) {
  if (!room || !bot?.isBot || !isChatMessageType(message)) return false;
  if (message.userId === bot.id) return false;
  if (room.status === 'playing' && !canPlayerPerceive(bot)) return false;
  if (Array.isArray(message.recipients) && message.recipients.length) return message.recipients.includes(bot.id);
  return !isPrivateInfoMode(room);
}

function eligibleBotChatResponders(room, triggerMessage) {
  if (!room || room.status === 'starting' || !isChatMessageType(triggerMessage)) return [];
  if (room.status === 'playing' && !hasPresentHumanPlayer(room)) return [];
  const depth = botChatDepth(triggerMessage);
  if (triggerMessage.isBot && depth >= MAX_BOT_CHAT_CHAIN_DEPTH) return [];

  const attempted = new Set(Array.isArray(triggerMessage.botChatAttemptedResponderIds) ? triggerMessage.botChatAttemptedResponderIds : []);
  const now = Date.now();
  const candidates = [...room.players.values()].filter((player) => {
    if (!player.isBot || attempted.has(player.id) || !botCanHearChatMessage(room, player, triggerMessage)) return false;
    if (botMentionedInText(player, triggerMessage.text)) return true;
    return now - Number(player.lastBotChatAt || 0) >= BOT_CHAT_COOLDOWN_MS;
  });

  candidates.sort((a, b) => Number(botMentionedInText(b, triggerMessage.text)) - Number(botMentionedInText(a, triggerMessage.text)) || a.username.localeCompare(b.username, 'zh-CN'));
  return candidates;
}

function appendBotChatMessage(room, bot, text, triggerMessage) {
  const privateMode = isPrivateInfoMode(room);
  const location = normalizeLocation(bot.location);
  const depth = botChatDepth(triggerMessage) + 1;
  const threadId = triggerMessage?.botChatThreadId || triggerMessage?.id || crypto.randomUUID();

  if (privateMode) {
    const recipients = audibleUserIds(room, bot.id, { respectPerception: room.status === 'playing' });
    const audienceNames = recipients.map((id) => room.players.get(id)?.username).filter(Boolean);
    return appendMessage(room, 'say', text, {
      userId: bot.id,
      username: bot.username,
      isBot: true,
      recipients,
      location,
      audienceLabel: `${location.label}：${audienceNames.join('、') || '只有你'}可听见`,
      botChatDepth: depth,
      botChatTriggerId: triggerMessage?.id || '',
      botChatThreadId: threadId,
    });
  }

  return appendMessage(room, 'chat', text, {
    userId: bot.id,
    username: bot.username,
    isBot: true,
    botChatDepth: depth,
    botChatTriggerId: triggerMessage?.id || '',
    botChatThreadId: threadId,
  });
}

function scheduleBotChatResponses(roomId, triggerMessageId) {
  if (!roomId || !triggerMessageId) return;
  const key = `${roomId}:${triggerMessageId}`;
  if (botChatJobs.has(key)) return;
  botChatJobs.add(key);
  const delay = BOT_CHAT_RESPONSE_DELAY_MS + crypto.randomInt(0, 600);
  setTimeout(() => {
    botChatJobs.delete(key);
    submitBotChatResponses(roomId, triggerMessageId).catch((error) => {
      console.error('[bot-chat] failed to submit bot chat response:', error);
    });
  }, delay);
}

async function submitBotChatResponses(roomId, triggerMessageId) {
  const room = rooms.get(roomId);
  if (!room || room.status === 'starting') return;
  const triggerMessage = room.messages.find((message) => message.id === triggerMessageId);
  if (!triggerMessage || !isChatMessageType(triggerMessage)) return;

  triggerMessage.botChatAttemptedResponderIds = Array.isArray(triggerMessage.botChatAttemptedResponderIds)
    ? triggerMessage.botChatAttemptedResponderIds
    : [];
  const candidates = eligibleBotChatResponders(room, triggerMessage);
  if (!candidates.length) return;

  const maxResponses = triggerMessage.isBot ? 1 : MAX_BOT_CHAT_RESPONSES_PER_MESSAGE;
  let responseCount = 0;
  for (const bot of candidates) {
    if (responseCount >= maxResponses) break;
    if (!rooms.has(roomId) || room.status === 'starting') break;
    if (!room.players.has(bot.id) || triggerMessage.botChatAttemptedResponderIds.includes(bot.id)) continue;

    triggerMessage.botChatAttemptedResponderIds.push(bot.id);
    const recentMessages = (isPrivateInfoMode(room) ? room.messages.filter((message) => messageVisibleToViewer(message, bot.id)) : room.messages)
      .map((message) => llmMessageContext(room, message));
    const triggerContext = {
      id: triggerMessage.id,
      userId: triggerMessage.userId || '',
      ...llmMessageContext(room, triggerMessage),
      botChatDepth: botChatDepth(triggerMessage),
      botChatThreadId: triggerMessage.botChatThreadId || triggerMessage.id,
    };

    let replyText = '';
    try {
      replyText = await generateBotChatReply({ room, bot, triggerMessage: triggerContext, recentMessages });
    } catch (error) {
      console.error('[bot-chat] generation failed:', error);
      continue;
    }

    const cleanReply = trimText(replyText, 360);
    if (!cleanReply) continue;
    if (!rooms.has(roomId) || !room.players.has(bot.id) || room.status === 'starting') break;

    bot.lastBotChatAt = Date.now();
    const message = appendBotChatMessage(room, bot, cleanReply, triggerMessage);
    responseCount += 1;
    emitRoom(room);

    if (message.isBot && botChatDepth(message) < MAX_BOT_CHAT_CHAIN_DEPTH) {
      scheduleBotChatResponses(room.id, message.id);
    }
  }
}

function pauseTurn(room, kind, reason, message, { resetRemaining = false } = {}) {
  if (!room || room.status !== 'playing' || !room.currentTurn) return false;
  const turn = room.currentTurn;
  const totalMs = turn.totalMs || getTurnTimeoutMs();
  turn.resolving = false;
  turn.paused = true;
  turn.pauseKind = kind;
  turn.pauseReason = reason;
  turn.remainingMs = resetRemaining
    ? totalMs
    : clampNumber((turn.deadline || Date.now()) - Date.now(), turn.remainingMs || totalMs, 1000, totalMs);
  turn.totalMs = totalMs;
  clearRoomTimer(room);
  if (message) appendMessage(room, 'system', message);
  emitRoom(room);
  return true;
}

function pauseInsteadOfResolvingIfNeeded(room, turn, reason) {
  const eligibleUserIds = (turn.eligibleUserIds || activeUserIds(room))
    .filter((id) => room.players.has(id) && canPlayerAct(room.players.get(id)));
  turn.eligibleUserIds = eligibleUserIds;

  if (!hasPresentHumanPlayer(room)) {
    return pauseTurn(room, 'no-human', '没有真人玩家在桌边', '回合已强制暂停：当前没有真人玩家在桌边，避免只由 LLM Bot 推进。真人玩家返回后将继续倒计时。');
  }

  if (!eligibleHumanUserIds(room, eligibleUserIds).length) {
    return pauseTurn(room, 'bot-only', '当前没有可行动真人角色', '回合已强制暂停：当前可行动角色里没有真人玩家，避免只由 LLM Bot 自动推进。需要真人角色恢复可行动，或由房主中止/重开。', { resetRemaining: true });
  }

  const isTimeout = ['timeout', 'restored-timeout'].includes(reason);
  if (isTimeout && submittedHumanUserIds(room, turn).length === 0) {
    return pauseTurn(room, 'no-response', '本回合没有真人玩家提交行动', '回合已强制暂停：本回合没有任何真人玩家提交行动，已停止超时结算以避免空转。任一可行动真人提交行动后，将恢复本回合倒计时。', { resetRemaining: true });
  }

  return false;
}

function resumeNoResponseTurnAfterAction(room, reason = '已有真人玩家提交行动') {
  const turn = room?.currentTurn;
  if (!room || room.status !== 'playing' || !turn || !turn.paused || turn.pauseKind !== 'no-response' || turn.resolving || turn.llmError) return false;
  turn.eligibleUserIds = (turn.eligibleUserIds || activeUserIds(room)).filter((id) => room.players.has(id) && canPlayerAct(room.players.get(id)));
  if (!areEligibleUsersPresent(room, turn.eligibleUserIds)) return false;

  const totalMs = turn.totalMs || getTurnTimeoutMs();
  const remainingMs = clampNumber(turn.remainingMs || totalMs, totalMs, 1000, totalMs);
  const now = Date.now();
  turn.totalMs = totalMs;
  turn.remainingMs = remainingMs;
  turn.startedAt = now - Math.max(0, totalMs - remainingMs);
  turn.deadline = now + remainingMs;
  turn.paused = false;
  turn.pauseKind = '';
  turn.pauseReason = '';
  clearRoomTimer(room);
  turn.timer = setTimeout(() => resolveTurn(room.id, 'timeout'), remainingMs);
  appendMessage(room, 'system', `${reason}，回合倒计时继续。`);
  setTimeout(() => submitBotActions(room.id), 500);
  emitRoom(room);
  return true;
}

function destroyRoom(roomId, reason = '房间已关闭。') {
  const room = rooms.get(roomId);
  if (!room) return;
  clearRoomTimer(room);
  for (const playerId of room.players.keys()) {
    userRooms.delete(playerId);
    io.to(`user:${playerId}`).emit('room:closed', { roomId, reason });
  }
  rooms.delete(roomId);
  emitLobby();
}

function deleteRoomAsUser(roomId, user) {
  const room = rooms.get(roomId);
  if (!room) throw new Error('房间不存在。');
  if (room.hostId !== user.id) throw new Error('只有房主可以删除这张冒险桌。');
  destroyRoom(roomId, `${user.username} 主动删除了冒险桌。`);
}

function endAdventureAsUser(roomId, user) {
  const room = rooms.get(roomId);
  if (!room) throw new Error('房间不存在。');
  if (room.hostId !== user.id) throw new Error('只有房主可以中止冒险。');
  if (!['starting', 'playing'].includes(room.status)) throw new Error('当前没有正在进行的冒险可中止。');

  clearRoomTimer(room);
  room.status = 'ended';
  room.currentTurn = null;
  room.llmError = null;
  appendMessage(room, 'system', `${user.username} 中止了本次冒险。房间仍保留在大厅，可聊天复盘、重新开始或稍后删除。`);
  scheduleSaveRooms();
  emitRoom(room);
  return room;
}

function leaveRoom(userId, { voluntary = true } = {}) {
  const roomId = userRooms.get(userId);
  if (!roomId) return null;
  const room = rooms.get(roomId);
  userRooms.delete(userId);
  io.in(`user:${userId}`).socketsLeave(socketRoom(roomId));
  if (!room) return null;

  const player = room.players.get(userId);
  if (player && voluntary) appendMessage(room, 'system', `${player.username} 离开了房间。角色与游戏状态会保留，回来后可继续。`);

  if (room.status === 'playing') {
    pauseTurnIfNeeded(room, `${player?.username || '玩家'} 暂时离开`);
  }

  scheduleSaveRooms();
  emitRoom(room);
  return room;
}

function joinRoomSockets(userId, roomId) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  for (const socketId of sockets) {
    const connectedSocket = io.sockets.sockets.get(socketId);
    connectedSocket?.join(socketRoom(roomId));
  }
}

function createRoom(user) {
  if (rooms.size >= MAX_ROOMS) throw new Error('大厅房间太多了，请稍后再试。');
  leaveRoom(user.id, { voluntary: true });

  let id = roomPublicId();
  while (rooms.has(id)) id = roomPublicId();
  const room = {
    id,
    name: `${user.username} 的冒险桌`,
    hostId: user.id,
    hostName: user.username,
    status: 'waiting',
    maxPlayers: MAX_PLAYERS,
    createdAt: nowIso(),
    players: new Map(),
    messages: [],
    game: null,
    playMode: 'cooperative',
    turnNumber: 0,
    currentTurn: null,
  };
  room.players.set(user.id, makePlayerRecord(user));
  appendMessage(room, 'system', `${user.username} 创建了房间。等待其他冒险者加入。`);
  rooms.set(id, room);
  userRooms.set(user.id, id);
  joinRoomSockets(user.id, id);
  emitRoom(room);
  return room;
}

function addPlayerToRoom(room, user) {
  const alreadyParticipant = room.players.has(user.id);
  if (room.status === 'playing' && !alreadyParticipant) throw new Error('这间房正在冒险中，只有已有角色的玩家可以返回继续。');
  if (!['waiting', 'ended', 'playing'].includes(room.status)) throw new Error('这间房暂时不能加入。');
  if (room.players.size >= room.maxPlayers && !alreadyParticipant) throw new Error('这间房已满。');

  const currentRoomId = userRooms.get(user.id);
  if (currentRoomId && currentRoomId !== room.id) leaveRoom(user.id, { voluntary: true });

  const wasEmpty = room.players.size === 0;
  if (!alreadyParticipant) {
    room.players.set(user.id, makePlayerRecord(user));
  } else {
    const player = room.players.get(user.id);
    player.username = user.username;
  }

  if (wasEmpty) {
    room.hostId = user.id;
    room.hostName = user.username;
    appendMessage(room, 'system', `${user.username} 回到了空置的冒险桌，并成为房主。`);
  }
  userRooms.set(user.id, room.id);
  joinRoomSockets(user.id, room.id);
  appendMessage(room, 'system', alreadyParticipant ? `${user.username} 回到了冒险桌。` : `${user.username} 加入了房间。`);

  if (room.status === 'playing') resumeTurnIfReady(room, `${user.username} 已返回`);
  emitRoom(room);
  return room;
}

function addBotToRoom(roomId, user, requestedName = '') {
  const room = rooms.get(roomId);
  if (!room) throw new Error('房间不存在。');
  if (room.hostId !== user.id) throw new Error('只有房主可以添加 LLM Bot 队友。');
  if (!['waiting', 'ended'].includes(room.status)) throw new Error('只能在等待或已结束状态添加 Bot。');
  if (room.players.size >= room.maxPlayers) throw new Error('这间房已满。');
  const botCount = [...room.players.values()].filter((player) => player.isBot).length;
  if (botCount >= MAX_BOTS_PER_ROOM) throw new Error(`每间房最多 ${MAX_BOTS_PER_ROOM} 个 LLM Bot。`);

  const bot = makeBotRecord(room, requestedName);
  room.players.set(bot.id, bot);
  appendMessage(room, 'system', `${bot.username}（LLM Bot）加入了队伍。`);
  emitRoom(room);
  return room;
}

function removeBotFromRoom(roomId, user, botId) {
  const room = rooms.get(roomId);
  if (!room) throw new Error('房间不存在。');
  if (room.hostId !== user.id) throw new Error('只有房主可以移除 LLM Bot 队友。');
  if (!['waiting', 'ended'].includes(room.status)) throw new Error('只能在等待或已结束状态移除 Bot。');
  const bot = room.players.get(botId);
  if (!bot || !bot.isBot) throw new Error('Bot 不存在。');

  room.players.delete(botId);
  appendMessage(room, 'system', `${bot.username}（LLM Bot）离开了队伍。`);
  emitRoom(room);
  return room;
}

function narrationForPlayer(result, player) {
  const entries = Array.isArray(result?.privateNarrations) ? result.privateNarrations : [];
  const match = entries.find((entry) => String(entry?.username || '').toLowerCase() === player.username.toLowerCase());
  return normalizeStateText(match?.narration || match?.text || '', 2400);
}

function appendGmNarration(room, result, fallbackText = '') {
  if (!isPrivateInfoMode(room)) {
    appendMessage(room, 'gm', result?.narration || fallbackText || '命运继续向前。', { username: 'LLM GM' });
    return;
  }

  for (const player of room.players.values()) {
    const condition = getPlayerCondition(player);
    const text = condition.canPerceive === false
      ? `你当前${condition.label}，意识与外界断开，无法获取周围发生的细节；需要外界唤醒、急救或稳定状态后才能重新感知。`
      : narrationForPlayer(result, player) || fallbackText || '你的视角里，局势已经发生变化。GM 没有提供更多公开信息；请根据你已知的一切谨慎行动。';
    appendMessage(room, 'gm', text, {
      username: 'LLM GM',
      recipients: [player.id],
      privateTo: player.username,
      visibilityLabel: condition.canPerceive === false ? '意识中断' : '你的视角播报',
    });
  }
}

function appendSetupNarration(room, setup) {
  if (!isPrivateInfoMode(room)) {
    appendMessage(room, 'gm', setup.openingNarration, { username: 'LLM GM' });
    return;
  }

  const openings = { privateNarrations: setup.privateOpenings || setup.privateNarrations || [] };
  appendMessage(room, 'gm', setup.openingNarration, { username: 'LLM GM', visibilityLabel: '公开开场' });
  appendGmNarration(room, openings, '你进入了自己的开局视角。注意：本模式下不要假定其他空间、其他角色的秘密和行动结果。');
}

function appendStateEvents(room, events = [], stateChanges = '') {
  if (!events.length && !stateChanges) return;
  if (!isPrivateInfoMode(room)) {
    appendMessage(room, 'state', stateChanges || '状态发生变化。', {
      username: '系统',
      title: '状态变化',
      summary: stateChanges,
      events,
    });
    return;
  }

  const byUser = new Map();
  for (const event of events) {
    if (!event?.userId) continue;
    const list = byUser.get(event.userId) || [];
    list.push(event);
    byUser.set(event.userId, list);
  }
  for (const [userId, userEvents] of byUser.entries()) {
    const player = room.players.get(userId);
    if (!player) continue;
    appendMessage(room, 'state', userEvents.map((event) => event.summary).join('｜'), {
      username: '系统',
      title: '你的状态变化',
      events: userEvents,
      recipients: [userId],
      privateTo: player.username,
      visibilityLabel: '仅你可见',
    });
  }
}

function appendSpotlight(room, spotlight) {
  if (!spotlight?.username || !spotlight?.text) return;
  if (!isPrivateInfoMode(room)) {
    appendMessage(room, 'system', `聚光灯：${spotlight.username}｜${spotlight.text}`);
    return;
  }
  const player = [...room.players.values()].find((entry) => entry.username.toLowerCase() === String(spotlight.username).toLowerCase());
  if (!player) return;
  appendMessage(room, 'system', `聚光灯：${spotlight.text}`, { recipients: [player.id], privateTo: player.username, visibilityLabel: '仅你可见' });
}

async function startGame(roomId, starterId, rawSetupOptions = {}) {
  const room = rooms.get(roomId);
  if (!room) throw new Error('房间不存在。');
  if (room.hostId !== starterId) throw new Error('只有房主可以开始游戏。');
  if (!['waiting', 'ended'].includes(room.status)) throw new Error('游戏已经开始或正在生成。');
  if (room.players.size < 1) throw new Error('至少需要 1 名玩家。');
  if (!presentHumanUserIds(room).length) throw new Error('至少需要 1 名真人玩家在桌边才能开始或继续冒险。');

  const setupOptions = normalizeSetupOptions(rawSetupOptions);
  const restarting = room.status === 'ended' || room.game || room.turnNumber > 0;
  clearRoomTimer(room);
  room.status = 'starting';
  room.currentTurn = null;
  room.llmError = null;
  room.turnNumber = 0;
  room.game = null;
  room.playMode = setupOptions.playMode;
  appendMessage(room, 'system', `${restarting ? '房主决定重新开始。' : '房主按下了巨大的 START 按钮。'}游戏模式：${gameModeLabel(setupOptions.playMode)}；开局模式：${setupModeLabel(setupOptions)}。LLM 正在生成世界、角色与目标……`);
  emitRoom(room);

  const players = [...room.players.values()].map((player) => ({ id: player.id, username: player.username, isBot: Boolean(player.isBot) }));
  let setup;
  try {
    setup = await generateGameSetup(players, setupOptions);
  } catch (error) {
    const currentRoom = rooms.get(roomId);
    if (currentRoom?.status !== 'starting') return null;
    const message = errorMessage(error);
    currentRoom.status = 'waiting';
    currentRoom.currentTurn = null;
    currentRoom.llmError = { phase: 'setup', message, at: nowIso() };
    appendMessage(currentRoom, 'system', `LLM 开局生成连续失败，已暂停。错误：${message}。房主可稍后再次点击开始游戏重试。`);
    emitRoom(currentRoom);
    throw error;
  }
  const currentRoom = rooms.get(roomId);
  if (!currentRoom || currentRoom.status !== 'starting') return null;
  currentRoom.llmError = null;

  currentRoom.game = {
    title: setup.title,
    setting: setup.setting,
    globalGoal: setup.globalGoal,
    tone: setup.tone,
    provider: setup.provider,
    setupMode: setupOptions.mode,
    playMode: setupOptions.playMode,
    playModeLabel: gameModeLabel(setupOptions.playMode),
  };

  for (const player of currentRoom.players.values()) {
    const generated = setup.players.find((entry) => entry.username.toLowerCase() === player.username.toLowerCase());
    if (generated) {
      player.role = generated.role;
      player.personalGoal = generated.personalGoal;
      player.inventory = normalizeInventory(generated.inventory || []);
      player.statusTags = normalizeStatusTags(generated.statusTags || ['清醒']);
      player.stats = normalizeStats(generated.stats || defaultStats());
      player.location = normalizeLocation(generated.location);
      applyVitalsRules(player);
    }
  }

  currentRoom.status = 'playing';
  currentRoom.turnNumber = 1;
  appendSetupNarration(currentRoom, setup);
  if (setup.warning) appendMessage(currentRoom, 'system', setup.warning);
  beginTurn(currentRoom);
  return currentRoom;
}

function beginTurn(room) {
  clearRoomTimer(room);
  const recoveryEvents = applyNaturalStaminaRecovery(room);
  if (recoveryEvents.length) appendStateEvents(room, recoveryEvents, '单纯力竭的角色经过短暂喘息，体力自然恢复。');

  const eligibleUserIds = activeUserIds(room);
  const timeoutMs = getTurnTimeoutMs();
  const startedAt = Date.now();
  if (!eligibleUserIds.length) {
    room.currentTurn = {
      turn: room.turnNumber,
      startedAt,
      deadline: startedAt + timeoutMs,
      eligibleUserIds: [],
      actions: new Map(),
      resolving: false,
      paused: true,
      pauseKind: 'no-able-players',
      pauseReason: '所有角色当前都无法行动',
      remainingMs: timeoutMs,
      totalMs: timeoutMs,
      timer: null,
    };
    appendMessage(room, 'system', '冒险已暂停：所有角色当前都无法行动。房主可以中止后重新开始，或等待后续手动处理。');
    emitRoom(room);
    return;
  }

  const hasEligibleHuman = eligibleHumanUserIds(room, eligibleUserIds).length > 0;
  const shouldPause = !hasEligibleHuman || !areEligibleUsersPresent(room, eligibleUserIds);
  room.currentTurn = {
    turn: room.turnNumber,
    startedAt,
    deadline: startedAt + timeoutMs,
    eligibleUserIds,
    actions: new Map(),
    resolving: false,
    paused: shouldPause,
    pauseKind: shouldPause ? (hasEligibleHuman ? (hasPresentHumanPlayer(room) ? 'missing' : 'no-human') : 'bot-only') : '',
    pauseReason: shouldPause ? (hasEligibleHuman ? '等待可行动真人玩家回到桌边' : '当前没有可行动真人角色') : '',
    remainingMs: timeoutMs,
    totalMs: timeoutMs,
    timer: shouldPause ? null : setTimeout(() => resolveTurn(room.id, 'timeout'), timeoutMs),
  };

  const unableNames = [...room.players.values()]
    .filter((player) => !eligibleUserIds.includes(player.id))
    .map((player) => `${player.username}（${getPlayerCondition(player).label}）`);
  const privacyHint = isPrivateInfoMode(room)
    ? '本模式信息不共享：行动只提交给 GM；说话只会被同一空间的角色听见。'
    : '';
  appendMessage(
    room,
    'system',
    `第 ${room.turnNumber} 回合开始。${eligibleUserIds.length} 名玩家可行动；全员提交后继续，或等待 3 分钟自动结算。${privacyHint}${unableNames.length ? `暂时无法行动：${unableNames.join('、')}。` : ''}`
  );
  if (shouldPause) {
    if (!hasEligibleHuman) {
      appendMessage(room, 'system', '回合已强制暂停：当前可行动角色里没有真人玩家，避免只由 LLM Bot 自动推进。');
    } else {
      const missing = missingEligibleUsers(room, eligibleUserIds).join('、') || '真人玩家';
      appendMessage(room, 'system', `回合已暂停：等待 ${missing} 回到桌边后继续倒计时。`);
    }
  } else {
    setTimeout(() => submitBotActions(room.id), 800);
  }
  emitRoom(room);
}

async function submitBotActions(roomId) {
  const room = rooms.get(roomId);
  const turn = room?.currentTurn;
  if (!room || room.status !== 'playing' || !turn || turn.resolving || turn.paused || turn.botSubmitting) return;

  const bots = (turn.eligibleUserIds || [])
    .map((id) => room.players.get(id))
    .filter((player) => player?.isBot && canPlayerAct(player) && !turn.actions.has(player.id));
  if (!bots.length) return;

  turn.botSubmitting = true;
  try {
    for (const bot of bots) {
      if (!rooms.has(roomId) || room.currentTurn !== turn || turn.resolving || turn.paused || turn.actions.has(bot.id)) break;
      const recentMessages = (isPrivateInfoMode(room) ? room.messages.filter((message) => messageVisibleToViewer(message, bot.id)) : room.messages)
        .map((message) => llmMessageContext(room, message));

      let text;
      try {
        text = await generateBotAction({ room, bot, recentMessages });
      } catch (error) {
        console.error('[bot] failed to generate action after retries:', error);
        markTurnLlmError(room, turn, 'bot-action', error);
        return;
      }

      if (!rooms.has(roomId) || room.currentTurn !== turn || turn.resolving || turn.paused || turn.actions.has(bot.id)) break;
      const actionText = trimText(text, 700) || `${bot.username}谨慎观察局势，等待最佳时机支援队伍。`;
      const actionRecord = { text: actionText, createdAt: nowIso(), isBot: true, location: normalizeLocation(bot.location), actionId: crypto.randomUUID() };
      turn.actions.set(bot.id, actionRecord);
      const privateAction = isPrivateInfoMode(room);
      const actionMessage = appendMessage(room, 'action', actionText, {
        userId: bot.id,
        username: bot.username,
        turn: turn.turn,
        isBot: true,
        location: actionRecord.location,
        actionId: actionRecord.actionId,
        visibilityLabel: privateAction ? 'Bot 私下行动' : '',
        recipients: privateAction ? [bot.id] : undefined,
      });
      actionRecord.messageId = actionMessage.id;
      emitRoom(room);
    }
  } finally {
    if (room.currentTurn === turn) turn.botSubmitting = false;
  }

  if (!rooms.has(roomId) || room.currentTurn !== turn || turn.resolving || turn.paused) return;
  const eligible = (turn.eligibleUserIds || []).filter((id) => room.players.has(id) && canPlayerAct(room.players.get(id)));
  const allSubmitted = eligible.length > 0 && eligible.every((id) => turn.actions.has(id));
  if (allSubmitted) resolveTurn(room.id, 'all-submitted');
}

async function resolveTurn(roomId, reason = 'manual') {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'playing' || !room.currentTurn || room.currentTurn.resolving || room.currentTurn.paused) return;

  const turn = room.currentTurn;
  if (pauseInsteadOfResolvingIfNeeded(room, turn, reason)) return;
  turn.resolving = true;
  turn.deadline = Date.now();
  clearTimeout(turn.timer);
  const resolvingText = reason === 'timeout'
    ? '时间耗尽，LLM 正在结算本回合……'
    : reason === 'no-able-players'
      ? '无人能够行动，LLM 正在结算局势……'
      : '所有可行动玩家已提交，LLM 正在结算本回合……';
  appendMessage(room, 'system', resolvingText);
  emitRoom(room);

  const players = [...room.players.values()];
  const eligibleSet = new Set(turn.eligibleUserIds || players.filter((player) => canPlayerAct(player)).map((player) => player.id));
  const actions = players
    .filter((player) => eligibleSet.has(player.id) && turn.actions.has(player.id))
    .map((player) => ({
      userId: player.id,
      username: player.username,
      text: turn.actions.get(player.id).text,
      location: turn.actions.get(player.id).location || normalizeLocation(player.location),
    }));
  const timedOutUsers = players.filter((player) => eligibleSet.has(player.id) && !turn.actions.has(player.id)).map((player) => player.username);
  const unableUsers = players
    .filter((player) => !eligibleSet.has(player.id))
    .map((player) => {
      const condition = getPlayerCondition(player);
      return {
        username: player.username,
        reason: condition.reason || condition.label,
        statusTags: player.statusTags,
        stats: player.stats,
      };
    });
  const recentMessages = room.messages.map((message) => llmMessageContext(room, message));

  let result;
  try {
    result = await generateTurnNarration({ room, actions, timedOutUsers, unableUsers, recentMessages });
  } catch (error) {
    const currentRoom = rooms.get(roomId);
    if (currentRoom?.currentTurn === turn) markTurnLlmError(currentRoom, turn, 'turn', error);
    return;
  }
  const currentRoom = rooms.get(roomId);
  if (!currentRoom || currentRoom.currentTurn !== turn) return;
  turn.llmError = null;

  appendGmNarration(currentRoom, result);
  const stateEvents = applyStoryToolCalls(currentRoom, result.storyProgressToolCalls || []);
  appendStateEvents(currentRoom, stateEvents, result.stateChanges);
  appendSpotlight(currentRoom, result.spotlight);
  if (result.warning) appendMessage(currentRoom, 'system', result.warning);

  if (result.gameOver) {
    currentRoom.status = 'ended';
    currentRoom.currentTurn = null;
    appendMessage(currentRoom, 'gm', result.ending || '冒险暂告一段落。', { username: 'LLM GM', visibilityLabel: '结局公开' });
    if (normalizeGameMode(currentRoom.game?.playMode) === 'independent' && result.mvp?.username) {
      appendMessage(currentRoom, 'award', result.mvp.reason || 'LLM GM 评定的本局 MVP。', {
        username: 'LLM GM',
        title: 'MVP',
        mvp: result.mvp,
      });
    }
    emitRoom(currentRoom);
    return;
  }

  currentRoom.turnNumber += 1;
  beginTurn(currentRoom);
}

function socketUser(socket) {
  return socket.request.session?.user || null;
}

function ackOk(ack, payload = {}) {
  if (typeof ack === 'function') ack({ ok: true, ...payload });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || '操作失败。');
}

function ackError(ack, error) {
  const message = errorMessage(error);
  if (typeof ack === 'function') ack({ ok: false, error: message });
}

io.engine.use(sessionMiddleware);

io.use((socket, next) => {
  const user = socketUser(socket);
  if (!user) return next(new Error('unauthorized'));
  if (!findUserById(user.id)) return next(new Error('unauthorized'));
  next();
});

io.on('connection', (socket) => {
  const user = socketUser(socket);
  if (!user) return socket.disconnect(true);

  socket.join(`user:${user.id}`);
  const sockets = userSockets.get(user.id) || new Set();
  sockets.add(socket.id);
  userSockets.set(user.id, sockets);

  const roomId = userRooms.get(user.id);
  if (roomId && rooms.has(roomId)) {
    const room = rooms.get(roomId);
    socket.join(socketRoom(roomId));
    if (room.players.has(user.id)) resumeTurnIfReady(room, `${user.username} 已重新连接`);
    socket.emit('room:update', serializeRoom(room, user.id));
  }

  socket.emit('lobby:update', [...rooms.values()].map(serializeLobbyRoom));
  for (const room of rooms.values()) {
    if (room.players.has(user.id)) emitRoom(room);
  }

  socket.on('room:create', (payload, ack) => {
    try {
      const room = createRoom(user);
      const requestedName = trimText(payload?.name, 32);
      if (requestedName) room.name = requestedName;
      appendMessage(room, 'system', `房间名设置为「${room.name}」。`);
      emitRoom(room);
      ackOk(ack, { room: serializeRoom(room, user.id) });
    } catch (error) {
      ackError(ack, error);
    }
  });

  socket.on('room:join', (payload, ack) => {
    try {
      const room = rooms.get(String(payload?.roomId || '').toUpperCase());
      if (!room) throw new Error('房间不存在。');
      const joined = addPlayerToRoom(room, user);
      ackOk(ack, { room: serializeRoom(joined, user.id) });
    } catch (error) {
      ackError(ack, error);
    }
  });

  socket.on('room:leave', (_payload, ack) => {
    try {
      leaveRoom(user.id, { voluntary: true });
      ackOk(ack);
    } catch (error) {
      ackError(ack, error);
    }
  });

  socket.on('room:delete', (payload, ack) => {
    try {
      const roomIdToDelete = String(payload?.roomId || userRooms.get(user.id) || '').toUpperCase();
      deleteRoomAsUser(roomIdToDelete, user);
      ackOk(ack);
    } catch (error) {
      ackError(ack, error);
    }
  });

  socket.on('room:bot:add', (payload, ack) => {
    try {
      const roomIdToUpdate = String(payload?.roomId || userRooms.get(user.id) || '').toUpperCase();
      const room = addBotToRoom(roomIdToUpdate, user, payload?.name);
      ackOk(ack, { room: serializeRoom(room, user.id) });
    } catch (error) {
      ackError(ack, error);
    }
  });

  socket.on('room:bot:remove', (payload, ack) => {
    try {
      const roomIdToUpdate = String(payload?.roomId || userRooms.get(user.id) || '').toUpperCase();
      const room = removeBotFromRoom(roomIdToUpdate, user, String(payload?.botId || ''));
      ackOk(ack, { room: serializeRoom(room, user.id) });
    } catch (error) {
      ackError(ack, error);
    }
  });

  socket.on('room:start', async (payload, ack) => {
    try {
      const roomIdToStart = String(payload?.roomId || userRooms.get(user.id) || '').toUpperCase();
      const room = await startGame(roomIdToStart, user.id, payload?.setup || payload?.setupOptions || {});
      ackOk(ack, room ? { room: serializeRoom(room, user.id) } : {});
    } catch (error) {
      ackError(ack, error);
    }
  });

  socket.on('room:end', (payload, ack) => {
    try {
      const roomIdToEnd = String(payload?.roomId || userRooms.get(user.id) || '').toUpperCase();
      const room = endAdventureAsUser(roomIdToEnd, user);
      ackOk(ack, { room: serializeRoom(room, user.id) });
    } catch (error) {
      ackError(ack, error);
    }
  });

  socket.on('llm:retry', (payload, ack) => {
    try {
      const roomIdToRetry = String(payload?.roomId || userRooms.get(user.id) || '').toUpperCase();
      const room = retryTurnLlm(roomIdToRetry, user);
      ackOk(ack, { room: serializeRoom(room, user.id) });
    } catch (error) {
      ackError(ack, error);
    }
  });

  socket.on('turn:withdraw', (payload, ack) => {
    try {
      const roomIdToUpdate = String(payload?.roomId || userRooms.get(user.id) || '').toUpperCase();
      const room = withdrawTurnAction(roomIdToUpdate, user);
      ackOk(ack, { room: serializeRoom(room, user.id) });
    } catch (error) {
      ackError(ack, error);
    }
  });

  socket.on('turn:action', (payload, ack) => {
    try {
      const room = rooms.get(String(payload?.roomId || userRooms.get(user.id) || '').toUpperCase());
      if (!room || !room.players.has(user.id)) throw new Error('你不在这个房间中。');
      if (room.status !== 'playing' || !room.currentTurn) throw new Error('当前不在行动阶段。');
      if (room.currentTurn.resolving) throw new Error('本回合正在结算中。');
      if (room.currentTurn.llmError) throw new Error('LLM 调用失败，当前回合已暂停，等待房主手动重试。');
      const canSubmitDuringNoResponsePause = room.currentTurn.paused && room.currentTurn.pauseKind === 'no-response';
      if (room.currentTurn.paused && !canSubmitDuringNoResponsePause) throw new Error(`回合暂停中，等待 ${missingEligibleUsers(room).join('、') || room.currentTurn.pauseReason || '其他玩家'} 返回。`);
      if (room.currentTurn.actions.has(user.id)) throw new Error('你已提交本回合行动。');
      const player = room.players.get(user.id);
      const condition = getPlayerCondition(player);
      if (!room.currentTurn.eligibleUserIds?.includes(user.id) || !condition.canAct) {
        throw new Error(`你当前${condition.label}，无法提交行动，但仍可发送聊天/说话。`);
      }
      const text = trimText(payload?.text, 700);
      if (text.length < 1) throw new Error('行动不能为空。');

      const actionRecord = { text, createdAt: nowIso(), location: normalizeLocation(player.location), actionId: crypto.randomUUID() };
      room.currentTurn.actions.set(user.id, actionRecord);
      const privateAction = isPrivateInfoMode(room);
      const actionMessage = appendMessage(room, 'action', text, {
        userId: user.id,
        username: user.username,
        turn: room.currentTurn.turn,
        location: actionRecord.location,
        actionId: actionRecord.actionId,
        visibilityLabel: privateAction ? '仅你与 GM 可见' : '',
        recipients: privateAction ? [user.id] : undefined,
      });
      actionRecord.messageId = actionMessage.id;
      emitRoom(room);
      ackOk(ack);
      if (canSubmitDuringNoResponsePause) resumeNoResponseTurnAfterAction(room, `${user.username} 已提交行动`);

      const activePlayerIds = (room.currentTurn.eligibleUserIds || []).filter((id) => room.players.has(id));
      const allSubmitted = activePlayerIds.length > 0 && activePlayerIds.every((id) => room.currentTurn.actions.has(id));
      if (allSubmitted) resolveTurn(room.id, 'all-submitted');
    } catch (error) {
      ackError(ack, error);
    }
  });

  socket.on('chat:send', (payload, ack) => {
    try {
      const room = rooms.get(String(payload?.roomId || userRooms.get(user.id) || '').toUpperCase());
      if (!room || !room.players.has(user.id)) throw new Error('你不在这个房间中。');
      const text = trimText(payload?.text, 360);
      if (!text) throw new Error('聊天内容不能为空。');
      let message;
      if (isPrivateInfoMode(room)) {
        const speaker = room.players.get(user.id);
        const condition = getPlayerCondition(speaker);
        if (room.status === 'playing' && !condition.canPerceive) throw new Error(`你当前${condition.label}，无法说话、交互或获取外界信息。`);
        const recipients = audibleUserIds(room, user.id, { respectPerception: room.status === 'playing' });
        const audienceNames = recipients.map((id) => room.players.get(id)?.username).filter(Boolean);
        const location = normalizeLocation(speaker?.location);
        message = appendMessage(room, 'say', text, {
          userId: user.id,
          username: user.username,
          recipients,
          location,
          audienceLabel: `${location.label}：${audienceNames.join('、') || '只有你'}可听见`,
          botChatDepth: 0,
          botChatThreadId: crypto.randomUUID(),
        });
      } else {
        message = appendMessage(room, 'chat', text, {
          userId: user.id,
          username: user.username,
          botChatDepth: 0,
          botChatThreadId: crypto.randomUUID(),
        });
      }
      emitRoom(room);
      ackOk(ack);
      scheduleBotChatResponses(room.id, message.id);
    } catch (error) {
      ackError(ack, error);
    }
  });

  socket.on('disconnect', () => {
    const set = userSockets.get(user.id);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) userSockets.delete(user.id);
    }
    for (const room of rooms.values()) {
      if (room.players.has(user.id)) {
        pauseTurnIfNeeded(room, `${user.username} 断开连接`);
        emitRoom(room);
      }
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

loadPersistedRooms();

process.on('SIGINT', () => {
  try { saveRoomsNow(); } catch (error) { console.error('[rooms] failed to persist rooms on SIGINT:', error); }
  process.exit(0);
});

process.on('SIGTERM', () => {
  try { saveRoomsNow(); } catch (error) { console.error('[rooms] failed to persist rooms on SIGTERM:', error); }
  process.exit(0);
});

server.listen(PORT, () => {
  const provider = process.env.LLM_PROVIDER || (process.env.LLM_API_KEY ? 'openai-compatible' : 'mock');
  console.log(`MAGOL LLM adventure server listening on http://localhost:${PORT}`);
  console.log(`LLM provider: ${provider}${process.env.LLM_API_KEY ? '' : ' (no API key, using mock fallback)'}`);
});
