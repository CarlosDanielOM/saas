import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { CommandsSchema, type ICommands } from '../../schemas/commands.schema.js';
import { ensureReservedCommands, getReservedCommandsPayload } from './command_defaults.service.js';

const mongoUri = process.env.COMMAND_DEFAULTS_TEST_MONGO_URI;

test('concurrent default-command seeding creates each command exactly once', {
    skip: mongoUri ? false : 'COMMAND_DEFAULTS_TEST_MONGO_URI is required'
}, async (t) => {
    assert.ok(mongoUri);
    await mongoose.connect(mongoUri);
    t.after(async () => {
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
    });

    const channelID = `test-${randomUUID()}`;
    const expectedCount = getReservedCommandsPayload().commands.length;
    const originalSave = CommandsSchema.prototype.save;
    let firstSaveArrivals = 0;
    let releaseFirstSaves!: () => void;
    const firstSavesReady = new Promise<void>((resolve) => {
        releaseFirstSaves = resolve;
    });

    t.mock.method(CommandsSchema.prototype, 'save', async function (
        this: mongoose.HydratedDocument<ICommands>,
        ...args: Parameters<typeof originalSave>
    ) {
        if (this.channelID === channelID && firstSaveArrivals < 2) {
            firstSaveArrivals += 1;
            if (firstSaveArrivals === 2) {
                releaseFirstSaves();
            }
            await firstSavesReady;
        }

        return originalSave.apply(this, args);
    });

    const createdCounts = await Promise.all([
        ensureReservedCommands(channelID, 'race-test'),
        ensureReservedCommands(channelID, 'race-test')
    ]);

    assert.equal(firstSaveArrivals, 2, 'the test must force both seeders past the initial existence check');
    assert.equal(createdCounts[0] + createdCounts[1], expectedCount);
    assert.equal(await CommandsSchema.countDocuments({ channelID }), expectedCount);

    const duplicateFunctions = await CommandsSchema.aggregate([
        { $match: { channelID } },
        { $group: { _id: '$func', count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } }
    ]);
    assert.deepEqual(duplicateFunctions, []);
});
