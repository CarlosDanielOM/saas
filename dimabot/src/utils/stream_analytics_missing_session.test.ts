import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamSessionSchema } from '../schemas/stream_session.schema.js';
import { incrementSessionMetricAtEventTime } from './stream_session_event_projection.js';

test('missing stream sessions remain benign for non-journaled event-time metrics', async (context) => {
    const originalFindOneAndUpdate = StreamSessionSchema.findOneAndUpdate;

    (StreamSessionSchema as any).findOneAndUpdate = () => ({
        select() { return this; },
        lean: async () => null
    });

    context.after(() => {
        StreamSessionSchema.findOneAndUpdate = originalFindOneAndUpdate;
    });

    const applied = await incrementSessionMetricAtEventTime({
        channelID: 'channel-1',
        occurredAt: new Date(),
        field: 'follows',
        quantity: 1
    });
    assert.equal(applied, false);
});
