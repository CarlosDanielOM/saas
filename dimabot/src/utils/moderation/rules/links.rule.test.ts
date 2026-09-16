import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLinksRule } from './links.rule.js';

const baseRule = { allowlistDomains: [] as string[] };

test('detects bare domains like abc.abc', () => {
    const result = evaluateLinksRule(baseRule, { text: 'check out cool-site.com now' });
    assert.equal(result.triggered, true);
    assert.equal(result.blockedUrl, 'cool-site.com');
});

test('detects protocol URLs', () => {
    const result = evaluateLinksRule(baseRule, { text: 'go to https://example.com/path?q=1 please' });
    assert.equal(result.triggered, true);
    assert.equal(result.blockedUrl, 'example.com');
});

test('detects www URLs', () => {
    const result = evaluateLinksRule(baseRule, { text: 'visit www.example.org today' });
    assert.equal(result.triggered, true);
    assert.equal(result.blockedUrl, 'example.org');
});

test('plain messages do not trigger', () => {
    assert.equal(evaluateLinksRule(baseRule, { text: 'hello everyone how is it going' }).triggered, false);
    assert.equal(evaluateLinksRule(baseRule, { text: 'v1.2 was great' }).triggered, false);
    assert.equal(evaluateLinksRule(baseRule, { text: 'e.g. this' }).triggered, false);
});

test('allowlisted domains do not trigger', () => {
    const rule = { allowlistDomains: ['twitch.tv'] };
    const result = evaluateLinksRule(rule, { text: 'nice clip https://www.twitch.tv/dima/clip/abc' });
    assert.equal(result.triggered, false);
});

test('subdomains of allowlisted domains do not trigger', () => {
    const rule = { allowlistDomains: ['twitch.tv'] };
    const result = evaluateLinksRule(rule, { text: 'clips.twitch.tv/awesome-clip' });
    assert.equal(result.triggered, false);
});

test('non-allowlisted URL alongside allowlisted one still triggers', () => {
    const rule = { allowlistDomains: ['twitch.tv'] };
    const result = evaluateLinksRule(rule, { text: 'twitch.tv/dima but also scam.xyz/free' });
    assert.equal(result.triggered, true);
    assert.equal(result.blockedUrl, 'scam.xyz');
});

test('allowlist matching is exact, not substring', () => {
    const rule = { allowlistDomains: ['twitch.tv'] };
    const result = evaluateLinksRule(rule, { text: 'nottwitch.tv.evil.com' });
    assert.equal(result.triggered, true);
});

test('empty message does not trigger', () => {
    assert.equal(evaluateLinksRule(baseRule, { text: '' }).triggered, false);
});
