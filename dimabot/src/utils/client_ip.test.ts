import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { clientIp, normalizeIp } from './client_ip.js';

const NPM = '172.18.0.2';
const EDGE = '162.158.10.1';
const request = (headers: Record<string, unknown>, remoteAddress = NPM) =>
    ({ socket: { remoteAddress }, headers } as unknown as IncomingMessage);

test('Cloudflare traffic is keyed on CF-Connecting-IP, so users on one edge stay apart', () => {
    assert.equal(clientIp(request({ 'x-real-ip': EDGE, 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');
    assert.equal(clientIp(request({ 'x-real-ip': EDGE, 'cf-connecting-ip': '203.0.113.8' })), '203.0.113.8');
    assert.equal(clientIp(request({ 'x-real-ip': '2606:4700::6810:1', 'cf-connecting-ip': ' 2001:DB8:0:0::1 ' })), '2001:db8::1');
    assert.equal(clientIp(request({ 'x-real-ip': EDGE })), EDGE, 'an edge without the header keeps the edge');
    assert.equal(clientIp(request({ 'x-real-ip': EDGE, 'cf-connecting-ip': 'not-an-ip' })), EDGE);
});

test('a non-Cloudflare X-Real-IP is used only when CF-Connecting-IP agrees or is absent', () => {
    // Direct origin hit: NPM overwrote X-Real-IP with the true peer.
    assert.equal(clientIp(request({ 'x-real-ip': '198.51.100.9' })), '198.51.100.9');
    // NPM trusting CF-Connecting-IP: both headers carry the client, even in different IPv6 spellings.
    assert.equal(clientIp(request({ 'x-real-ip': '198.51.100.9', 'cf-connecting-ip': '198.51.100.9' })), '198.51.100.9');
    assert.equal(clientIp(request({ 'x-real-ip': '2001:db8::1', 'cf-connecting-ip': '2001:0db8:0000::0001' })), '2001:db8::1');
});

test('spoofed headers never pick a fresh bucket', () => {
    // Forged CF-Connecting-IP straight at the origin, and a client-sent X-Real-IP that NPM accepted from Cloudflare.
    for (const headers of [{ 'x-real-ip': '198.51.100.9', 'cf-connecting-ip': '203.0.113.50' },
        { 'x-real-ip': '198.51.100.9', 'cf-connecting-ip': '203.0.113.51' },
        { 'x-real-ip': '192.0.2.77', 'cf-connecting-ip': '203.0.113.7' }]) assert.equal(clientIp(request(headers)), 'untrusted');
    // Headers from a peer that is not NPM or a sibling container are ignored.
    assert.equal(clientIp(request({ 'x-real-ip': EDGE, 'cf-connecting-ip': '203.0.113.7' }, '198.51.100.20')), '198.51.100.20');
    // Duplicated, overlong or garbage values are not addresses.
    assert.equal(clientIp(request({ 'x-real-ip': `${EDGE}, 192.0.2.1` })), NPM);
    assert.equal(clientIp(request({ 'x-real-ip': ['192.0.2.1'] })), NPM);
    assert.equal(clientIp(request({ 'x-real-ip': ' '.repeat(60) + '192.0.2.1' })), NPM);
});

test('without proxy headers the socket address is used', () => {
    assert.equal(clientIp(request({})), NPM);
    assert.equal(clientIp(request({}, '::ffff:172.18.0.4')), '172.18.0.4');
    assert.equal(clientIp(request({}, '::1')), '::1');
    assert.equal(clientIp(request({ 'x-real-ip': '192.0.2.1' }, '::ffff:127.0.0.1')), '192.0.2.1');
    assert.equal(clientIp({ socket: {}, headers: {} } as unknown as IncomingMessage), 'unknown');
});

test('normalizeIp trims, unmaps IPv4, canonicalizes IPv6 and rejects anything else', () => {
    assert.equal(normalizeIp(' 203.0.113.7 '), '203.0.113.7');
    assert.equal(normalizeIp('::FFFF:203.0.113.7'), '203.0.113.7');
    assert.equal(normalizeIp('::ffff:abcd'), '::ffff:abcd', 'only a dotted IPv4 tail is unmapped');
    assert.equal(normalizeIp('2001:0DB8::0:1'), '2001:db8::1');
    for (const value of ['', 'unknown', '01.2.3.4', '203.0.113.7:443', 'fe80::1%eth0', '1'.repeat(65), undefined, 7, ['203.0.113.7']]) {
        assert.equal(normalizeIp(value), '', String(value));
    }
});
