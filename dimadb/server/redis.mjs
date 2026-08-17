import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

const DANGEROUS = new Set([
  'FLUSHALL', 'FLUSHDB', 'EVAL', 'EVALSHA', 'CONFIG', 'DEBUG', 'SHUTDOWN',
  'REPLICAOF', 'SLAVEOF', 'MODULE', 'ACL', 'SWAPDB', 'MIGRATE', 'RESTORE',
]);

export function createRedisHub(store) {
  const clients = new Map();

  function envConnections() {
    return Object.entries(process.env)
      .filter(([key, value]) => key.startsWith('DIMADB_REDIS_') && value)
      .map(([key, value]) => ({
        id: `env:${key.slice('DIMADB_REDIS_'.length).toLowerCase()}`,
        name: key.slice('DIMADB_REDIS_'.length).replaceAll('_', ' ').toLowerCase(),
        url: String(value),
        source: 'env',
      }));
  }

  function localConnections() {
    return store.connections().map((row) => ({
      ...row,
      source: 'local',
    }));
  }

  function allConnections() {
    return [...envConnections(), ...localConnections()];
  }

  function publicConnection(row) {
    return {
      id: row.id,
      name: row.name,
      url: maskUrl(resolveUrl(row)),
      source: row.source,
    };
  }

  function resolveUrl(row) {
    if (row.source === 'env') {
      return row.url;
    }
    if (row.passwordEnc) {
      return injectPassword(row.url, store.decrypt(row.passwordEnc));
    }
    return row.url;
  }

  function getConnection(id) {
    return allConnections().find((row) => row.id === id) || null;
  }

  async function clientFor(id) {
    const connection = getConnection(id);
    if (!connection) {
      throw Object.assign(new Error('Connection not found'), { status: 404 });
    }
    const cached = clients.get(id);
    if (cached) {
      return cached;
    }
    const client = createClient({ url: resolveUrl(connection) });
    client.on('error', (error) => {
      console.error(`redis ${id}`, error.message);
    });
    await client.connect();
    clients.set(id, client);
    return client;
  }

  return {
    list() {
      return allConnections().map(publicConnection);
    },
    add({ name, url }) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
        throw Object.assign(new Error('URL must start with redis:// or rediss://'), { status: 400 });
      }
      const password = parsed.password;
      parsed.password = '';
      const row = {
        id: randomUUID(),
        name: String(name || parsed.hostname || 'redis').trim(),
        url: parsed.toString(),
        passwordEnc: password ? store.encrypt(password) : '',
        createdAt: new Date().toISOString(),
      };
      store.saveConnections([...store.connections(), row]);
      return publicConnection({ ...row, source: 'local' });
    },
    remove(id) {
      const row = store.connections().find((item) => item.id === id);
      if (!row) {
        throw Object.assign(new Error('Local connection not found'), { status: 404 });
      }
      store.saveConnections(store.connections().filter((item) => item.id !== id));
      const client = clients.get(id);
      if (client) {
        clients.delete(id);
        client.quit().catch(() => undefined);
      }
    },
    async ping(id) {
      const client = await clientFor(id);
      return client.ping();
    },
    async scan(id, { cursor = '0', match = '*', count = 50 } = {}) {
      const client = await clientFor(id);
      const result = await client.scan(String(cursor), {
        MATCH: match || '*',
        COUNT: Math.min(Number(count) || 50, 200),
      });
      const keys = [];
      for (const key of result.keys) {
        const [type, ttl] = await Promise.all([client.type(key), client.ttl(key)]);
        keys.push({ name: key, type, ttl });
      }
      return { cursor: result.cursor, keys };
    },
    async inspect(id, key) {
      const client = await clientFor(id);
      const type = await client.type(key);
      if (type === 'none') {
        throw Object.assign(new Error('Key not found'), { status: 404 });
      }
      const ttl = await client.ttl(key);
      const value = await readValue(client, key, type);
      return { key, type, ttl, value };
    },
    async setString(id, key, value) {
      const client = await clientFor(id);
      await client.set(key, String(value ?? ''));
      return this.inspect(id, key);
    },
    async del(id, key) {
      const client = await clientFor(id);
      return client.del(key);
    },
    async command(id, args, confirm = false) {
      const command = String(args[0] || '').toUpperCase();
      if (DANGEROUS.has(command) && !confirm) {
        throw Object.assign(new Error(`${command} needs confirm: true`), { status: 409, code: 'needs_confirm' });
      }
      const client = await clientFor(id);
      return client.sendCommand(args.map(String));
    },
  };
}

function maskUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function injectPassword(url, password) {
  const parsed = new URL(url);
  parsed.password = password;
  return parsed.toString();
}

async function readValue(client, key, type) {
  switch (type) {
    case 'string':
      return client.get(key);
    case 'hash':
      return client.hGetAll(key);
    case 'list':
      return client.lRange(key, 0, 199);
    case 'set':
      return client.sMembers(key);
    case 'zset':
      return client.zRangeWithScores(key, 0, 199);
    case 'stream':
      return client.xRange(key, '-', '+', { COUNT: 50 });
    default:
      return `[unsupported type: ${type}]`;
  }
}
