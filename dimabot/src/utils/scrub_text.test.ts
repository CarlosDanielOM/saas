import test from 'node:test';
import assert from 'node:assert/strict';
import { isSensitiveKey, scrubMaybeJson, scrubSensitive } from './scrub_text.js';

const SECRET = 'S3cr3tValue';
const gone = (input: string, ...secrets: string[]) => {
    const out = scrubSensitive(input);
    for (const secret of secrets) assert.equal(out.includes(secret), false, `${secret} survived in: ${out}`);
    return out;
};

test('named secrets are masked in every spelling, quoted or not, long or short', () => {
    assert.equal(gone('GET /x?access_token=abc123def456&ok=1', 'abc123def456'), 'GET /x?access_token=[redacted]&ok=1');
    assert.equal(gone('{"accessToken":"abc123def456ghi","clientSecret":"s3cr3tvalue"}', 'abc123def456ghi', 's3cr3tvalue'),
        '{"accessToken":"[redacted]","clientSecret":[redacted]}');
    assert.equal(gone('"password":"correct horse battery staple"', 'correct', 'horse', 'staple'), '"password":[redacted]');
    assert.equal(gone("password = 'two words' then", 'two words'), 'password = [redacted] then');
    assert.equal(gone('password=abc next', 'abc '), 'password=[redacted] next');
    assert.equal(gone('refreshToken: zzzzzzzz9999', 'zzzzzzzz9999'), 'refreshToken: [redacted]');
    assert.equal(gone('api-key=AbCdEf123456 apiKey: QwErTy987654', 'AbCdEf123456', 'QwErTy987654'), 'api-key=[redacted] apiKey: [redacted]');
});

test('headers, connection strings and webhook URLs', () => {
    assert.equal(gone('Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'), 'Authorization: [redacted]');
    assert.equal(gone('Authorization: Bearer abcDEF123456.ghiJKL-789', 'abcDEF123456'), 'Authorization: [redacted]');
    assert.equal(gone('Cookie: sessionid=abcd1234; theme=dark', 'abcd1234', 'theme=dark'), 'Cookie: [redacted]');
    assert.equal(gone('Set-Cookie: connect.sid=s%3Aabc.def; Path=/', 's%3Aabc'), 'Set-Cookie: [redacted]');
    assert.equal(gone('{"headers":{"authorization":"Bearer abcdefghijklmnopqrstuv","accept":"*/*"}}', 'abcdefghijklmnopqrstuv'),
        '{"headers":{"authorization":[redacted],"accept":"*/*"}}');
    assert.equal(gone('use Bearer abcdefghij0123456789ZZ now', 'abcdefghij0123456789ZZ'), 'use Bearer [redacted] now');
    assert.equal(gone('PASS oauth:abcdefgh12345678', 'abcdefgh12345678'), 'PASS oauth:[redacted]');
    assert.equal(gone('connect mongodb://admin:hunter2@db.internal:27017/app failed', 'hunter2', 'admin:'), 'connect mongodb://[redacted]@db.internal:27017/app failed');
    assert.equal(gone('post to https://discord.com/api/webhooks/123456789012345678/AbCd-EfGh_IjKl.MnOp', 'AbCd-EfGh'),
        'post to https://discord.com/api/webhooks/123456789012345678/[redacted]');
    assert.equal(gone('https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX done', 'XXXXXXXXXXXX'), 'https://hooks.slack.com/services/[redacted] done');
});

test('secrets with no name in front: JWTs, provider key prefixes, a bare Twitch token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
    assert.equal(gone(`token is ${jwt} ok`, jwt), 'token is [redacted token] ok');
    assert.equal(gone('key sk-proj-AbCdEfGhIjKlMnOpQrStUv end', 'AbCdEfGhIjKl'), 'key [redacted key] end');
    assert.equal(gone('sk-ant-api03-AbCdEfGhIjKlMnOp', 'AbCdEfGhIjKlMnOp'), '[redacted key]');
    assert.equal(gone('pk_live_51AbCdEfGhIjKlMnOp', '51AbCdEfGhIjKlMnOp'), '[redacted key]');
    assert.equal(gone('ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnopqrstuvwxyz'), '[redacted key]');
    assert.equal(gone('xoxb-123456789012-abcdefghijkl', '123456789012'), '[redacted key]');
    // A key right after a dash or an underscore is still a key.
    assert.equal(gone('run -sk-proj-AbCdEfGhIjKlMnOpQrStUv now', 'AbCdEfGhIjKl'), 'run -[redacted key] now');
    assert.equal(gone('OPENAI_sk-proj-AbCdEfGhIjKlMnOpQrStUv', 'AbCdEfGhIjKl'), 'OPENAI_[redacted key]');
    assert.equal(gone('--slack=-xoxb-123456789012-abcdefghijkl', '123456789012'), '--slack=-[redacted key]');
    assert.equal(gone('my token abcdefghij0123456789abcdefghij is', 'abcdefghij0123456789abcdefghij'), 'my token [redacted token] is');
});

test('e-mail addresses become [email]', () => {
    assert.equal(scrubSensitive('contact me at person.name+x@example.co.uk please'), 'contact me at [email] please');
});

test('ordinary chat, commands and templates stay readable', () => {
    for (const plain of [
        '!cc !bearer WelcomeChat',
        'Bearer Champion42 wins!',
        'token=1234',
        'cheer500 love the stream, token economy is fun',
        '$(urlfetch https://example.test/?key=$(channel))',
        '$(urlfetch https://api.example.test/v1/quote?lang=$(1)&code=$(user))',
        'Go check out QuietComet at twitch.tv/quietcomet, they were last playing Stardew Valley!',
        'my password is not something I would type here',
        'the secret to winning is patience',
        'follow @mossy_fern for more',
        'https://clips.twitch.tv/SomeLongClipSlugName-abcdefghij1234',
        'id 5f8d0d55b54764421b7156c3 and uuid 123e4567-e89b-12d3-a456-426614174000',
        'sha 3b18e512dba79e4c8300dd08aeb37f8e728b8dad',
        'ASCII art: ====================================',
        'keyboard smash asdkjhasdkjhasdkjhasdkjhasdkjhasd'
    ]) assert.equal(scrubSensitive(plain), plain);
});

test('a hostile long input is handled in linear time', () => {
    // Each blob is built to make one pattern start often and fail late. 64,000 characters is the longest text scrubbed
    // anywhere (an assistant tool result). Each must finish far inside a frame, not just "eventually".
    const blobs: Record<string, string> = {
        letters: 'a'.repeat(64_000), dots: 'a.'.repeat(32_000), schemes: 'x://'.repeat(16_000), jwtRun: 'eyJ'.repeat(21_000),
        jwtDashed: 'eyJ-'.repeat(16_000), jwtDotted: 'eyJabcdefgh.'.repeat(5_000), keyDashed: 'sk-'.repeat(21_000), slackDashed: 'xoxb-'.repeat(12_000),
        emailLocal: ('a'.repeat(63) + '@').repeat(1_000), names: 'token='.repeat(10_000), spaced: ('token' + ' '.repeat(200)).repeat(300),
        urlColons: ('a://' + 'x:'.repeat(100)).repeat(300), headers: 'cookie: '.repeat(8_000), bearer: 'bearer x '.repeat(7_000),
        thirty: 'a1'.repeat(32_000), webhook: 'discord.com/api/webhooks/1/'.repeat(2_300),
        keyShort: '-sk-abc '.repeat(8_000), keyUnderscored: '_sk_'.repeat(16_000), slackShort: '-xoxb-a '.repeat(8_000)
    };
    for (const [name, blob] of Object.entries(blobs)) {
        const started = performance.now();
        scrubSensitive(blob);
        const took = performance.now() - started;
        assert.ok(took < 150, `${name}: ${Math.round(took)} ms for ${blob.length} characters`);
    }
});

test('JSON text is scrubbed by key name as well as by shape', () => {
    const input = JSON.stringify({ name: 'so', reply: 'hello $(user)', accessToken: 'tok', nested: { Password: 'x y', list: [{ api_key: SECRET, note: 'mail a@b.co' }] }, email: 'a@b.co', empty: '' });
    const out = scrubMaybeJson(input);
    assert.deepEqual(JSON.parse(out), { name: 'so', reply: 'hello $(user)', accessToken: '[redacted]',
        nested: { Password: '[redacted]', list: [{ api_key: '[redacted]', note: 'mail [email]' }] }, email: '[redacted]', empty: '' });
    assert.equal(scrubMaybeJson('not json {password=abc}'), 'not json {password=[redacted]}');
    assert.equal(scrubMaybeJson('{"cut": "off mid-wa'), '{"cut": "off mid-wa');
    assert.deepEqual([isSensitiveKey('clientSecret'), isSensitiveKey('Set-Cookie'), isSensitiveKey('eventKey'), isSensitiveKey('username')], [true, true, false, false]);
});
