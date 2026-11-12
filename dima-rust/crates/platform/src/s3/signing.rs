//! Pure S3 SigV4 (no path normalization or double URI escaping).
//! AWS examples: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
use dima_core::{
    SecretBytes, SecretString,
    crypto::digest::{hmac_sha256, sha256},
};
use std::collections::BTreeMap;

/// Intermediates are exposed for deterministic protocol tests. Never contains the secret key.
#[derive(Debug)]
pub struct Signature {
    pub canonical_request: String,
    pub canonical_hash: String,
    pub string_to_sign: String,
    pub signature: String,
    pub authorization: SecretString,
}

/// All header names must be lowercase. Only headers intended to be signed belong here.
/// `path` and `query` are already strictly encoded; query pairs must be sorted.
#[allow(clippy::too_many_arguments)]
pub fn sign(
    method: &str,
    path: &str,
    query: &str,
    headers: &BTreeMap<String, String>,
    payload: &str,
    region: &str,
    access: &str,
    secret: &SecretString,
) -> Signature {
    let date = headers
        .get("x-amz-date")
        .map(String::as_str)
        .unwrap_or_default();
    let short: String = date.chars().take(8).collect();
    let names = headers.keys().cloned().collect::<Vec<_>>().join(";");
    let canonical_headers: String = headers
        .iter()
        .map(|(k, v)| {
            format!(
                "{k}:{}\n",
                v.split_whitespace().collect::<Vec<_>>().join(" ")
            )
        })
        .collect();
    let canonical_request =
        format!("{method}\n{path}\n{query}\n{canonical_headers}\n{names}\n{payload}");
    let canonical_hash = sha256(&canonical_request).hex();
    let scope = format!("{short}/{region}/s3/aws4_request");
    let string_to_sign = format!("AWS4-HMAC-SHA256\n{date}\n{scope}\n{canonical_hash}");
    let mut initial = SecretBytes::from_text("AWS4").expose().to_vec();
    initial.extend_from_slice(secret.expose().as_bytes());
    let mut key = SecretBytes::new(initial);
    for part in [&short, region, "s3", "aws4_request"] {
        key = SecretBytes::new(hmac_sha256(&key, part).bytes().to_vec());
    }
    let signature = hmac_sha256(&key, &string_to_sign).hex();
    let authorization = SecretString::new(format!(
        "AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={names}, Signature={signature}"
    ));
    Signature {
        canonical_request,
        canonical_hash,
        string_to_sign,
        signature,
        authorization,
    }
}
