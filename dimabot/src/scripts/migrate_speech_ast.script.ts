/**
 * One-time release migration. Prepare a private backup, review its summary, copy it
 * off-container, then apply that exact plan. Never re-prepare after users start
 * editing normal AST commands. Apply/rollback use compare-and-set to protect edits.
 *
 * node dist/scripts/migrate_speech_ast.script.js --prepare /tmp/speech-ast.json
 * node dist/scripts/migrate_speech_ast.script.js --apply /tmp/speech-ast.json
 * node dist/scripts/migrate_speech_ast.script.js --rollback /tmp/speech-ast.json
 */
import fs from 'node:fs/promises';
import { Types } from 'mongoose';
import { CommandsSchema } from '../schemas/commands.schema.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { migrateLegacySpeechTemplate } from '../utils/tts/speech_template.util.js';
import { writeCommandWithCooldown, CommandCooldownError } from '../utils/command_cooldown_write.js';
import { parse } from '../utils/ast_parser/parser.js';

type Values = { message?: string; reserved?: boolean; cooldown?: number };
type Entry = { id: string; channelID: string; cmd: string; func: string; previous: Values; next: Values };
type Plan = { version: 1; database: string; records: Entry[] };
const fields = ['message', 'reserved', 'cooldown'] as const;
const match = (values: Values) => Object.fromEntries(fields.map(field =>
    [field, values[field] === undefined ? { $exists: false } : values[field]]));

async function run(): Promise<void> {
    const [mode, file] = process.argv.slice(2);
    if (!['--prepare', '--apply', '--rollback'].includes(mode) || !file) throw new Error('Expected --prepare|--apply|--rollback BACKUP_FILE');
    const mongo = await getMongoDBConnection('migrate-speech-ast');
    const database = mongo.connection.db!.databaseName;
    if (mode === '--prepare') {
        const documents = await CommandsSchema.collection.find({ func: { $in: ['speach', 'speech'] } }).toArray();
        const records: Entry[] = [];
        const assignedZeroSlots = new Set<string>();
        for (const document of documents) {
            const previous: Values = {};
            for (const field of fields) if (document[field] !== undefined) (previous as Record<string, unknown>)[field] = document[field];
            const next: Values = { ...previous, message: migrateLegacySpeechTemplate(document.message), reserved: false };
            const parsed = parse(next.message!);
            if (parsed.error) throw new Error(`Cannot migrate malformed template in command ${document._id}`);
            // Preserve an editable command that already owns the zero-CD allowance.
            if (document.cooldown === 0 && (assignedZeroSlots.has(document.channelID) || await CommandsSchema.collection.countDocuments({
                channelID: document.channelID, _id: { $ne: document._id }, reserved: { $ne: true }, cooldown: 0
            }))) next.cooldown = 5;
            if (next.cooldown === 0) assignedZeroSlots.add(document.channelID);
            if (JSON.stringify(previous) !== JSON.stringify(next)) records.push({
                id: String(document._id), channelID: document.channelID, cmd: document.cmd,
                func: document.func, previous, next
            });
        }
        await fs.writeFile(file, JSON.stringify({ version: 1, database, records } satisfies Plan, null, 2), { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ prepared: records.length,
            messages: records.filter(r => r.previous.message !== r.next.message).length,
            madeEditable: records.filter(r => r.previous.reserved !== r.next.reserved).length,
            cooldownSlotsPreserved: records.filter(r => r.previous.cooldown !== r.next.cooldown).length }));
    } else {
        const plan = JSON.parse(await fs.readFile(file, 'utf8')) as Plan;
        if (plan.version !== 1 || plan.database !== database || !Array.isArray(plan.records)) throw new Error('Backup database/version mismatch');
        const redis = await getDragonflyClient('migrate-speech-ast');
        let changed = 0, unchanged = 0, conflicts = 0;
        for (const entry of plan.records) {
            if (!['speach', 'speech'].includes(entry.func)) throw new Error('Unexpected command function in backup');
            const before = mode === '--apply' ? entry.previous : entry.next;
            const after = mode === '--apply' ? entry.next : entry.previous;
            const identity = { _id: new Types.ObjectId(entry.id), channelID: entry.channelID, cmd: entry.cmd, func: entry.func };
            const set = Object.fromEntries(fields.filter(field => after[field] !== undefined).map(field => [field, after[field]]));
            const unset = Object.fromEntries(fields.filter(field => after[field] === undefined).map(field => [field, '']));
            let result;
            try {
                const write = () => CommandsSchema.collection.updateOne({ ...identity, ...match(before) }, {
                    $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {})
                });
                result = mode === '--rollback' ? await write() : await writeCommandWithCooldown(entry.channelID, after.cooldown,
                    { _id: identity._id, cooldown: before.cooldown, reserved: after.reserved }, write);
            } catch (error) {
                if (!(error instanceof CommandCooldownError)) throw error;
                conflicts += 1;
                continue;
            }
            if (result.matchedCount) changed += 1;
            else if (await CommandsSchema.collection.countDocuments({ ...identity, ...match(after) })) unchanged += 1;
            else { conflicts += 1; continue; }
            await redis.del(`${entry.channelID}:commands:${entry.cmd}`);
        }
        console.log(JSON.stringify({ mode, changed, unchanged, conflicts }));
        await redis.quit();
        if (conflicts) process.exitCode = 1;
    }
    await mongo.disconnect();
}
run().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
