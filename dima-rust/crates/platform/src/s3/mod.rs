//! S3-compatible storage, ported from `utils/s3.ts` and its direct SDK consumers.
//!
//! PUT accepts bytes (SHA256 + CRC32 headers) or a known-length stream (AWS chunked
//! framing + CRC32 trailer). GET returns a bounded, deadline-carrying HTTP response; callers
//! use `chunk` or `write_to`. DELETE and quiet batch DeleteObjects return no value; partial
//! batch failures remain distinguishable. No presigning or multipart is used by the reference.
//!
//! Configuration is supplied by startup: production endpoint `https://{region}.{endpoint}`,
//! virtual-hosted bucket; S3_ENDPOINT_URL selects path style. Public URLs concatenate the
//! unescaped key exactly as TypeScript does. Upload ACL and cache control belong to callers:
//! trigger public-read/public 31536000; thumbnail public-read/public immutable 31536000;
//! preview public-read/private 86400; widget no ACL/private immutable 31536000.
//! No metadata occurs in the reference. `functions/s3/triggers.s3.ts` is an unused no-op;
//! there is no sanitizer or key builder in that directory. Feature-level key builders stay
//! with their feature (media library, widget content hashes, clip recommendation ids).
//!
//! Reference quirks: even "private" trigger media has public-read ACL; public URLs do not
//! escape keys. An arbitrary Readable without known length fails in the installed SDK with
//! an undefined decoded-content-length header; Rust requires length explicitly instead.
//! No retries are automatic: streaming bodies cannot be safely replayed. Every operation
//! requires a caller deadline (reference had none) and size limit. No unbounded error bodies:
//! XML errors are capped at 64 KiB and never include server-supplied messages in Display.
//!
//! SDK diagnostic headers are signed by its implementation despite having no storage meaning.
//! Rust omits these by default; `diagnostics` permits exact recording replay. Only user-agent,
//! connection, transfer-encoding and cache-control are unsigned in the recordings. Cache-control
//! is still sent. The installed SDK is 3.1110.0 (the ledger says 3.1111.0).
//!
//! Reuse: HTTP Provider/Path/stream limits/deadlines/MockServer, core wiping secrets/clock/
//! SHA256/HMAC, text UTC fields. Local adapters: incremental IEEE CRC32 (not provided by core),
//! static Path arities (no dynamic path API), five XML entities and bounded error extraction
//! (no new XML dependency). No external dependency was added to the workspace. Keys use S3's
//! external byte limit, never a text cut; invalid empty/dot segments are rejected to avoid URL
//! normalization changing a signed identity. Feature-generated keys do not use these segments.
//!
//! Callers: trigger.route uploads and deletes library assets; media_cleanup deletes unused
//! private assets; thumbnail_generator uploads JPEGs; vod_clip_recommendation_runner uploads
//! MP4s; custom_widgets/files PUTs/GETs/deletes content-addressed private files;
//! clip_recommendation_previews performs quiet batches of at most 1000 keys and checks Errors.
//! Upload/read failures propagate; widget cleanup logs and continues. Public URL helper is
//! also consumed by media.route. The thin client leaves database/cache behavior in features.
//!
//! Re-record: from the main checkout's dimabot directory run `TZ=UTC node_modules/.bin/tsx
//! <worktree>/dima-rust/crates/platform/tests/record-sdk.ts <worktree>/dima-rust/crates/
//! platform/tests/sdk-requests.json`. Recorder binds 127.0.0.1:18743, uses test credentials
//! and 2013-05-24 UTC. Invocation ids vary; tests replay every signed diagnostic value.
//! Tests normalize only the ephemeral MockServer host/port before comparing fixture signatures;
//! the transmitted authorization is separately checked against the actual host.
mod checksum;
pub mod signing;
use bytes::Bytes;
use dima_core::{Clock, SecretString, crypto::digest::sha256};
use dima_http::{HttpClient, Method, Path, Provider, Response, StreamBody};
use futures_util::{Stream, StreamExt};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use url::Url;

#[derive(Clone, Copy, Debug)]
pub enum Addressing {
    Path,
    VirtualHost,
}
#[derive(Debug)]
pub struct Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_key: SecretString,
    pub addressing: Addressing,
    pub public_url: String,
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid S3 configuration or request")]
    Invalid,
    #[error("S3 object not found")]
    NotFound,
    #[error("S3 access denied")]
    AccessDenied,
    #[error("S3 service error ({status})")]
    Service { status: u16, code: String },
    #[error("S3 partial batch deletion failure")]
    PartialDelete { codes: Vec<String> },
    #[error("S3 body exceeds limit")]
    TooLarge,
    #[error("S3 transport: {0}")]
    Transport(#[from] dima_http::Error),
}
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_bytes: u64,
    pub timeout: Duration,
}
#[derive(Default, Debug)]
pub struct PutOptions<'a> {
    pub content_type: &'a str,
    pub cache_control: Option<&'a str>,
    pub public_read: bool,
}
/// SDK diagnostic headers, used only when exact signature reproduction is required.
#[derive(Default, Debug)]
pub struct Diagnostics {
    pub invocation_id: String,
    pub request: String,
    pub user_agent: String,
}
#[derive(Debug)]
pub struct Client {
    http: HttpClient,
    provider: Provider,
    config: Config,
    clock: Arc<dyn Clock>,
    diagnostics: Option<Diagnostics>,
}
/// A prepared signed request for inspection; authorization is redacted.
#[derive(Debug)]
pub struct Prepared {
    pub method: Method,
    pub path: Path,
    pub query: String,
    pub headers: BTreeMap<String, String>,
    pub authorization: SecretString,
}
impl Client {
    pub fn new(http: HttpClient, config: Config, clock: Arc<dyn Clock>) -> Result<Self, Error> {
        let mut endpoint = Url::parse(&config.endpoint).map_err(|_| Error::Invalid)?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || config.bucket.is_empty()
            || config.region.is_empty()
            || config.access_key_id.is_empty()
            || config.secret_key.is_empty()
        {
            return Err(Error::Invalid);
        }
        if matches!(config.addressing, Addressing::VirtualHost) {
            let host = format!(
                "{}.{}",
                config.bucket,
                endpoint.host_str().ok_or(Error::Invalid)?
            );
            endpoint.set_host(Some(&host)).map_err(|_| Error::Invalid)?;
        }
        let provider = Provider::builder("s3", endpoint.as_str())
            .build()
            .map_err(|_| Error::Invalid)?;
        Ok(Self {
            http,
            provider,
            config,
            clock,
            diagnostics: None,
        })
    }
    pub fn with_diagnostics(mut self, diagnostics: Diagnostics) -> Self {
        self.diagnostics = Some(diagnostics);
        self
    }
    pub fn public_object_url(&self, key: &str) -> String {
        format!("{}/{key}", self.config.public_url)
    }
    /// Strict path escaping via shared Path; preserve slash boundaries (no normalization).
    /// Shared Path requires static templates: build.rs supplies every arity possible within
    /// S3's 1024-byte key limit. Each segment uses its strict signing encoder.
    #[allow(clippy::too_many_arguments)]
    pub fn prepare(
        &self,
        method: Method,
        key: Option<&str>,
        query: &str,
        mut headers: BTreeMap<String, String>,
        payload: &str,
        diagnostics: Option<&Diagnostics>,
    ) -> Result<Prepared, Error> {
        let key = key.unwrap_or("");
        let bucket = if matches!(self.config.addressing, Addressing::Path) {
            format!("/{}/", self.config.bucket)
        } else {
            "/".to_owned()
        };
        let path = object_path(&bucket, key)?;
        let base = self.provider.base_url();
        let host = match base.port() {
            Some(port) => format!("{}:{port}", base.host_str().ok_or(Error::Invalid)?),
            None => base.host_str().ok_or(Error::Invalid)?.to_owned(),
        };
        headers.insert("host".into(), host);
        let f = dima_text::utc_fields(self.clock.now_ms()).ok_or(Error::Invalid)?;
        if !(0..=9999).contains(&f.year) {
            return Err(Error::Invalid);
        }
        headers.insert(
            "x-amz-date".into(),
            format!(
                "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
                f.year,
                f.month + 1,
                f.day,
                f.hour,
                f.minute,
                f.second
            ),
        );
        headers.insert("x-amz-content-sha256".into(), payload.into());
        if let Some(d) = diagnostics.or(self.diagnostics.as_ref()) {
            headers.insert("amz-sdk-invocation-id".into(), d.invocation_id.clone());
            headers.insert("amz-sdk-request".into(), d.request.clone());
            headers.insert("x-amz-user-agent".into(), d.user_agent.clone());
        }
        let signed = headers
            .iter()
            .filter(|(k, _)| !matches!(k.as_str(), "cache-control" | "transfer-encoding"))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let full_path = format!("{}{}", base.path().trim_end_matches('/'), path.as_str());
        let signature = signing::sign(
            method.as_str(),
            &full_path,
            query,
            &signed,
            payload,
            &self.config.region,
            &self.config.access_key_id,
            &self.config.secret_key,
        );
        Ok(Prepared {
            method,
            path,
            query: query.into(),
            headers,
            authorization: signature.authorization,
        })
    }
    async fn send(
        &self,
        prepared: Prepared,
        body: StreamBody,
        limits: Limits,
    ) -> Result<Response, Error> {
        if limits.timeout.is_zero() {
            return Err(Error::Invalid);
        }
        let mut request = self
            .http
            .request(&self.provider, prepared.method, prepared.path)
            .raw_query(&prepared.query)
            .body_stream(body)
            .max_request_bytes(limits.max_bytes)
            .max_bytes(limits.max_bytes.max(65536))
            .timeout(limits.timeout)
            .secret_header("authorization", &prepared.authorization);
        for (k, v) in &prepared.headers {
            request = request.header(k, v);
        }
        let response = request.send().await?;
        if response.status().is_success() {
            return Ok(response.max_bytes(limits.max_bytes));
        }
        let status = response.status().as_u16();
        let xml = response.max_bytes(65536).text().await?;
        let code = xml_value(&xml, "Code").unwrap_or_else(|| "Unknown".into());
        Err(match code.as_str() {
            "NoSuchKey" | "NotFound" | "NoSuchBucket" => Error::NotFound,
            "AccessDenied" => Error::AccessDenied,
            _ if status == 404 => Error::NotFound,
            _ if status == 403 => Error::AccessDenied,
            _ => Error::Service { status, code },
        })
    }
    pub async fn put(
        &self,
        key: &str,
        body: Bytes,
        options: PutOptions<'_>,
        limits: Limits,
    ) -> Result<(), Error> {
        if body.len() as u64 > limits.max_bytes {
            return Err(Error::TooLarge);
        }
        let mut headers = put_headers(options);
        headers.insert("content-length".into(), body.len().to_string());
        headers.insert("x-amz-checksum-crc32".into(), checksum::crc32(&body));
        let prepared = self.prepare(
            Method::PUT,
            Some(key),
            "x-id=PutObject",
            headers,
            &sha256(&body).hex(),
            None,
        )?;
        self.send(prepared, StreamBody::from(body), limits).await?;
        Ok(())
    }
    /// Known-length streaming upload. CRC32 is computed incrementally; memory is one input chunk.
    pub async fn put_stream<S>(
        &self,
        key: &str,
        stream: S,
        length: u64,
        options: PutOptions<'_>,
        limits: Limits,
    ) -> Result<(), Error>
    where
        S: Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static,
    {
        if length > limits.max_bytes {
            return Err(Error::TooLarge);
        }
        let mut headers = put_headers(options);
        headers.insert("content-encoding".into(), "aws-chunked".into());
        headers.insert("x-amz-decoded-content-length".into(), length.to_string());
        headers.insert("x-amz-trailer".into(), "x-amz-checksum-crc32".into());
        let prepared = self.prepare(
            Method::PUT,
            Some(key),
            "x-id=PutObject",
            headers,
            "STREAMING-UNSIGNED-PAYLOAD-TRAILER",
            None,
        )?;
        let state = (Box::pin(stream), checksum::Crc32::new(), 0u64, false);
        let encoded = futures_util::stream::unfold(
            state,
            move |(mut stream, mut crc, mut read, done)| async move {
                if done {
                    return None;
                }
                while let Some(chunk) = stream.next().await {
                    let bytes = match chunk {
                        Ok(b) => b,
                        Err(e) => return Some((Err(e), (stream, crc, read, true))),
                    };
                    read = read.saturating_add(bytes.len() as u64);
                    if read > length {
                        return Some((
                            Err(std::io::Error::other("S3 upload length exceeded")),
                            (stream, crc, read, true),
                        ));
                    }
                    if bytes.is_empty() {
                        continue;
                    }
                    crc.update(&bytes);
                    let mut framed = format!("{:x}\r\n", bytes.len()).into_bytes();
                    framed.extend_from_slice(&bytes);
                    framed.extend_from_slice(b"\r\n");
                    return Some((Ok(Bytes::from(framed)), (stream, crc, read, false)));
                }
                let last = if read != length {
                    Err(std::io::Error::other("S3 upload cut short"))
                } else {
                    Ok(Bytes::from(format!(
                        "0\r\nx-amz-checksum-crc32:{}\r\n\r\n",
                        crc.base64()
                    )))
                };
                Some((last, (stream, crc, read, true)))
            },
        );
        // Wire framing can exceed the decoded size. Decoded count is independently checked above.
        let wire_limits = Limits {
            max_bytes: limits.max_bytes.saturating_mul(8).saturating_add(1024),
            ..limits
        };
        self.send(prepared, StreamBody::wrap_stream(encoded), wire_limits)
            .await?;
        Ok(())
    }
    pub async fn get(&self, key: &str, limits: Limits) -> Result<Response, Error> {
        let h = BTreeMap::from([("x-amz-checksum-mode".into(), "ENABLED".into())]);
        let p = self.prepare(
            Method::GET,
            Some(key),
            "x-id=GetObject",
            h,
            &sha256("").hex(),
            None,
        )?;
        self.send(p, StreamBody::from(Bytes::new()), limits).await
    }
    pub async fn delete(&self, key: &str, limits: Limits) -> Result<(), Error> {
        let p = self.prepare(
            Method::DELETE,
            Some(key),
            "x-id=DeleteObject",
            BTreeMap::new(),
            &sha256("").hex(),
            None,
        )?;
        self.send(p, StreamBody::from(Bytes::new()), limits).await?;
        Ok(())
    }
    /// At most 1000 keys, quiet mode. Caller owns batching and validation of feature scope.
    pub async fn delete_objects(&self, keys: &[&str], limits: Limits) -> Result<(), Error> {
        if keys.is_empty() || keys.len() > 1000 {
            return Err(Error::Invalid);
        }
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Delete xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
        );
        for key in keys {
            if key.is_empty() || key.len() > 1024 {
                return Err(Error::Invalid);
            }
            let element = format!("<Object><Key>{}</Key></Object>", escape_xml(key));
            if (xml.len() + element.len() + "<Quiet>true</Quiet></Delete>".len()) as u64
                > limits.max_bytes
            {
                return Err(Error::TooLarge);
            }
            xml.push_str(&element);
        }
        xml.push_str("<Quiet>true</Quiet></Delete>");
        if xml.len() as u64 > limits.max_bytes {
            return Err(Error::TooLarge);
        }
        let h = BTreeMap::from([
            ("content-type".into(), "application/xml".into()),
            ("content-length".into(), xml.len().to_string()),
            ("x-amz-sdk-checksum-algorithm".into(), "CRC32".into()),
            (
                "x-amz-checksum-crc32".into(),
                checksum::crc32(xml.as_bytes()),
            ),
        ]);
        let p = self.prepare(Method::POST, None, "delete=", h, &sha256(&xml).hex(), None)?;
        let result = self
            .send(p, StreamBody::from(xml), limits)
            .await?
            .max_bytes(65536)
            .text()
            .await?;
        let codes = result
            .split("<Error>")
            .skip(1)
            .map(|part| xml_value(part, "Code").unwrap_or_else(|| "Unknown".into()))
            .collect::<Vec<_>>();
        if codes.is_empty() {
            Ok(())
        } else {
            Err(Error::PartialDelete { codes })
        }
    }
}
fn put_headers(options: PutOptions<'_>) -> BTreeMap<String, String> {
    let mut h = BTreeMap::from([
        ("content-type".into(), options.content_type.into()),
        ("x-amz-sdk-checksum-algorithm".into(), "CRC32".into()),
    ]);
    if let Some(cache) = options.cache_control {
        h.insert("cache-control".into(), cache.into());
    }
    if options.public_read {
        h.insert("x-amz-acl".into(), "public-read".into());
    }
    h
}
fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&apos;")
        .replace('"', "&quot;")
        .replace('\r', "&#x0D;")
        .replace('\n', "&#x0A;")
}
fn xml_value(xml: &str, tag: &str) -> Option<String> {
    let value = xml
        .split_once(&format!("<{tag}>"))?
        .1
        .split_once(&format!("</{tag}>"))?
        .0;
    Some(
        value
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&apos;", "'")
            .replace("&quot;", "\"")
            .replace("&amp;", "&"),
    )
}
/// Local workaround for shared Path's fixed arity: percent escapes in a dynamic *template*
/// require a static lifetime. Instead render all segments with a bounded set of templates.
/// These limits are internal: S3 keys have at most 1024 UTF-8 bytes. Never truncate text.
fn object_path(bucket: &str, key: &str) -> Result<Path, Error> {
    let mut args: Vec<&str> = Vec::new();
    if bucket != "/" {
        args.push(bucket.trim_matches('/'));
    }
    if !key.is_empty() {
        args.extend(key.split('/'));
    }
    if key.len() > 1024 {
        return Err(Error::TooLarge);
    }
    // Shared Path rejects empty/dot segments. Reject them explicitly rather than normalize a
    // signed object identity. The reference's generated keys contain none of these segments.
    if key.is_empty() && !args.is_empty() {
        return Path::template("/{}/", &args).map_err(|_| Error::Invalid);
    }
    Path::template(TEMPLATES.get(args.len()).ok_or(Error::Invalid)?, &args)
        .map_err(|_| Error::Invalid)
}

include!(concat!(env!("OUT_DIR"), "/paths.rs"));
