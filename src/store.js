import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback, options = {}) {
  ensureDataDir();
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`[store] Failed to read ${file}:`, error);
    if (options.fatalOnParseError) {
      throw new Error(`Refusing to start because ${file} is not valid JSON. Fix it before starting to avoid corrupting persisted rooms.`, { cause: error });
    }
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDataDir();
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(value, null, 2));
  fs.renameSync(tempFile, file);
}

let users = readJson(USERS_FILE, [], { fatalOnParseError: true });

export function listUsers() {
  return users.map(({ passwordHash, ...user }) => user);
}

export function findUserById(id) {
  return users.find((user) => user.id === id) || null;
}

export function findUserByUsername(username) {
  const normalized = username.trim().toLowerCase();
  return users.find((user) => user.username.toLowerCase() === normalized) || null;
}

export function createUser({ id, username, passwordHash }) {
  const user = {
    id,
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeJson(USERS_FILE, users);
  return user;
}
