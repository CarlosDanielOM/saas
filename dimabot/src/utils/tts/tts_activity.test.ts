import assert from 'node:assert/strict';
import test from 'node:test';
import { buildActivityRow } from '../activity_log.js';
import { ttsPlaybackActivity, ttsPlaybackOutcome, ttsRequestActivity, ttsRequestOutcome } from './tts_activity.js';
import { isActivityProblem } from '../../schemas/activity_log.schema.js';

test('a refused voice request says why: settings doing their job are skipped, the rest failed', () => {
    const cases: Array<[Parameters<typeof ttsRequestOutcome>[0], string, string]> = [
        [{ code: 'tts_disabled', status: 403 }, 'skipped', 'tts_disabled'],
        [{ code: 'text_rejected', status: 400 }, 'skipped', 'text_rejected'],
        [{ code: 'empty_text', status: 400 }, 'skipped', 'empty_text'],
        [{ code: 'queue_full', status: 429 }, 'skipped', 'queue_full'],
        [{ code: 'no_speech_page', status: 409 }, 'failed', 'no_speech_page'],
        [{ code: 'no_voice', status: 400 }, 'failed', 'no_voice'],
        [{ code: 'busy', status: 429 }, 'failed', 'busy'],
        // An API from before the codes.
        [{ status: 409 }, 'failed', 'no_speech_page'],
        [{ status: 403 }, 'skipped', 'tts_disabled'],
        [{ status: 500 }, 'failed', 'error'],
        [{}, 'failed', 'error'],
        [{ code: 'something_new', status: 409 }, 'failed', 'no_speech_page'],
    ];
    for (const [result, outcome, reason] of cases) assert.deepEqual(ttsRequestOutcome(result), { outcome, reason }, JSON.stringify(result));
});

test('a refused request row keeps who asked, what they asked and the service message', () => {
    const input = ttsRequestActivity({
        channelID: '100', actor: { id: '7', login: 'Viewer', name: 'Viewer' }, source: 'ast', text: 'read this', provider: 'fish',
        result: { message: 'Speech overlay is not connected. Open the speech URL first and try again.', status: 409, code: 'no_speech_page' }
    });
    const row = buildActivityRow(input)!;
    assert.deepEqual([row.kind, row.name, row.outcome, row.reason, row.actorLogin, row.text], ['voice', 'request', 'failed', 'no_speech_page', 'viewer', 'read this']);
    assert.deepEqual(row.data, { source: 'ast', provider: 'fish', error: 'Speech overlay is not connected. Open the speech URL first and try again.' });
    assert.ok(isActivityProblem(row.outcome, row.reason), 'nobody heard the viewer: a problem');
    assert.ok(!isActivityProblem('skipped', 'tts_disabled'), 'TTS turned off is not a problem');
});

test('playback endings map to plain outcomes; an unknown ending stays visible under its own name', () => {
    assert.deepEqual(ttsPlaybackOutcome('ended', true), { outcome: 'ok', reason: '' });
    assert.deepEqual(ttsPlaybackOutcome('pet:completed', true), { outcome: 'ok', reason: '' });
    assert.deepEqual(ttsPlaybackOutcome('skip', true), { outcome: 'skipped', reason: 'tts_skipped' });
    assert.deepEqual(ttsPlaybackOutcome('clear', false), { outcome: 'skipped', reason: 'tts_cleared' });
    assert.deepEqual(ttsPlaybackOutcome('interrupted', false), { outcome: 'skipped', reason: 'tts_stopped' });
    assert.deepEqual(ttsPlaybackOutcome('pet:cancelled', true), { outcome: 'skipped', reason: 'pet_stopped' });
    assert.deepEqual(ttsPlaybackOutcome('pet:state_changed', false), { outcome: 'skipped', reason: 'pet_stopped' });
    assert.deepEqual(ttsPlaybackOutcome('pet:failed', false), { outcome: 'failed', reason: 'pet_failed' });
    assert.deepEqual(ttsPlaybackOutcome('stream_ended', false), { outcome: 'skipped', reason: 'stream_ended' });
    assert.deepEqual(ttsPlaybackOutcome('play-error', false), { outcome: 'failed', reason: 'play_error' });
    assert.deepEqual(ttsPlaybackOutcome('download-error', false), { outcome: 'failed', reason: 'download_error' });
    assert.deepEqual(ttsPlaybackOutcome('start-timeout', false), { outcome: 'failed', reason: 'no_start' });
    assert.deepEqual(ttsPlaybackOutcome('timeout', true), { outcome: 'failed', reason: 'playback_timeout' });
    assert.deepEqual(ttsPlaybackOutcome('disconnected', true), { outcome: 'failed', reason: 'page_closed_while_playing' });
    assert.deepEqual(ttsPlaybackOutcome('disconnected', false), { outcome: 'failed', reason: 'page_closed' });
    assert.deepEqual(ttsPlaybackOutcome('output_unavailable', false), { outcome: 'failed', reason: 'no_speech_page' });
    assert.deepEqual(ttsPlaybackOutcome('not_played', false), { outcome: 'failed', reason: 'not_played' });
    assert.deepEqual(ttsPlaybackOutcome('Weird Thing!', false), { outcome: 'failed', reason: 'weird_thing_' });
});

test('a playback row is one per message and carries the facts the owner needs', () => {
    const input = ttsPlaybackActivity({
        channelID: '100', speechID: 'speech-1', reason: 'ended', heard: true, actor: { id: '7', login: 'viewer', name: 'Viewer' },
        provider: 'fish', voice: 'rias', source: 'ast', chars: 42, pages: 2, movedBecause: 'play-error', everyPage: false, totalMs: 5400
    });
    assert.equal(input.dedupeKey, 'speech-1:playback');
    const row = buildActivityRow(input)!;
    assert.deepEqual([row.kind, row.name, row.outcome, row.reason, row.ref, row.durationMs], ['voice', 'playback', 'ok', '', 'speech-1', 5400]);
    assert.deepEqual(row.data, { provider: 'fish', voice: 'rias', source: 'ast', chars: 42, heard: true, pages: 2, movedBecause: 'play-error' });
    const again = buildActivityRow(ttsPlaybackActivity({ channelID: '100', speechID: 'speech-1', reason: 'play-error', heard: false, pages: 1 }))!;
    assert.equal(again._id, row._id, 'a second ending of the same message is the same row');
    assert.equal(again.data.endReason, 'play-error');
});
