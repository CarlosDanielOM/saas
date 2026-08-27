import { createClient } from 'redis';

const DANGEROUS = new Set([
  'FLUSHALL', 'FLUSHDB', 'EVAL', 'EVALSHA', 'CONFIG', 'DEBUG', 'SHUTDOWN',
  'REPLICAOF', 'SLAVEOF', 'MODULE', 'ACL', 'SWAPDB', 'MIGRATE', 'RESTORE',
]);

const MUTATE_OPS = new Set([
  'ttl', 'hset', 'hdel', 'lset', 'lpush', 'rpush', 'ldel', 'sadd', 'srem', 'zadd', 'zrem',
]);

export function createRedisHub(registry) {
  const clients = new Map();

  async function clientFor(id) {
    const connection = registry.require(id, 'redis');
    const cached = clients.get(id);
    if (cached) {
      return cached;
    }
    const client = createClient({ url: registry.resolveUrl(connection) });
    client.on('error', (error) => {
      console.error(`redis ${id}`, error.message);
    });
    await client.connect();
    clients.set(id, client);
    return client;
  }

  return {
    drop(id) {
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
    async tree(id, { prefix = '', query = '', cursor = '0' } = {}) {
      const client = await clientFor(id);
      const match = treeMatch(prefix, query);
      const folders = new Map();
      const leafSet = new Set();
      let nextCursor = String(cursor || '0');
      let scanned = 0;
      const maxKeys = 40000;
      const maxRounds = 120;

      for (let round = 0; round < maxRounds && scanned < maxKeys; round += 1) {
        const result = await client.scan(nextCursor, {
          MATCH: match,
          COUNT: 1000,
        });
        nextCursor = String(result.cursor);
        scanned += result.keys.length;

        for (const key of result.keys) {
          const node = splitTreeNode(String(key), prefix);
          if (node.kind === 'folder') {
            const current = folders.get(node.prefix) || { prefix: node.prefix, label: node.label, seen: 0 };
            current.seen += 1;
            folders.set(node.prefix, current);
          } else {
            leafSet.add(node.name);
          }
        }

        if (nextCursor === '0') {
          break;
        }
      }

      return {
        prefix,
        match,
        cursor: nextCursor,
        folders: [...folders.values()].sort((a, b) => a.label.localeCompare(b.label)),
        keys: [...leafSet].sort().map((name) => ({ name })),
        scanned,
      };
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
      const type = await client.type(key);
      if (type !== 'none' && type !== 'string') {
        throw Object.assign(new Error(`Cannot SET a ${type} key`), { status: 409 });
      }
      if (type === 'string') {
        await client.set(key, String(value ?? ''), { KEEPTTL: true });
      } else {
        await client.set(key, String(value ?? ''));
      }
      return this.inspect(id, key);
    },
    async create(id, body) {
      const key = String(body.key || '');
      const type = String(body.type || 'string');
      if (!key) {
        throw Object.assign(new Error('key is required'), { status: 400 });
      }
      const client = await clientFor(id);
      const existing = await client.type(key);
      if (existing !== 'none') {
        throw Object.assign(new Error('Key already exists'), { status: 409 });
      }
      switch (type) {
        case 'string':
          await client.set(key, String(body.value ?? ''));
          break;
        case 'hash': {
          const field = String(body.field || '');
          if (!field) {
            throw Object.assign(new Error('field is required'), { status: 400 });
          }
          await client.hSet(key, field, String(body.value ?? ''));
          break;
        }
        case 'list':
          await client.rPush(key, String(body.value ?? ''));
          break;
        case 'set':
          await client.sAdd(key, String(body.value ?? ''));
          break;
        case 'zset':
          await client.zAdd(key, {
            score: Number(body.score) || 0,
            value: String(body.value ?? ''),
          });
          break;
        default:
          throw Object.assign(new Error('Unsupported type'), { status: 400 });
      }
      return this.inspect(id, key);
    },
    async mutate(id, body) {
      const key = String(body.key || '');
      const op = String(body.op || '');
      if (!key) {
        throw Object.assign(new Error('key is required'), { status: 400 });
      }
      if (!MUTATE_OPS.has(op)) {
        throw Object.assign(new Error('unknown op'), { status: 400 });
      }
      const client = await clientFor(id);
      const type = await client.type(key);
      if (type === 'none') {
        throw Object.assign(new Error('Key not found'), { status: 404 });
      }
      await applyMutate(client, key, type, op, body);
      return inspectOrGone(this, id, key);
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

function treeMatch(prefix, query) {
  const q = String(query || '').trim();
  if (prefix) {
    return `${prefix}*`;
  }
  if (!q || q === '*') {
    return '*';
  }
  if (q.includes('*')) {
    return q;
  }
  return `*${q}*`;
}

function splitTreeNode(key, prefix) {
  const rest = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
  const index = rest.indexOf(':');
  if (index === -1) {
    return { kind: 'key', name: key };
  }
  const label = rest.slice(0, index);
  return { kind: 'folder', prefix: `${prefix}${label}:`, label };
}

function requireType(actual, expected) {
  if (actual !== expected) {
    throw Object.assign(new Error(`Expected ${expected}, got ${actual}`), { status: 409 });
  }
}

async function inspectOrGone(hub, id, key) {
  try {
    return await hub.inspect(id, key);
  } catch (error) {
    if (error.status === 404) {
      return { key, type: 'none', ttl: -2, value: null };
    }
    throw error;
  }
}

async function applyMutate(client, key, type, op, body) {
  switch (op) {
    case 'ttl': {
      if (body.ttl === undefined || body.ttl === null || Number(body.ttl) === -1) {
        await client.persist(key);
        return;
      }
      const ttl = Number(body.ttl);
      if (!Number.isInteger(ttl) || ttl < 1) {
        throw Object.assign(new Error('ttl must be a positive integer or -1'), { status: 400 });
      }
      await client.expire(key, ttl);
      return;
    }
    case 'hset': {
      requireType(type, 'hash');
      const field = String(body.field ?? '');
      if (!field) {
        throw Object.assign(new Error('field is required'), { status: 400 });
      }
      await client.hSet(key, field, String(body.value ?? ''));
      const renameFrom = body.renameFrom == null ? '' : String(body.renameFrom);
      if (renameFrom && renameFrom !== field) {
        await client.hDel(key, renameFrom);
      }
      return;
    }
    case 'hdel': {
      requireType(type, 'hash');
      const field = String(body.field ?? '');
      if (!field) {
        throw Object.assign(new Error('field is required'), { status: 400 });
      }
      await client.hDel(key, field);
      return;
    }
    case 'lset': {
      requireType(type, 'list');
      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 0) {
        throw Object.assign(new Error('index is required'), { status: 400 });
      }
      await client.lSet(key, index, String(body.value ?? ''));
      return;
    }
    case 'lpush':
    case 'rpush': {
      requireType(type, 'list');
      if (op === 'lpush') {
        await client.lPush(key, String(body.value ?? ''));
      } else {
        await client.rPush(key, String(body.value ?? ''));
      }
      return;
    }
    case 'ldel': {
      requireType(type, 'list');
      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 0) {
        throw Object.assign(new Error('index is required'), { status: 400 });
      }
      const marker = `__dimadb_del_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await client.lSet(key, index, marker);
      await client.lRem(key, 1, marker);
      return;
    }
    case 'sadd':
    case 'srem': {
      requireType(type, 'set');
      const member = String(body.member ?? body.value ?? '');
      if (!member) {
        throw Object.assign(new Error('member is required'), { status: 400 });
      }
      if (op === 'sadd') {
        await client.sAdd(key, member);
      } else {
        await client.sRem(key, member);
      }
      return;
    }
    case 'zadd':
    case 'zrem': {
      requireType(type, 'zset');
      const member = String(body.member ?? body.value ?? '');
      if (!member) {
        throw Object.assign(new Error('member is required'), { status: 400 });
      }
      if (op === 'zadd') {
        await client.zAdd(key, { score: Number(body.score) || 0, value: member });
      } else {
        await client.zRem(key, member);
      }
    }
  }
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
