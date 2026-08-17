import { randomUUID } from 'node:crypto';

const SESSION_MS = 14 * 24 * 60 * 60 * 1000;

export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
  };
}

export function createAuth(store) {
  function pruneSessions() {
    const now = Date.now();
    const next = store.sessions().filter((row) => Date.parse(row.expiresAt) > now);
    if (next.length !== store.sessions().length) {
      store.saveSessions(next);
    }
    return next;
  }

  return {
    needsSetup() {
      return store.users().length === 0;
    },
    findUserByName(username) {
      const name = String(username || '').trim().toLowerCase();
      return store.users().find((row) => row.username === name) || null;
    },
    currentUser(req) {
      const cookies = parseCookieHeader(req);
      const sessionId = cookies.dimadb_session;
      if (!sessionId) {
        return null;
      }
      const session = pruneSessions().find((row) => row.id === sessionId);
      if (!session) {
        return null;
      }
      return store.users().find((row) => row.id === session.userId) || null;
    },
    createUser({ username, password, role = 'admin' }) {
      const name = String(username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,32}$/.test(name)) {
        throw Object.assign(new Error('Username must be 2-32 letters, numbers, or ._-'), { status: 400 });
      }
      if (String(password || '').length < 8) {
        throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });
      }
      if (store.users().some((row) => row.username === name)) {
        throw Object.assign(new Error('Username already exists'), { status: 409 });
      }
      const user = {
        id: randomUUID(),
        username: name,
        passwordHash: store.hashPassword(password),
        role,
        createdAt: new Date().toISOString(),
      };
      store.saveUsers([...store.users(), user]);
      return user;
    },
    login(username, password) {
      const user = this.findUserByName(username);
      if (!user || !store.verifyPassword(password, user.passwordHash)) {
        throw Object.assign(new Error('Invalid username or password'), { status: 401 });
      }
      const session = {
        id: randomUUID(),
        userId: user.id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + SESSION_MS).toISOString(),
      };
      store.saveSessions([...pruneSessions(), session]);
      return { user, session };
    },
    logout(req) {
      const cookies = parseCookieHeader(req);
      const sessionId = cookies.dimadb_session;
      if (!sessionId) {
        return;
      }
      store.saveSessions(store.sessions().filter((row) => row.id !== sessionId));
    },
  };
}

function parseCookieHeader(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}
