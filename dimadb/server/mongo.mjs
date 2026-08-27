import { EJSON, MongoClient, ObjectId } from 'mongodb';

export function createMongoHub(registry) {
  const clients = new Map();

  async function clientFor(id) {
    registry.require(id, 'mongo');
    const cached = clients.get(id);
    if (cached) {
      return cached;
    }
    const client = new MongoClient(registry.resolveUrl(registry.get(id)), {
      serverSelectionTimeoutMS: 8000,
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
        client.close().catch(() => undefined);
      }
    },
    async ping(id) {
      const client = await clientFor(id);
      const result = await client.db('admin').command({ ping: 1 });
      return result.ok === 1 ? 'PONG' : JSON.stringify(result);
    },
    async databases(id) {
      const client = await clientFor(id);
      const { databases } = await client.db().admin().listDatabases();
      return databases.map((item) => ({
        name: item.name,
        sizeOnDisk: item.sizeOnDisk,
        empty: Boolean(item.empty),
      }));
    },
    async collections(id, db) {
      requireName(db, 'db');
      const client = await clientFor(id);
      const items = await client.db(db).listCollections({}, { nameOnly: true }).toArray();
      return items.map((item) => ({ name: item.name, type: item.type || 'collection' }));
    },
    async docs(id, { db, collection, skip = 0, limit = 50, filter = '{}' } = {}) {
      requireName(db, 'db');
      requireName(collection, 'collection');
      const client = await clientFor(id);
      const parsed = parseFilter(filter);
      const col = client.db(db).collection(collection);
      const take = Math.min(Math.max(Number(limit) || 50, 1), 100);
      const from = Math.max(Number(skip) || 0, 0);
      const [items, total] = await Promise.all([
        col.find(parsed).skip(from).limit(take).toArray(),
        col.estimatedDocumentCount(),
      ]);
      return {
        db,
        collection,
        skip: from,
        limit: take,
        total,
        docs: items.map((doc) => ({
          id: idOf(doc),
          preview: preview(doc),
        })),
      };
    },
    async inspect(id, { db, collection, docId }) {
      requireName(db, 'db');
      requireName(collection, 'collection');
      requireName(docId, 'id');
      const client = await clientFor(id);
      const doc = await client.db(db).collection(collection).findOne(idQuery(docId));
      if (!doc) {
        throw Object.assign(new Error('Document not found'), { status: 404 });
      }
      return {
        db,
        collection,
        id: idOf(doc),
        document: EJSON.serialize(doc),
      };
    },
    async save(id, { db, collection, docId, document }) {
      requireName(db, 'db');
      requireName(collection, 'collection');
      requireName(docId, 'id');
      const client = await clientFor(id);
      const value = decodeDocument(document);
      const result = await client.db(db).collection(collection).replaceOne(idQuery(docId), value);
      if (result.matchedCount === 0) {
        throw Object.assign(new Error('Document not found'), { status: 404 });
      }
      return this.inspect(id, { db, collection, docId });
    },
    async insert(id, { db, collection, document }) {
      requireName(db, 'db');
      requireName(collection, 'collection');
      const client = await clientFor(id);
      const value = decodeDocument(document);
      const result = await client.db(db).collection(collection).insertOne(value);
      return this.inspect(id, { db, collection, docId: String(result.insertedId) });
    },
    async del(id, { db, collection, docId }) {
      requireName(db, 'db');
      requireName(collection, 'collection');
      requireName(docId, 'id');
      const client = await clientFor(id);
      const result = await client.db(db).collection(collection).deleteOne(idQuery(docId));
      return { deleted: result.deletedCount };
    },
  };
}

function requireName(value, label) {
  if (!String(value || '').trim()) {
    throw Object.assign(new Error(`${label} is required`), { status: 400 });
  }
}

function parseFilter(raw) {
  const text = String(raw || '').trim() || '{}';
  try {
    return EJSON.deserialize(JSON.parse(text));
  } catch {
    throw Object.assign(new Error('Invalid filter JSON'), { status: 400 });
  }
}

function decodeDocument(document) {
  try {
    const value = typeof document === 'string' ? JSON.parse(document) : document;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('document must be an object');
    }
    return EJSON.deserialize(value);
  } catch (error) {
    throw Object.assign(new Error(error.message || 'Invalid document JSON'), { status: 400 });
  }
}

function idOf(doc) {
  const id = doc?._id;
  return id == null ? '' : String(id);
}

function idQuery(docId) {
  const value = String(docId);
  if (ObjectId.isValid(value) && String(new ObjectId(value)) === value) {
    return { _id: new ObjectId(value) };
  }
  return { _id: value };
}

function preview(doc) {
  try {
    const text = JSON.stringify(EJSON.serialize(doc));
    return text.length > 96 ? `${text.slice(0, 96)}…` : text;
  } catch {
    return idOf(doc);
  }
}
