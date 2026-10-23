import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// The chat helpers are irrelevant for `$(user ...)`; they are mocked so the
// test never loads the chat/DB stack.
mock.module('../../../functions/chats/index.js', {
    namedExports: { getChatters: async () => ({ error: false, chatters: [] }) }
});

// The nested TTS check exercises the real AST TTS function, but the queue and
// the analytics call are fixtures: no audio is produced and nothing is sent.
const ttsQueueCalls: Array<{ rawMessage: string }> = [];
mock.module('../../../utils/tts/queue_default_tts.util.js', {
    namedExports: {
        queueDefaultTts: async (input: { rawMessage: string }) => {
            ttsQueueCalls.push({ rawMessage: input.rawMessage });
            return { error: false, message: '' };
        }
    }
});
mock.module('../../../utils/posthog_events.js', {
    namedExports: { trackTts: () => {} }
});

const { registerUserFunctions } = await import('./user.functions.js');
const { registerTtsFunctions } = await import('./tts.functions.js');
const { parse } = await import('../parser.js');
const { createExecutionContext, evaluate, getFunctionMetadata } = await import('../evaluator.js');

registerUserFunctions();
registerTtsFunctions();

interface RenderOptions {
    displayName?: string;
    login?: string;
    eventData?: Record<string, unknown>;
    extraContext?: Record<string, unknown>;
}

async function render(source: string, options: RenderOptions = {}): Promise<string> {
    const parsed = parse(source);
    assert.equal(parsed.error, undefined);

    const context = createExecutionContext({
        broadcasterId: 'channel',
        userId: 'user-id',
        userLogin: options.login ?? 'user_login',
        userDisplayName: options.displayName ?? '',
        eventData: options.eventData,
        extraContext: options.extraContext
    });

    const result = await evaluate(parsed.ast, context);
    return String(result.value ?? '');
}

async function renderAsChatter(source: string, chatterName: string, chatterLogin = 'chatter_login'): Promise<string> {
    return render(source, {
        eventData: { chatter_user_name: chatterName, chatter_user_login: chatterLogin }
    });
}

test('$(user) without arguments returns the raw chatter name', async () => {
    assert.equal(await renderAsChatter('$(user)', 'cdom201'), 'cdom201');
    assert.equal(await renderAsChatter('$(user)', 'the_mighty_$kill201'), 'the_mighty_$kill201');
});

test('$(user ignore symbols numbers) strips symbols and numbers', async () => {
    assert.equal(await renderAsChatter('$(user ignore symbols numbers)', 'cdom201'), 'cdom');
    assert.equal(await renderAsChatter('$(user ignore symbols numbers)', 'the_mighty_$kill201'), 'themightykill');
});

test('$(user ignore ...) accepts the filters in either order', async () => {
    assert.equal(await renderAsChatter('$(user ignore numbers symbols)', 'cdom201'), 'cdom');
    assert.equal(await renderAsChatter('$(user ignore numbers symbols)', 'the_mighty_$kill201'), 'themightykill');
    assert.equal(await renderAsChatter('$(user ignore symbols numbers)', 'the_mighty_$kill201'), 'themightykill');
});

test('$(user ignore symbols) keeps digits and drops punctuation, emoji and underscores', async () => {
    assert.equal(await renderAsChatter('$(user ignore symbols)', 'cdom201'), 'cdom201');
    assert.equal(await renderAsChatter('$(user ignore symbols)', 'the_mighty_$kill201'), 'themightykill201');
    assert.equal(await renderAsChatter('$(user ignore symbols)', 'a_b c!d😀'), 'abcd');
});

test('$(user ignore numbers) keeps symbols and drops every Unicode numeric character', async () => {
    assert.equal(await renderAsChatter('$(user ignore numbers)', 'cdom201'), 'cdom');
    assert.equal(await renderAsChatter('$(user ignore numbers)', 'the_mighty_$kill201'), 'the_mighty_$kill');
    assert.equal(await renderAsChatter('$(user ignore numbers)', 'cdom٢٣٤'), 'cdom');
    assert.equal(await renderAsChatter('$(user ignore numbers)', 'cdomⅫ'), 'cdom');
});

test('$(user ignore ...) preserves casing and Unicode letters with combining marks', async () => {
    assert.equal(await renderAsChatter('$(user ignore symbols numbers)', 'CDOM_201'), 'CDOM');
    assert.equal(await renderAsChatter('$(user ignore symbols numbers)', 'José_Álvares'), 'JoséÁlvares');
    // Decomposed accent: the combining mark must survive next to its base letter.
    assert.equal(await renderAsChatter('$(user ignore symbols numbers)', 'Jose\u0301_Á'), 'Jose\u0301Á');
    assert.equal(await renderAsChatter('$(user ignore symbols)', 'Ünïcode_💩'), 'Ünïcode');
});

test('$(user ignore ...) returns viewer when no letter or number is left', async () => {
    assert.equal(await renderAsChatter('$(user ignore numbers)', '201'), 'viewer');
    assert.equal(await renderAsChatter('$(user ignore symbols)', '!!!'), 'viewer');
    assert.equal(await renderAsChatter('$(user ignore symbols numbers)', '123_!!!'), 'viewer');
});

test('$(user ignore ...) is case-insensitive about the filter names', async () => {
    assert.equal(await renderAsChatter('$(user IGNORE SYMBOLS NUMBERS)', 'cdom201'), 'cdom');
    assert.equal(await renderAsChatter('$(user Ignore Numbers)', 'cdom201'), 'cdom');
});

test('$(user ...) keeps the raw name for unsupported or malformed arguments', async () => {
    assert.equal(await renderAsChatter('$(user ignore)', 'cdom201'), 'cdom201');
    assert.equal(await renderAsChatter('$(user ignore emojis)', 'cdom201'), 'cdom201');
    assert.equal(await renderAsChatter('$(user ignore symbols emojis)', 'cdom201'), 'cdom201');
    assert.equal(await renderAsChatter('$(user ignore "constructor")', 'cdom201'), 'cdom201');
    assert.equal(await renderAsChatter('$(user ignore "__proto__")', 'cdom201'), 'cdom201');
    assert.equal(await renderAsChatter('$(user symbols numbers)', 'cdom201'), 'cdom201');
    assert.equal(await renderAsChatter('$(user cdom201)', 'cdom201'), 'cdom201');
});

test('$(user ignore ...) filters the same name source that plain $(user) uses', async () => {
    const options: RenderOptions = {
        displayName: 'display_name',
        login: 'context_login',
        eventData: { chatter_user_name: 'cdom201', chatter_user_login: 'cdom_login' },
        extraContext: { userName: 'extra_user_name', userLogin: 'extra_user_login' }
    };

    assert.equal(await render('$(user)', options), 'cdom201');
    assert.equal(await render('$(user ignore symbols numbers)', options), 'cdom');

    // Without the event payload the extra context wins over the context fields.
    const extraOnly: RenderOptions = {
        displayName: 'display_name',
        login: 'context_login',
        extraContext: { userName: 'cdom201', userLogin: 'extra_user_login' }
    };
    assert.equal(await render('$(user)', extraOnly), 'cdom201');
    assert.equal(await render('$(user ignore symbols numbers)', extraOnly), 'cdom');

    // Without any extra context the context display name is used.
    const contextOnly: RenderOptions = { displayName: 'cdom201', login: 'context_login' };
    assert.equal(await render('$(user)', contextOnly), 'cdom201');
    assert.equal(await render('$(user ignore symbols numbers)', contextOnly), 'cdom');
});

test('$(user ignore ...) resolves inside a nested function call', async () => {
    ttsQueueCalls.length = 0;

    await render('$(tts $(user ignore symbols numbers) says: &t)', {
        eventData: { chatter_user_name: 'cdom201', chatter_user_login: 'cdom_login' }
    });

    assert.equal(ttsQueueCalls.length, 1);
    assert.match(ttsQueueCalls[0].rawMessage, /^cdom\b/);
    assert.match(ttsQueueCalls[0].rawMessage, /says/);
    assert.equal(ttsQueueCalls[0].rawMessage.includes('cdom201'), false);
});

test('the user function metadata documents the ignore filters', () => {
    const metadata = getFunctionMetadata('user');

    assert.equal(metadata?.category, 'user');
    assert.match(metadata?.syntax ?? '', /ignore/);
    assert.match(metadata?.description ?? '', /symbols/);
    assert.match(metadata?.description ?? '', /numbers/);
    assert.ok((metadata?.examples ?? []).includes('user ignore symbols numbers'));
});
