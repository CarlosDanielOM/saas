import { MongoClient } from 'mongodb';
import { pathToFileURL } from 'node:url';
import { planGlobalAstVariables, type LegacyAstVariableDocument } from '../utils/ast_variable_migration.js';

async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    if (process.argv.slice(2).some((arg) => arg !== '--apply')) throw new Error('Usage: migrate_ast_variables_global.script.js [--apply]');
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');

    const client = new MongoClient(process.env.MONGO_URI);
    try {
        await client.connect();
        const collection = client.db().collection<LegacyAstVariableDocument>('astvariables');
        const rows = await collection.find({ scopeType: { $ne: 'global' } }).toArray();
        const plan = planGlobalAstVariables(rows);
        const variableCount = plan.reduce((count, row) => count + Object.keys(row.variables).length, 0);
        console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', legacyDocuments: rows.length,
            globalDocuments: plan.length, variables: variableCount }));
        if (!apply) return;

        let copied = 0;
        for (const row of plan) {
            const identity = { channelID: row.channelID, scopeType: 'global', scopeName: 'global', userId: row.userId };
            await collection.updateOne(identity, { $setOnInsert: { ...row, variables: {} } }, { upsert: true });
            for (const [name, value] of Object.entries(row.variables)) {
                const result = await collection.updateOne(
                    { ...identity, [`variables.${name}`]: { $exists: false } },
                    { $set: { [`variables.${name}`]: value } }
                );
                copied += result.modifiedCount;
            }
        }
        console.log(JSON.stringify({ copied, preservedGlobalValues: variableCount - copied }));
    } finally {
        await client.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => { console.error(error); process.exitCode = 1; });
}
