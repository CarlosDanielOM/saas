import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';

const blocks = (ranges: string) => {
    const list = new BlockList();
    for (const range of ranges.split(' ')) {
        const [address, prefix] = range.split('/');
        list.addSubnet(address, Number(prefix), isIP(address) === 6 ? 'ipv6' : 'ipv4');
    }
    return list;
};
// Loopback and Docker networks: only NPM and sibling containers may set forwarding headers.
const PRIVATE = blocks('127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 ::1/128 fc00::/7');
// cloudflare.com/ips; identical to the Cloudflare part of NPM's ip_ranges.conf on 2026-11-14.
const CLOUDFLARE = blocks('173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 ' +
    '108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 ' +
    '104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 ' +
    '2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32');
const within = (list: BlockList, ip: string) => list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');

/** Trimmed, without the IPv4-mapped prefix, IPv6 in canonical form; '' unless it is one plain address. */
export function normalizeIp(value: unknown): string {
    if (typeof value !== 'string' || value.length > 64) return '';
    const ip = value.trim().replace(/^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/i, '');
    if (isIP(ip) === 4) return ip;
    if (isIP(ip) !== 6) return '';
    try { return new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch { return ''; }
}

/** Limiter identity of an address: IPv4 as is, IPv6 by its /64 (one subscriber's block), so rotating inside it gains nothing. */
export function ipBucket(ip: string): string {
    if (isIP(ip) !== 6) return ip;
    // normalizeIp output: canonical lowercase hex, at most one `::`, no dotted tail.
    const [head, tail] = ip.split('::');
    const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
    const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
    return `${groups.slice(0, 4).join(':')}::/64`;
}

/**
 * Rate-limit identities for a request (Express requests and raw WebSocket upgrades); every one must have budget.
 * NPM overwrites X-Real-IP with its own peer. Cloudflare sends no X-Real-IP, so for proxied traffic that peer is a
 * Cloudflare edge and the client is in CF-Connecting-IP, which Cloudflare overwrites. Any other X-Real-IP is either a
 * direct origin hit (true, while CF-Connecting-IP is forgeable) or a client-sent X-Real-IP that NPM's real_ip accepted
 * from Cloudflare (forged, while CF-Connecting-IP is true). When they disagree we cannot tell which is true, so both
 * count: the true one keeps limiting whoever rotates the forged one. They live under `conflict:` so a forged value can
 * never drain the bucket of a client whose headers agree.
 */
export function clientIps(req: IncomingMessage): string[] {
    const peer = normalizeIp(req.socket.remoteAddress);
    if (!peer || !within(PRIVATE, peer)) return [peer ? ipBucket(peer) : 'unknown'];
    const proxy = normalizeIp(req.headers['x-real-ip']);
    if (!proxy) return [ipBucket(peer)];
    const client = normalizeIp(req.headers['cf-connecting-ip']);
    if (within(CLOUDFLARE, proxy)) return [ipBucket(client || proxy)];
    if (!client || client === proxy) return [ipBucket(proxy)];
    return [`conflict:real:${ipBucket(proxy)}`, `conflict:cf:${ipBucket(client)}`];
}
