import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('cancelpredi sends a status accepted by the prediction endpoint', () => {
    const handler = readFileSync(new URL('./message.handler.ts', import.meta.url), 'utf8');
    const endpoint = readFileSync(new URL('../functions/predictions/end.prediction.ts', import.meta.url), 'utf8');

    const commandStatus = handler.match(/case 'cancelpredi':\s*const cancelPredictionResult = await indexCommands\.prediction\('([^']+)'/d)?.[1];
    const acceptedStatuses = [...endpoint.matchAll(/status !== '([^']+)'/g)].map(match => match[1]);

    assert.equal(commandStatus, 'CANCELED', 'Twitch requires CANCELED for prediction cancellation');
    assert.ok(acceptedStatuses.includes(commandStatus), 'the prediction endpoint must accept the command status');
});
