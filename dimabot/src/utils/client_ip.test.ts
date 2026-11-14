import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { clientIps, ipBucket, normalizeIp } from './client_ip.js';

const NPM = '172.18.0.2';
const EDGE = '162.158.10.1';
const request = (headers: Record<string, unknown>, remoteAddress = NPM) =>
    ({ socket: { remoteAddress }, headers } as unknown as IncomingMessage);
/** The single identity of a request whose headers agree. */
const clientIp = (req: IncomingMessage) => { const keys = clientIps(req); assert.equal(keys.length, 1, keys.join()); return keys[0]; };

test('Cloudflare traffic is keyed on CF-Connecting-IP, so users on one edge stay apart', () => {
    assert.equal(clientIp(request({ 'x-real-ip': EDGE, 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');
    assert.equal(clientIp(request({ 'x-real-ip': EDGE, 'cf-connecting-ip': '203.0.113.8' })), '203.0.113.8');
    assert.equal(clientIp(request({ 'x-real-ip': '2606:4700::6810:1', 'cf-connecting-ip': ' 2001:DB8:0:0::1 ' })), '2001:db8:0:0::/64');
    assert.equal(clientIp(request({ 'x-real-ip': EDGE })), EDGE, 'an edge without the header keeps the edge');
    assert.equal(clientIp(request({ 'x-real-ip': EDGE, 'cf-connecting-ip': 'not-an-ip' })), EDGE);
});

test('a non-Cloudflare X-Real-IP is used only when CF-Connecting-IP agrees or is absent', () => {
    // Direct origin hit: NPM overwrote X-Real-IP with the true peer.
    assert.equal(clientIp(request({ 'x-real-ip': '198.51.100.9' })), '198.51.100.9');
    // NPM trusting CF-Connecting-IP: both headers carry the client, even in different IPv6 spellings.
    assert.equal(clientIp(request({ 'x-real-ip': '198.51.100.9', 'cf-connecting-ip': '198.51.100.9' })), '198.51.100.9');
    assert.equal(clientIp(request({ 'x-real-ip': '2001:db8::1', 'cf-connecting-ip': '2001:0db8:0000::0001' })), '2001:db8:0:0::/64');
});

test('spoofed headers never pick a fresh bucket nor drain an agreeing client', () => {
    // Forged CF-Connecting-IP straight at the origin: the true X-Real-IP bucket counts every attempt.
    for (const forged of ['203.0.113.50', '203.0.113.51']) {
        assert.deepEqual(clientIps(request({ 'x-real-ip': '198.51.100.9', 'cf-connecting-ip': forged })),
            ['conflict:real:198.51.100.9', `conflict:cf:${forged}`]);
    }
    // Client-sent X-Real-IP accepted by NPM from Cloudflare: the true CF-Connecting-IP bucket counts every attempt.
    assert.deepEqual(clientIps(request({ 'x-real-ip': '192.0.2.77', 'cf-connecting-ip': '203.0.113.7' })),
        ['conflict:real:192.0.2.77', 'conflict:cf:203.0.113.7']);
    // Forging a victim's address never touches the victim's own (agreeing) bucket.
    assert.ok(!clientIps(request({ 'x-real-ip': '198.51.100.9', 'cf-connecting-ip': '203.0.113.7' })).includes('203.0.113.7'));
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
    assert.equal(clientIp(request({}, '::1')), '0:0:0:0::/64');
    assert.equal(clientIp(request({ 'x-real-ip': '192.0.2.1' }, '::ffff:127.0.0.1')), '192.0.2.1');
    assert.equal(clientIp({ socket: {}, headers: {} } as unknown as IncomingMessage), 'unknown');
});

test('IPv6 clients are limited per /64, IPv4 per address', () => {
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2:ffff:ffff:ffff:fffe', '2001:db8:1:2::']) assert.equal(ipBucket(normalizeIp(ip)), '2001:db8:1:2::/64');
    assert.equal(ipBucket(normalizeIp('2001:db8:1:3::1')), '2001:db8:1:3::/64', 'the next /64 is another client');
    assert.equal(ipBucket(normalizeIp('2001:db8::7')), '2001:db8:0:0::/64');
    assert.equal(ipBucket(normalizeIp('fe80:1:2:3:4:5:6:7')), 'fe80:1:2:3::/64');
    assert.equal(ipBucket(normalizeIp('::ffff:abcd')), '0:0:0:0::/64');
    assert.equal(ipBucket('203.0.113.7'), '203.0.113.7');
    assert.equal(clientIp(request({ 'x-real-ip': EDGE, 'cf-connecting-ip': '2001:db8:1:2::99' })), '2001:db8:1:2::/64');
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
