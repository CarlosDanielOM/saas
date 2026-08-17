import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });

  const paths = {
    users: join(dataDir, 'users.json'),
    sessions: join(dataDir, 'sessions.json'),
    connections: join(dataDir, 'connections.json'),
    secret: join(dataDir, 'secret'),
  };

  const secret = loadSecret(paths.secret);

  function readList(file) {
    if (!existsSync(file)) {
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeList(file, rows) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  }

  return {
    secret,
    users: () => readList(paths.users),
    saveUsers: (rows) => writeList(paths.users, rows),
    sessions: () => readList(paths.sessions),
    saveSessions: (rows) => writeList(paths.sessions, rows),
    connections: () => readList(paths.connections),
    saveConnections: (rows) => writeList(paths.connections, rows),
    hashPassword(password) {
      const salt = randomBytes(16).toString('hex');
      const hash = scryptSync(password, salt, 64).toString('hex');
      return `scrypt:${salt}:${hash}`;
    },
    verifyPassword(password, stored) {
      const [algo, salt, hash] = String(stored || '').split(':');
      if (algo !== 'scrypt' || !salt || !hash) {
        return false;
      }
      const actual = scryptSync(password, salt, 64);
      const expected = Buffer.from(hash, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
    encrypt(value) {
      if (!value) {
        return '';
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secretKey(secret), iv);
      const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
    },
    decrypt(payload) {
      if (!payload) {
        return '';
      }
      const [ivHex, tagHex, dataHex] = String(payload).split(':');
      const decipher = createDecipheriv('aes-256-gcm', secretKey(secret), Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataHex, 'hex')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

function loadSecret(file) {
  if (process.env.DIMADB_SECRET) {
    return process.env.DIMADB_SECRET;
  }
  if (existsSync(file)) {
    return readFileSync(file, 'utf8').trim();
  }
  const generated = randomBytes(32).toString('hex');
  writeFileSync(file, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
  return generated;
}

function secretKey(secret) {
  return createHash('sha256').update(secret).digest();
}
