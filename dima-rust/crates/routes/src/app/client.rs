//! The client's address, for rate limits that must tell clients apart (the OAuth routes).
//!
//! The reference keys the OAuth rate limits by `req.ip` with `trust proxy` off: the address of
//! the reverse proxy, so every client shares one bucket and one client can lock everyone out of
//! the desktop sign-in (`oauth/routes.ts:83`, `:178`; `ledger/http.md` item 9). Here the address
//! is the one the reverse proxy reports, believed only when the connection comes from a
//! configured trusted proxy:
//!
//! - The connection's peer is not a trusted proxy (or none is configured): the peer address.
//!   Whatever the client wrote in a forwarding header is ignored.
//! - The peer is trusted and the header is `X-Forwarded-For` (the default): the list is read
//!   from the right, skipping trusted addresses; the first address that is not a trusted proxy
//!   is the client. Each proxy appends the address it received the connection from, so
//!   everything to the left of that point was written by the client and is never used. When
//!   every entry is trusted, the leftmost is taken; when the header is missing or an entry is
//!   not an address, the peer is used.
//! - The peer is trusted and the header is a single-address header (`X-Real-IP`,
//!   `CF-Connecting-IP`, set by a proxy that overwrites it): its value, or the peer when it is
//!   missing or not an address.
//!
//! **What a forged header gets.** A client that reaches the API directly is keyed by its own
//! address. A client behind the trusted proxy that sends `X-Forwarded-For: 1.2.3.4` gets
//! `1.2.3.4, <its address>` after the proxy appends, and is keyed by `<its address>`: the forged
//! entry sits left of the first untrusted hop and is skipped. Only a proxy that overwrites a
//! single-address header must be trusted with [`ForwardedHeader::Single`]; configured with a
//! header the proxy merely passes through, a client could name any bucket, so the default is the
//! appending list.
//!
//! Buckets ([`ClientAddress::bucket`]): an IPv4 address on its own; an IPv6 address by its /64
//! prefix, the block one subscriber is usually given, so rotating addresses inside it does not
//! buy fresh buckets. IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`, what a dual-stack listener
//! reports for an IPv4 peer) count as IPv4.

use http::HeaderMap;
use std::fmt;
use std::net::{IpAddr, Ipv6Addr};

/// An address range: `10.0.0.0/8`, `fd00::/8`, or one address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IpRange {
    base: IpAddr,
    prefix: u8,
}

/// A range that does not parse.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("not an address or range: {0:?}")]
pub struct BadRange(pub String);

impl IpRange {
    /// Parses `addr` or `addr/prefix`.
    pub fn parse(text: &str) -> Result<Self, BadRange> {
        let bad = || BadRange(text.to_owned());
        let (address, prefix) = match text.split_once('/') {
            Some((address, prefix)) => (address, Some(prefix)),
            None => (text, None),
        };
        let base: IpAddr = address.trim().parse().map_err(|_| bad())?;
        let base = canonical(base);
        let max = if base.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            Some(prefix) => prefix.trim().parse::<u8>().map_err(|_| bad())?,
            None => max,
        };
        if prefix > max {
            return Err(bad());
        }
        Ok(Self { base, prefix })
    }

    /// Whether `address` is inside the range.
    pub fn contains(&self, address: IpAddr) -> bool {
        match (self.base, canonical(address)) {
            (IpAddr::V4(base), IpAddr::V4(address)) => {
                let mask = mask32(self.prefix);
                u32::from(base) & mask == u32::from(address) & mask
            }
            (IpAddr::V6(base), IpAddr::V6(address)) => {
                let mask = mask128(self.prefix);
                u128::from(base) & mask == u128::from(address) & mask
            }
            _ => false,
        }
    }
}

fn mask32(prefix: u8) -> u32 {
    u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0)
}

fn mask128(prefix: u8) -> u128 {
    u128::MAX.checked_shl(128 - u32::from(prefix)).unwrap_or(0)
}

/// IPv4-mapped IPv6 as IPv4.
fn canonical(address: IpAddr) -> IpAddr {
    address.to_canonical()
}

/// Which header the trusted proxy reports the client in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ForwardedHeader {
    /// `X-Forwarded-For`, appended by every proxy (read from the right).
    ForwardedFor,
    /// A header holding one address that the proxy overwrites (lower-case name).
    Single(String),
}

/// How the client address is found (typed configuration of the binary).
#[derive(Clone, PartialEq, Eq)]
pub struct ClientAddressPolicy {
    trusted: Vec<IpRange>,
    header: ForwardedHeader,
}

impl fmt::Debug for ClientAddressPolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientAddressPolicy")
            .field("trusted", &self.trusted)
            .field("header", &self.header)
            .finish()
    }
}

impl Default for ClientAddressPolicy {
    fn default() -> Self {
        Self::peer_only()
    }
}

impl ClientAddressPolicy {
    /// No trusted proxy: the peer address, always.
    pub fn peer_only() -> Self {
        Self {
            trusted: Vec::new(),
            header: ForwardedHeader::ForwardedFor,
        }
    }

    /// Trusted proxies and the header they report the client in.
    pub fn new(trusted: Vec<IpRange>, header: ForwardedHeader) -> Self {
        Self { trusted, header }
    }

    /// From configuration text: `trusted` is a comma-separated list of addresses and ranges
    /// (empty or absent: none), `header` a header name (absent, empty or `x-forwarded-for`: the
    /// appending list).
    pub fn parse(trusted: Option<&str>, header: Option<&str>) -> Result<Self, BadRange> {
        let trusted = trusted
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(IpRange::parse)
            .collect::<Result<Vec<_>, _>>()?;
        let header = match header.map(|name| name.trim().to_ascii_lowercase()) {
            None => ForwardedHeader::ForwardedFor,
            Some(name) if name.is_empty() || name == "x-forwarded-for" => {
                ForwardedHeader::ForwardedFor
            }
            Some(name) => ForwardedHeader::Single(name),
        };
        Ok(Self { trusted, header })
    }

    fn is_trusted(&self, address: IpAddr) -> bool {
        self.trusted.iter().any(|range| range.contains(address))
    }

    /// The client's address for a connection from `peer` with `headers`; `None` without a peer
    /// (a request that did not come over a socket).
    pub fn client_address(
        &self,
        peer: Option<IpAddr>,
        headers: &HeaderMap,
    ) -> Option<ClientAddress> {
        let peer = canonical(peer?);
        if !self.is_trusted(peer) {
            return Some(ClientAddress(peer));
        }
        let reported = match &self.header {
            ForwardedHeader::ForwardedFor => self.read_forwarded_for(headers),
            ForwardedHeader::Single(name) => headers
                .get(name.as_str())
                .and_then(|value| value.to_str().ok())
                .and_then(parse_address),
        };
        Some(ClientAddress(reported.unwrap_or(peer)))
    }

    fn read_forwarded_for(&self, headers: &HeaderMap) -> Option<IpAddr> {
        // Several `X-Forwarded-For` lines are one list, in order.
        let mut entries = Vec::new();
        for value in headers.get_all("x-forwarded-for") {
            let text = value.to_str().ok()?;
            for entry in text.split(',') {
                entries.push(parse_address(entry)?);
                if entries.len() > MAX_FORWARDED_ENTRIES {
                    return None;
                }
            }
        }
        let leftmost = *entries.first()?;
        Some(
            entries
                .iter()
                .rev()
                .copied()
                .find(|address| !self.is_trusted(*address))
                .unwrap_or(leftmost),
        )
    }
}

/// Longest `X-Forwarded-For` list read; a longer one is ignored (the peer is used).
const MAX_FORWARDED_ENTRIES: usize = 32;

/// One entry: an address, possibly with a port (`1.2.3.4:5678`, `[::1]:80`).
fn parse_address(text: &str) -> Option<IpAddr> {
    let text = text.trim();
    if let Ok(address) = text.parse::<IpAddr>() {
        return Some(canonical(address));
    }
    if let Ok(socket) = text.parse::<std::net::SocketAddr>() {
        return Some(canonical(socket.ip()));
    }
    None
}

/// A client address, as the rate limits key it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClientAddress(IpAddr);

impl ClientAddress {
    /// The address.
    pub fn ip(&self) -> IpAddr {
        self.0
    }

    /// The rate-limit bucket: IPv4 whole, IPv6 by its /64.
    pub fn bucket(&self) -> String {
        match self.0 {
            IpAddr::V4(v4) => v4.to_string(),
            IpAddr::V6(v6) => {
                let prefix = u128::from(v6) & mask128(64);
                format!("{}/64", Ipv6Addr::from(prefix))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn ip(text: &str) -> Option<IpAddr> {
        text.parse().ok()
    }

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, HeaderValue::from_static(value));
        }
        map
    }

    #[test]
    fn ranges() {
        let range = IpRange::parse("172.16.0.0/12").unwrap();
        assert!(range.contains(ip("172.18.0.5").unwrap()));
        assert!(range.contains(ip("::ffff:172.18.0.5").unwrap()));
        assert!(!range.contains(ip("172.32.0.1").unwrap()));
        assert!(
            IpRange::parse("10.0.0.1")
                .unwrap()
                .contains(ip("10.0.0.1").unwrap())
        );
        assert!(
            IpRange::parse("0.0.0.0/0")
                .unwrap()
                .contains(ip("8.8.8.8").unwrap())
        );
        assert!(
            IpRange::parse("fd00::/8")
                .unwrap()
                .contains(ip("fd12::1").unwrap())
        );
        assert!(IpRange::parse("10.0.0.0/33").is_err());
        assert!(IpRange::parse("nonsense").is_err());
    }

    #[test]
    fn untrusted_peer_ignores_headers() {
        let policy = ClientAddressPolicy::parse(Some("172.18.0.0/16"), None).unwrap();
        let forged = headers(&[("x-forwarded-for", "1.2.3.4")]);
        let got = policy.client_address(ip("203.0.113.9"), &forged).unwrap();
        assert_eq!(got.bucket(), "203.0.113.9");
        let none = ClientAddressPolicy::peer_only();
        assert_eq!(
            none.client_address(ip("::ffff:172.18.0.2"), &forged)
                .unwrap()
                .bucket(),
            "172.18.0.2"
        );
    }

    #[test]
    fn trusted_proxy_rightmost_untrusted() {
        let policy = ClientAddressPolicy::parse(Some("172.18.0.0/16, 10.0.0.0/8"), None).unwrap();
        // The client forged `1.2.3.4`; the proxy appended the real address.
        let list = headers(&[("x-forwarded-for", "1.2.3.4, 198.51.100.7")]);
        let got = policy
            .client_address(ip("::ffff:172.18.0.2"), &list)
            .unwrap();
        assert_eq!(got.bucket(), "198.51.100.7");
        // Two trusted hops after the client.
        let chain = headers(&[
            ("x-forwarded-for", "198.51.100.7, 10.1.2.3"),
            ("x-forwarded-for", "172.18.0.9"),
        ]);
        assert_eq!(
            policy
                .client_address(ip("172.18.0.2"), &chain)
                .unwrap()
                .bucket(),
            "198.51.100.7"
        );
        // Missing or garbage: the peer.
        assert_eq!(
            policy
                .client_address(ip("172.18.0.2"), &HeaderMap::new())
                .unwrap()
                .bucket(),
            "172.18.0.2"
        );
        let garbage = headers(&[("x-forwarded-for", "nope, 198.51.100.7")]);
        assert_eq!(
            policy
                .client_address(ip("172.18.0.2"), &garbage)
                .unwrap()
                .bucket(),
            "172.18.0.2"
        );
        // All trusted: the leftmost.
        let internal = headers(&[("x-forwarded-for", "10.9.9.9, 172.18.0.3")]);
        assert_eq!(
            policy
                .client_address(ip("172.18.0.2"), &internal)
                .unwrap()
                .bucket(),
            "10.9.9.9"
        );
    }

    #[test]
    fn single_header_and_ipv6_buckets() {
        let policy =
            ClientAddressPolicy::parse(Some("127.0.0.1"), Some("CF-Connecting-IP")).unwrap();
        let set = headers(&[("cf-connecting-ip", "2001:db8:aa:bb:1:2:3:4")]);
        let got = policy.client_address(ip("127.0.0.1"), &set).unwrap();
        assert_eq!(got.bucket(), "2001:db8:aa:bb::/64");
        assert!(policy.client_address(None, &set).is_none());
        let with_port = headers(&[("cf-connecting-ip", "198.51.100.7:4433")]);
        assert_eq!(
            policy
                .client_address(ip("127.0.0.1"), &with_port)
                .unwrap()
                .bucket(),
            "198.51.100.7"
        );
    }
}
