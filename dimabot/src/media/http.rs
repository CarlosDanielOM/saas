//! Byte-range parsing from `assets/http.ts`. Ranges use an inclusive end and
//! invalid or unsatisfiable ranges produce the source's 416 `invalid_range`.

use super::library::AssetError;

/// A resolved inclusive byte range and whether it came from a Range header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ByteRange {
    /// First byte.
    pub start: u64,
    /// Last byte, inclusive.
    pub end: u64,
    /// Whether to return status 206 and a Content-Range header.
    pub partial: bool,
}

/// Resolve the single `bytes=` range supported by the TypeScript handler.
pub fn resolve_range(size: u64, header: Option<&str>) -> Result<ByteRange, AssetError> {
    let invalid = || AssetError { code: "invalid_range", status: 416 };
    let Some(last) = size.checked_sub(1) else { return Err(invalid()) };
    let Some(header) = header else { return Ok(ByteRange { start: 0, end: last, partial: false }) };
    let value = header.strip_prefix("bytes=").ok_or_else(invalid)?;
    let (first, second) = value.split_once('-').ok_or_else(invalid)?;
    if first.is_empty() && second.is_empty() || !first.bytes().all(|b| b.is_ascii_digit()) || !second.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid());
    }
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let parse = |s: &str| s.parse::<f64>().map_err(|_| invalid());
    let safe = |n: f64| n.is_finite() && n >= 0.0 && n <= MAX_SAFE && n.fract() == 0.0;
    let (start, end) = if first.is_empty() {
        ((size as f64 - parse(second)?).max(0.0), last as f64)
    } else {
        (parse(first)?, if second.is_empty() { last as f64 } else { (last as f64).min(parse(second)?) })
    };
    if !safe(start) || !safe(end) { return Err(invalid()); }
    let (start, end) = (start as u64, end as u64);
    if start > end || start >= size { return Err(invalid()); }
    Ok(ByteRange { start, end, partial: true })
}

/// Resolve a request against the actual GridFS length without allocating.
pub fn resolve_real_range(size: u64, header: Option<&str>) -> Result<ByteRange, AssetError> {
    resolve_range(size, header)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_range() { assert_eq!(resolve_range(10, None).expect("valid").end, 9); }
    #[test]
    fn bounded_range_is_clamped() { assert_eq!(resolve_range(10, Some("bytes=2-99")).expect("valid").end, 9); }
    #[test]
    fn suffix_range() { assert_eq!(resolve_range(10, Some("bytes=-3")).expect("valid").start, 7); }
    #[test]
    fn open_range() { assert_eq!(resolve_range(10, Some("bytes=5-")).expect("valid").start, 5); }
    #[test]
    fn invalid_ranges_fail() {
        for value in ["bytes=-", "bytes=10-", "bytes=4-3", "bytes=0-1,3-4", "bytes=-0"] {
            assert_eq!(resolve_range(10, Some(value)).expect_err("invalid").status, 416);
        }
    }
    #[test]
    fn clamped_end_differs_from_invalid_start() {
        let range = resolve_real_range(10, Some("bytes=0-999999")).expect("clamped");
        assert_eq!((range.start, range.end, range.partial), (0, 9, true));
        assert_eq!(format!("bytes {}-{}/10", range.start, range.end), "bytes 0-9/10");
        assert_eq!(range.end - range.start + 1, 10);
        assert_eq!(resolve_real_range(10, Some("bytes=10-")).expect_err("start beyond end").status, 416);
        assert_eq!(format!("bytes */{}", 10), "bytes */10");
        assert_eq!(resolve_real_range(10, Some("bytes=99999999999999999999-")).expect_err("unsafe start").status, 416);
        assert_eq!(resolve_real_range(10, Some("bytes=-999999")).expect("suffix").start, 0);
    }
}

use axum::{body::Body, http::{HeaderMap, HeaderValue, Method, StatusCode, header}, response::Response};
use futures_util::{io::AsyncReadExt, stream};
use super::library::AssetLibrary;

/// Serve a ready private asset with source security, range, and cache headers.
/// Ranges are fetched directly from the covering GridFS chunks.
pub async fn serve_asset(library: &AssetLibrary, owner: &str, id: &str, method: &Method, request: &HeaderMap, revalidate: bool) -> Result<Response, AssetError> {
    let asset = library.find_asset(owner, id).await?;
    let size = library.real_length(owner, id).await?;
    let mut response = Response::new(Body::empty());
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(if revalidate { "private, no-cache" } else { "private, no-store" }));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; sandbox"));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    let mime = asset.string("mime").ok_or(AssetError { code: "unavailable", status: 500 })?;
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(mime).map_err(|_| AssetError { code: "unavailable", status: 500 })?);
    if revalidate {
        let etag = format!("\"asset-{id}\"");
        headers.insert(header::ETAG, HeaderValue::from_str(&etag).map_err(|_| AssetError { code: "unavailable", status: 500 })?);
        let fresh = request.get(header::IF_NONE_MATCH).and_then(|value| value.to_str().ok()).is_some_and(|value| value.split(',').any(|part| { let part = part.trim(); part == "*" || part.strip_prefix("W/").unwrap_or(part) == etag }));
        if fresh { *response.status_mut() = StatusCode::NOT_MODIFIED; return Ok(response); }
    }
    let raw = request.get(header::RANGE).and_then(|value| value.to_str().ok());
    let range = match resolve_real_range(size, raw) {
        Ok(range) => range,
        Err(_) => {
            *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
            *response.body_mut() = Body::from(r#"{"error":true,"status":416,"code":"invalid_range","message":"invalid_range"}"#);
            response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
            response.headers_mut().insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{size}")).map_err(|_| AssetError { code: "unavailable", status: 500 })?);
            return Ok(response);
        }
    };
    if range.partial {
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
        response.headers_mut().insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes {}-{}/{size}", range.start, range.end)).map_err(|_| AssetError { code: "unavailable", status: 500 })?);
    }
    let length = range.end - range.start + 1;
    response.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from_str(&length.to_string()).map_err(|_| AssetError { code: "unavailable", status: 500 })?);
    if *method == Method::HEAD { return Ok(response); }
    if range.partial {
        let bytes = library.read_range(owner, id, range.start, range.end + 1).await?;
        *response.body_mut() = Body::from(bytes);
        return Ok(response);
    }
    let (_, source) = library.read_asset(owner, id).await?;
    let limited = source.take(length);
    let body = stream::unfold(limited, |mut source| async move {
        let mut bytes = vec![0u8; 16384];
        match source.read(&mut bytes).await {
            Ok(0) => None,
            Ok(count) => { bytes.truncate(count); Some((Ok::<_, std::io::Error>(bytes), source)) },
            Err(error) => Some((Err(error), source)),
        }
    });
    *response.body_mut() = Body::from_stream(body);
    Ok(response)
}
