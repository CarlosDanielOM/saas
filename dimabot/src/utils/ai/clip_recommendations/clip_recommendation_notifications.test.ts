import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import { ClipRecommendationSchema, type IClipRecommendation } from '../../../schemas/clip_recommendation.schema.js';
import type { IUsers } from '../../../schemas/users.schema.js';
import { renderEmail, type RenderedEmailPayload } from '../../email/email.service.js';
import { sendClipCompletionNotification } from './clip_recommendation_notifications.js';

const payload: RenderedEmailPayload = {
    from: 'Clips <clips@example.com>',
    to: ['original@example.com'],
    subject: 'Original subject',
    html: '<p>Original body and footer</p>',
    text: 'Original body and footer'
};

function fixture(overrides: Partial<IClipRecommendation> = {}) {
    let persisted = JSON.parse(JSON.stringify({
        _id: new Types.ObjectId(),
        channelID: 'channel-123',
        vodUrl: 'https://www.twitch.tv/videos/123',
        queueJobID: 'queue-job-123',
        approvedCount: 3,
        notificationStatus: 'pending',
        ...overrides
    }));
    const saves: IClipRecommendation[] = [];
    const reload = () => {
        const rec = ClipRecommendationSchema.hydrate(persisted);
        rec.save = async () => {
            await rec.validate();
            persisted = JSON.parse(JSON.stringify(rec.toObject()));
            saves.push(ClipRecommendationSchema.hydrate(persisted).toObject());
            return rec;
        };
        return rec;
    };
    const user = {
        email: 'fallback@example.com',
        name: 'Original User',
        language: 'en',
        accounts: [{ type: 'twitch', id: 'channel-123', name: 'Original Account', email: 'original@example.com' }]
    } as IUsers;
    return { rec: reload(), reload, saves, user };
}

test('retry reuses the persisted rendered payload and key despite user and template changes', async () => {
    const { rec, reload, saves, user } = fixture();
    let renderCount = 0;
    let footer = 'Original dynamic footer';
    let from = payload.from;
    const deliveries: { payload: RenderedEmailPayload; key?: string }[] = [];
    const deps = {
        renderEmail: async (options: Parameters<typeof renderEmail>[0]) => {
            renderCount++;
            const rendered = await renderEmail({ ...options, from });
            return { ...rendered, html: `${rendered.html}<p>${footer}</p>`, text: `${rendered.text}\n${footer}` };
        },
        sendRenderedEmail: async (rendered: RenderedEmailPayload, key?: string) => {
            const snapshot = JSON.parse(JSON.stringify(rendered));
            assert.deepEqual(saves.at(-1)?.notificationPayload, snapshot);
            assert.equal(saves.at(-1)?.notificationStatus, 'pending');
            deliveries.push({ payload: snapshot, key });
            return { error: deliveries.length === 1, message: 'Temporary provider failure' };
        }
    };

    await sendClipCompletionNotification(rec, user, 'channel-123', 'original-channel', deps);
    assert.equal(rec.notificationStatus, 'failed');
    user.email = 'changed@example.com';
    user.accounts[0].email = 'changed-account@example.com';
    user.accounts[0].name = 'Changed Account';
    user.language = 'es';
    user.name = 'Changed User';
    footer = 'Different dynamic footer';
    from = 'Changed Sender <changed@example.com>';
    const retried = reload();
    retried.approvedCount = 99;
    await sendClipCompletionNotification(retried, user, 'channel-123', 'changed-channel', deps);

    assert.equal(renderCount, 1);
    assert.equal(deliveries.length, 2);
    assert.deepEqual(deliveries[1], deliveries[0]);
    assert.equal(deliveries[0].key, 'clip-recommendation-complete:queue-job-123');
    assert.deepEqual(deliveries[0].payload.to, ['original@example.com']);
    assert.equal(deliveries[0].payload.from, payload.from);
    assert.match(deliveries[0].payload.html, /original-channel/);
    assert.match(deliveries[0].payload.text, /Original dynamic footer/);
    assert.equal(reload().notificationStatus, 'sent');
});

test('a failed snapshot save prevents the first send', async () => {
    const { rec, reload, user } = fixture();
    rec.save = async () => { throw new Error('Snapshot save failed'); };
    await assert.rejects(sendClipCompletionNotification(rec, user, 'channel-123', 'channel', {
        renderEmail: async () => structuredClone(payload),
        sendRenderedEmail: async () => assert.fail('Must persist before sending')
    }), /Snapshot save failed/);
    assert.equal(reload().notificationPayload, undefined);
});

test('provider failure records the retry deadline and success clears the failure', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) });
    const { rec, reload, saves, user } = fixture();
    await sendClipCompletionNotification(rec, user, 'channel-123', 'channel', {
        renderEmail: async () => structuredClone(payload),
        sendRenderedEmail: async () => ({ error: true, message: 'x'.repeat(2100) })
    });
    assert.equal(rec.notificationStatus, 'failed');
    assert.equal(rec.notificationError, 'x'.repeat(2000));
    assert.equal(rec.notificationLastAttemptAt?.getTime(), Date.now());
    const delay = Math.max(60_000, Number(process.env.CLIP_RECOMMENDATION_NOTIFICATION_RETRY_DELAY_MS) || 3_600_000);
    assert.equal(rec.notificationNextRetryAt?.getTime(), Date.now() + delay);
    assert.equal(rec.notifiedAt, null);
    assert.deepEqual(saves.map((saved) => saved.notificationStatus), ['pending', 'failed']);

    t.mock.timers.tick(delay);
    const retried = reload();
    await sendClipCompletionNotification(retried, user, 'channel-123', 'channel', {
        renderEmail: async () => assert.fail('Must not rerender'),
        sendRenderedEmail: async () => ({ error: false, message: 'Sent' })
    });
    const sent = reload();
    assert.equal(sent.notificationStatus, 'sent');
    assert.equal(sent.notifiedAt?.getTime(), Date.now());
    assert.equal(sent.notificationLastAttemptAt?.getTime(), Date.now());
    assert.equal(sent.notificationError, '');
    assert.equal(sent.notificationNextRetryAt, null);
});

test('missing email is not_required, not sent', async () => {
    const { rec, reload, user, saves } = fixture({ notificationStatus: 'failed', notificationError: 'Old error', notificationNextRetryAt: new Date() });
    user.email = '';
    user.accounts[0].email = '';
    await sendClipCompletionNotification(rec, user, 'channel-123', 'channel', {
        renderEmail: async () => assert.fail('Must not render without a recipient'),
        sendRenderedEmail: async () => assert.fail('Must not send without a recipient')
    });
    const saved = reload();
    assert.equal(saved.notificationStatus, 'not_required');
    assert.equal(saved.notifiedAt, null);
    assert.equal(saved.notificationPayload, undefined);
    assert.equal(saved.notificationError, '');
    assert.equal(saved.notificationNextRetryAt, null);
    assert.equal(saves.length, 1);
});

test('already sent is a no-op, including legacy records without a snapshot', async () => {
    const { rec, user, saves } = fixture({ notificationStatus: 'sent' });
    await sendClipCompletionNotification(rec, user, 'channel-123', 'channel', {
        renderEmail: async () => assert.fail('Must not render again'),
        sendRenderedEmail: async () => assert.fail('Must not send again')
    });
    assert.equal(saves.length, 0);
});

test('thrown delivery preserves the snapshot and retries even if the email is removed', async () => {
    const { rec, reload, user } = fixture({ queueJobID: undefined });
    await assert.rejects(sendClipCompletionNotification(rec, user, 'channel-123', 'channel', {
        renderEmail: async () => structuredClone(payload),
        sendRenderedEmail: async () => { throw new Error('Connection lost after delivery'); }
    }), /Connection lost after delivery/);
    const retried = reload();
    assert.deepEqual(retried.toObject().notificationPayload, payload);
    assert.equal(retried.notificationStatus, 'pending');
    user.email = '';
    user.accounts[0].email = '';
    await sendClipCompletionNotification(retried, user, 'channel-123', 'channel', {
        renderEmail: async () => assert.fail('Must not rerender'),
        sendRenderedEmail: async (rendered, key) => {
            assert.deepEqual(JSON.parse(JSON.stringify(rendered)), payload);
            assert.equal(key, `clip-recommendation-complete:${rec._id}`);
            return { error: false, message: 'Sent' };
        }
    });
    assert.equal(reload().notificationStatus, 'sent');
});

test('render errors propagate without saving or sending', async () => {
    const { rec, user, saves } = fixture();
    await assert.rejects(sendClipCompletionNotification(rec, user, 'channel-123', 'channel', {
        renderEmail: async () => { throw new Error('Render failed'); },
        sendRenderedEmail: async () => assert.fail('Must not send')
    }), /Render failed/);
    assert.equal(saves.length, 0);
});

test('save errors after delivery propagate while the durable snapshot remains retryable', async () => {
    const { rec, reload, user } = fixture();
    const save = rec.save;
    let saveCount = 0;
    rec.save = async () => {
        if (++saveCount === 2) throw new Error('Result save failed');
        return save();
    };
    await assert.rejects(sendClipCompletionNotification(rec, user, 'channel-123', 'channel', {
        renderEmail: async () => structuredClone(payload),
        sendRenderedEmail: async () => ({ error: false, message: 'Sent' })
    }), /Result save failed/);
    assert.equal(reload().notificationStatus, 'pending');
    assert.deepEqual(reload().toObject().notificationPayload, payload);
});
