import { randomUUID } from 'node:crypto';

export function createConnectionRegistry(store) {
  function envConnections() {
    return [
      ...envRows('DIMADB_REDIS_', 'redis', 'env:'),
      ...envRows('DIMADB_MONGO_', 'mongo', 'env:mongo:'),
    ];
  }

  function envRows(prefix, engine, idPrefix) {
    return Object.entries(process.env)
      .filter(([key, value]) => key.startsWith(prefix) && value)
      .map(([key, value]) => ({
        id: `${idPrefix}${key.slice(prefix.length).toLowerCase()}`,
        name: key.slice(prefix.length).replaceAll('_', ' ').toLowerCase(),
        url: String(value),
        engine,
        source: 'env',
      }));
  }

  function localConnections() {
    return store.connections().map((row) => ({
      ...row,
      engine: row.engine === 'mongo' ? 'mongo' : 'redis',
      source: 'local',
    }));
  }

  function all() {
    return [...envConnections(), ...localConnections()];
  }

  function publicConnection(row) {
    return {
      id: row.id,
      name: row.name,
      url: maskUrl(resolveUrl(row)),
      source: row.source,
      engine: row.engine === 'mongo' ? 'mongo' : 'redis',
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

  function get(id) {
    return all().find((row) => row.id === id) || null;
  }

  return {
    list() {
      return all().map(publicConnection);
    },
    get,
    require(id, engine) {
      const row = get(id);
      if (!row) {
        throw Object.assign(new Error('Connection not found'), { status: 404 });
      }
      if (engine && (row.engine === 'mongo' ? 'mongo' : 'redis') !== engine) {
        throw Object.assign(new Error(`Not a ${engine} connection`), { status: 409 });
      }
      return row;
    },
    resolveUrl,
    add({ name, url, engine }) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw Object.assign(new Error('Invalid URL'), { status: 400 });
      }
      const detected = engineFromProtocol(parsed.protocol, engine);
      const password = parsed.password;
      parsed.password = '';
      const row = {
        id: randomUUID(),
        name: String(name || parsed.hostname || detected).trim(),
        url: parsed.toString(),
        engine: detected,
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
    },
  };
}

function engineFromProtocol(protocol, requested) {
  const fromUrl = protocol === 'mongodb:' || protocol === 'mongodb+srv:'
    ? 'mongo'
    : protocol === 'redis:' || protocol === 'rediss:'
      ? 'redis'
      : null;
  if (!fromUrl) {
    throw Object.assign(new Error('URL must start with redis://, rediss://, mongodb://, or mongodb+srv://'), { status: 400 });
  }
  if (requested && requested !== fromUrl) {
    throw Object.assign(new Error(`URL does not match ${requested}`), { status: 400 });
  }
  return fromUrl;
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
