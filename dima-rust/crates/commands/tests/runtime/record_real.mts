// Records, read only, what `Commands.getCommandFromDB` finds over the real stored commands of the
// local production copy (`domdimabot`), for `tests/runtime_real_data.rs`.
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC node_modules/.bin/tsx \
//     "$REPO/dima-rust/crates/commands/tests/runtime/record_real.mts" \
//     "$REPO/dima-rust/crates/commands/tests/runtime/real_data.json"
//
// Every channel that has a non-keyword command is looked up with, per distinct stored `cmd` of
// that channel (non-keyword and keyword alike), the name itself, its upper case, `!` + name and
// name + `x`, plus two names nothing has. The fixture holds no name and no channel id: each
// lookup is the first 16 hex digits of SHA-256 of `channel \0 name`, with the `_id` found (or
// null). The lookups write their cache keys in Dragonfly logical database 11; the script deletes
// `{channel}:commands:*` there for every channel it read, before and after. MongoDB is only read.
import { readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

register(new URL('./stub_hooks.mjs', import.meta.url).href, import.meta.url);

const out = process.argv[2];
if (!out) throw new Error('usage: record_real.mts <out.json>');
const uri = process.env.DIMA_TEST_MONGO_URI;
const dragonflyAddress = process.env.DIMA_TEST_DRAGONFLY;
if (!uri || !dragonflyAddress) throw new Error('eval "$(dima-rust/tools/test-env)" first');
const [dfHost, dfPort] = dragonflyAddress.split(':');
process.env.DRAGONFLY_HOST = dfHost;
process.env.DRAGONFLY_PORT = `${dfPort}/11`;

const root = process.cwd();
const mongoose = (await import(pathToFileURL(path.join(root, 'node_modules/mongoose/index.js')).href)).default;
const imported = async (file: string) => import(pathToFileURL(path.join(root, 'src', file)).href);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const short = (channel: string, name: string) => sha(`${channel}\0${name}`).slice(0, 16);

const base = new URL(uri);
base.pathname = '/domdimabot';
await mongoose.connect(base.toString());
const { default: Commands } = await imported('classes/command.class.ts');
const { getDragonflyClient } = await imported('utils/databases/dragonfly.database.ts');
const redis = await getDragonflyClient('record_real');
const collection = mongoose.connection.db.collection('commands');

const channels: string[] = (await collection.distinct('channelID', { activation: { $ne: 'keyword' } }))
    .filter((c: unknown) => typeof c === 'string').sort();
const clean = async () => {
    for (const channel of channels) for (const key of await redis.keys(`${channel}:commands:*`)) await redis.del(key);
};
const lookups: Array<[string, string | null]> = [];
const census = {
    documents: await collection.countDocuments({}),
    lastId: String((await collection.find({}).sort({ _id: -1 }).limit(1).toArray())[0]?._id ?? ''),
};
try {
    await clean();
    for (const channel of channels) {
        const names = new Set<string>();
        for (const doc of await collection.find({ channelID: channel }, { projection: { cmd: 1 } }).toArray()) {
            for (const cmd of Array.isArray(doc.cmd) ? doc.cmd : [doc.cmd]) {
                if (typeof cmd !== 'string') continue;
                for (const variant of [cmd, cmd.toUpperCase(), `!${cmd}`, `${cmd}x`]) names.add(variant);
            }
        }
        names.add('zz-no-such-command');
        names.add('');
        for (const name of names) {
            const result = await Commands.getCommandFromDB(channel, name);
            lookups.push([short(channel, name), result.command ? String(result.command._id) : null]);
        }
    }
} finally {
    await clean();
    await redis.quit();
    await mongoose.disconnect();
}
writeFileSync(out, `${JSON.stringify({ census, channels: channels.length, lookups }, null, 0)}\n`);
console.log(`recorded ${lookups.length} lookups over ${channels.length} channels`);
