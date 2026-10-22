//! S3-compatible object storage, mirroring `dimabot/src/utils/s3.ts`.
//!
//! Settings come from `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY`,
//! `S3_SECRET_KEY`, `S3_BUCKET`, and optional `S3_PUBLIC_URL`. The endpoint is
//! `https://{S3_REGION}.{S3_ENDPOINT}` with virtual-hosted bucket addressing,
//! and public URLs default to `https://{bucket}.{region}.{endpoint}/{key}`,
//! exactly as in TypeScript. Uploads use `ACL: public-read` and a one-year
//! immutable-style `Cache-Control`, matching `uploadTriggerFileToS3`.
//!
//! The SDK's default request checksums (`WhenSupported`) are kept, which is
//! also the default of the `@aws-sdk/client-s3` version used by dimabot.

// Returns the SDK's own `SdkError`, as every aws-sdk-s3 operation does.
#![allow(clippy::result_large_err)]

use std::env;

use aws_sdk_s3::{
    Client,
    config::{BehaviorVersion, Credentials, Region},
    error::SdkError,
    operation::{delete_object::DeleteObjectError, put_object::PutObjectError},
    primitives::ByteStream,
    types::ObjectCannedAcl,
};

/// `Cache-Control` applied to uploads, same as TypeScript.
pub const UPLOAD_CACHE_CONTROL: &str = "public, max-age=31536000";

const MISSING_MESSAGE: &str = concat!(
    "S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, and S3_BUCKET must all be set; ",
    "values are omitted from this error"
);

/// Storage settings read from the environment.
#[derive(Clone, PartialEq, Eq)]
pub struct S3Settings {
    pub region: String,
    pub endpoint_url: String,
    pub access_key: String,
    pub secret_key: String,
    pub bucket: String,
    pub public_url: String,
    /// Path-style addressing; production uses virtual-hosted (`false`).
    pub force_path_style: bool,
}

impl std::fmt::Debug for S3Settings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("S3Settings")
            .field("region", &self.region)
            .field("endpoint_url", &self.endpoint_url)
            .field("bucket", &self.bucket)
            .field("public_url", &self.public_url)
            .field("force_path_style", &self.force_path_style)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct S3ConfigError;

impl std::fmt::Display for S3ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(MISSING_MESSAGE)
    }
}

impl std::error::Error for S3ConfigError {}

impl S3Settings {
    pub fn from_env() -> Result<Self, S3ConfigError> {
        let read = |name: &str| env::var(name).ok().filter(|value| !value.trim().is_empty());
        Self::from_values(
            read("S3_REGION"),
            read("S3_ENDPOINT"),
            read("S3_ACCESS_KEY"),
            read("S3_SECRET_KEY"),
            read("S3_BUCKET"),
            read("S3_PUBLIC_URL"),
        )
    }

    fn from_values(
        region: Option<String>,
        endpoint: Option<String>,
        access_key: Option<String>,
        secret_key: Option<String>,
        bucket: Option<String>,
        public_url: Option<String>,
    ) -> Result<Self, S3ConfigError> {
        let (Some(region), Some(endpoint), Some(access_key), Some(secret_key), Some(bucket)) =
            (region, endpoint, access_key, secret_key, bucket)
        else {
            return Err(S3ConfigError);
        };
        let public_url =
            public_url.unwrap_or_else(|| format!("https://{bucket}.{region}.{endpoint}"));
        Ok(Self {
            endpoint_url: format!("https://{region}.{endpoint}"),
            region,
            access_key,
            secret_key,
            bucket,
            public_url,
            force_path_style: false,
        })
    }

    /// Public URL for an object key, matching `getS3PublicObjectUrl`.
    pub fn public_object_url(&self, key: &str) -> String {
        format!("{}/{key}", self.public_url)
    }
}

/// Owns a configured SDK client and bucket.
#[derive(Debug, Clone)]
pub struct ObjectStorage {
    client: Client,
    settings: S3Settings,
}

impl ObjectStorage {
    pub fn new(settings: S3Settings) -> Self {
        let credentials = Credentials::new(
            settings.access_key.clone(),
            settings.secret_key.clone(),
            None,
            None,
            "dima-rust-env",
        );
        let config = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new(settings.region.clone()))
            .endpoint_url(settings.endpoint_url.clone())
            .credentials_provider(credentials)
            .force_path_style(settings.force_path_style)
            .build();
        Self {
            client: Client::from_conf(config),
            settings,
        }
    }

    pub fn from_env() -> Result<Self, S3ConfigError> {
        Ok(Self::new(S3Settings::from_env()?))
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn settings(&self) -> &S3Settings {
        &self.settings
    }

    /// Uploads a public object and returns its public URL, like
    /// `uploadTriggerFileToS3`.
    pub async fn upload_public_object(
        &self,
        key: &str,
        body: impl Into<ByteStream>,
        content_type: &str,
    ) -> Result<String, SdkError<PutObjectError>> {
        self.client
            .put_object()
            .bucket(&self.settings.bucket)
            .key(key)
            .body(body.into())
            .content_type(content_type)
            .acl(ObjectCannedAcl::PublicRead)
            .cache_control(UPLOAD_CACHE_CONTROL)
            .send()
            .await?;
        Ok(self.settings.public_object_url(key))
    }

    /// Deletes an object, like `deleteTriggerFileFromS3`.
    pub async fn delete_object(&self, key: &str) -> Result<(), SdkError<DeleteObjectError>> {
        self.client
            .delete_object()
            .bucket(&self.settings.bucket)
            .key(key)
            .send()
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::utils::test_http::{CannedResponse, Recorder};

    fn values(public_url: Option<&str>) -> Result<S3Settings, S3ConfigError> {
        S3Settings::from_values(
            Some("nyc3".into()),
            Some("digitaloceanspaces.com".into()),
            Some("AKIDEXAMPLE".into()),
            Some("secret-value".into()),
            Some("dima-media".into()),
            public_url.map(str::to_owned),
        )
    }

    #[test]
    fn builds_endpoint_and_public_urls_like_typescript() {
        let settings = values(None).unwrap();
        assert_eq!(settings.endpoint_url, "https://nyc3.digitaloceanspaces.com");
        assert!(!settings.force_path_style);
        assert_eq!(
            settings.public_object_url("triggers/1/a.png"),
            "https://dima-media.nyc3.digitaloceanspaces.com/triggers/1/a.png"
        );
        let custom = values(Some("https://cdn.example.com")).unwrap();
        assert_eq!(
            custom.public_object_url("a.png"),
            "https://cdn.example.com/a.png"
        );
    }

    #[test]
    fn missing_settings_fail_without_secrets_in_debug_or_error() {
        let error = S3Settings::from_values(None, None, None, None, None, None).unwrap_err();
        assert_eq!(error.to_string(), MISSING_MESSAGE);
        let debug = format!("{:?}", values(None).unwrap());
        assert!(!debug.contains("secret-value") && !debug.contains("AKIDEXAMPLE"));
    }

    #[tokio::test]
    async fn https_transport_selects_its_own_tls_provider() {
        let mut settings = values(None).unwrap();
        settings.endpoint_url = "https://127.0.0.1:9".to_owned();
        settings.force_path_style = true;
        let error = ObjectStorage::new(settings)
            .delete_object("a.txt")
            .await
            .expect_err("nothing listens on port 9");
        assert!(matches!(error, SdkError::DispatchFailure(_)), "{error:?}");
    }

    #[tokio::test]
    async fn uploads_public_objects_and_deletes_them() {
        let recorder = Recorder::start(|request| match request.method.as_str() {
            "PUT" => CannedResponse {
                status: 200,
                headers: vec![("etag", "\"abc\"".to_owned())],
                body: Vec::new(),
            },
            _ => CannedResponse {
                status: 204,
                headers: Vec::new(),
                body: Vec::new(),
            },
        });
        let mut settings = values(None).unwrap();
        settings.endpoint_url = recorder.base_url.clone();
        settings.force_path_style = true;
        let storage = ObjectStorage::new(settings);

        let url = storage
            .upload_public_object("triggers/1/a.txt", b"hello".to_vec(), "text/plain")
            .await
            .expect("the recorder accepts the upload");
        assert_eq!(
            url,
            "https://dima-media.nyc3.digitaloceanspaces.com/triggers/1/a.txt"
        );

        let put = recorder.next(Duration::from_secs(10));
        assert_eq!(put.method, "PUT");
        assert!(
            put.path.starts_with("/dima-media/triggers/1/a.txt"),
            "{}",
            put.path
        );
        assert_eq!(put.header("x-amz-acl"), Some("public-read"));
        assert_eq!(put.header("cache-control"), Some(UPLOAD_CACHE_CONTROL));
        assert_eq!(put.header("content-type"), Some("text/plain"));
        assert!(put.body.windows(5).any(|window| window == b"hello"));
        let authorization = put.header("authorization").expect("signed request");
        assert!(authorization.starts_with("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/"));
        assert!(authorization.contains("/nyc3/s3/aws4_request"));
        assert!(!authorization.contains("secret-value"));

        storage
            .delete_object("triggers/1/a.txt")
            .await
            .expect("the recorder accepts the delete");
        let delete = recorder.next(Duration::from_secs(10));
        assert_eq!(delete.method, "DELETE");
        assert!(
            delete.path.starts_with("/dima-media/triggers/1/a.txt"),
            "{}",
            delete.path
        );
    }
}
