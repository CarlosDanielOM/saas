import mongoose from 'mongoose';

const { ObjectId } = mongoose.Types;
const { EJSON } = mongoose.mongo.BSON;

export function createMongoHub(registry) {
  const connections = new Map();

  async function connFor(id) {
    registry.require(id, 'mongo');
    const cached = connections.get(id);
    if (cached) {
      return cached;
    }
    const conn = await mongoose.createConnection(registry.resolveUrl(registry.get(id)), {
      serverSelectionTimeoutMS: 8000,
    }).asPromise();
    connections.set(id, conn);
    return conn;
  }

  function dbFor(conn, name) {
    return name ? conn.useDb(name, { useCache: true }).db : conn.db;
  }

  return {
    drop(id) {
      const conn = connections.get(id);
      if (conn) {
        connections.delete(id);
        conn.close().catch(() => undefined);
      }
    },
    async ping(id) {
      const conn = await connFor(id);
      const result = await dbFor(conn, 'admin').command({ ping: 1 });
      return result.ok === 1 ? 'PONG' : JSON.stringify(result);
    },
    async databases(id) {
      const conn = await connFor(id);
      const { databases } = await dbFor(conn, 'admin').admin().listDatabases();
      return databases.map((item) => ({
        name: item.name,
        sizeOnDisk: item.sizeOnDisk,
        empty: Boolean(item.empty),
      }));
    },
    async collections(id, db) {
      requireName(db, 'db');
      const conn = await connFor(id);
      const items = await dbFor(conn, db).listCollections({}, { nameOnly: true }).toArray();
      return items.map((item) => ({ name: item.name, type: item.type || 'collection' }));
    },
    async docs(id, { db, collection, skip = 0, limit = 50, filter = '{}' } = {}) {
      requireName(db, 'db');
      requireName(collection, 'collection');
      const conn = await connFor(id);
      const parsed = parseFilter(filter);
      const col = dbFor(conn, db).collection(collection);
      const take = Math.min(Math.max(Number(limit) || 50, 1), 100);
      const from = Math.max(Number(skip) || 0, 0);
      const [items, total] = await Promise.all([
        col.find(parsed).skip(from).limit(take).toArray(),
        Object.keys(parsed).length ? col.countDocuments(parsed) : col.estimatedDocumentCount(),
      ]);
      return {
        db,
        collection,
        skip: from,
        limit: take,
        total,
        docs: items.map((doc) => ({
          id: idOf(doc),
          document: EJSON.serialize(doc),
        })),
      };
    },
    async inspect(id, { db, collection, docId }) {
      requireName(db, 'db');
      requireName(collection, 'collection');
      requireName(docId, 'id');
      const conn = await connFor(id);
      const doc = await dbFor(conn, db).collection(collection).findOne(idQuery(docId));
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
      const conn = await connFor(id);
      const value = decodeDocument(document);
      const result = await dbFor(conn, db).collection(collection).replaceOne(idQuery(docId), value);
      if (result.matchedCount === 0) {
        throw Object.assign(new Error('Document not found'), { status: 404 });
      }
      return this.inspect(id, { db, collection, docId });
    },
    async insert(id, { db, collection, document }) {
      requireName(db, 'db');
      requireName(collection, 'collection');
      const conn = await connFor(id);
      const value = decodeDocument(document);
      const result = await dbFor(conn, db).collection(collection).insertOne(value);
      return this.inspect(id, { db, collection, docId: String(result.insertedId) });
    },
    async del(id, { db, collection, docId }) {
      requireName(db, 'db');
      requireName(collection, 'collection');
      requireName(docId, 'id');
      const conn = await connFor(id);
      const result = await dbFor(conn, db).collection(collection).deleteOne(idQuery(docId));
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


