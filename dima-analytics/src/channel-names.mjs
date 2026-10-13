import { MongoClient } from 'mongodb';

const MAX_IDS = 500;
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
const publicName = name => typeof name === 'string' && /^[a-zA-Z0-9_]{1,25}$/.test(name) ? name : null;

// Resolve only IDs already authorized by an analytics query. Read the public
// account name field, never tokens, email, or complete account/cache objects.
export function createChannelNames({ redis, mongoUrl, mongo: suppliedMongo, now = Date.now }) {
  const mongo = suppliedMongo || (mongoUrl ? new MongoClient(mongoUrl, {
    maxPoolSize: 1, serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500, socketTimeoutMS: 1500
  }) : null);
  const cache = new Map();
  async function resolve(ids) {
    const selected = [...new Set(ids.filter(validId))].slice(0, MAX_IDS);
    const result = {}, missing = [];
    for (const id of selected) {
      const saved = cache.get(id);
      if (saved && saved.until > now()) result[id] = saved.name;
      else missing.push(id);
    }
    // Pipeline bounded groups; a failed name lookup never fails the metrics query.
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50);
      try {
        const pipeline = redis.multi();
        chunk.forEach(id => pipeline.hGet(`accounts:twitch:${id}:data`, 'name'));
        const names = await pipeline.exec();
        chunk.forEach((id, index) => { result[id] = publicName(names[index]); });
      } catch { chunk.forEach(id => { result[id] = null; }); }
    }
    const uncached = missing.filter(id => !result[id]);
    if (mongo && uncached.length) {
      try {
        const users = await mongo.db().collection('users').find(
          { accounts: { $elemMatch: { type: 'twitch', id: { $in: uncached } } } },
          { projection: { _id: 0, 'accounts.type': 1, 'accounts.id': 1, 'accounts.name': 1 }, maxTimeMS: 1000 }
        ).limit(MAX_IDS).toArray();
        const wanted = new Set(uncached);
        for (const user of users) for (const account of user.accounts || []) {
          if (account.type === 'twitch' && wanted.has(account.id)) result[account.id] = publicName(account.name);
        }
      } catch { /* Leave unknown IDs visible if the account directory is unavailable. */ }
    }
    for (const id of missing) {
      cache.delete(id);
      cache.set(id, { name: result[id] || null, until: now() + (result[id] ? 60000 : 15000) });
    }
    while (cache.size > 1000) cache.delete(cache.keys().next().value);
    return result;
  }
  return { resolve, close: async () => { await mongo?.close(); } };
}
