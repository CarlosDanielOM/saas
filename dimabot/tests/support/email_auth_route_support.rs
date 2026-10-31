#![allow(dead_code)]
use std::{path::PathBuf, sync::{Arc, atomic::{AtomicUsize, Ordering}}};
use mongodb::bson::Document;
use dima_rust::email_auth_route::{ActivationUsers, LookupFuture};
#[path = "sha256.rs"] mod digest;
pub fn fixture() -> serde_json::Value {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).canonicalize().unwrap().parent().unwrap().to_path_buf();
    let dir = PathBuf::from(std::env::var_os("DIMA_EMAIL_AUTH_FIXTURE_DIR").expect("fixture directory"));
    assert!(dir.is_absolute() && dir.canonicalize().unwrap() == dir && !dir.starts_with(workspace));
    let path = dir.join("email-auth-route-reference.json"); assert!(std::fs::symlink_metadata(&path).unwrap().file_type().is_file());
    let bytes = std::fs::read(path).unwrap(); let hash = std::env::var("DIMA_EMAIL_AUTH_FIXTURE_SHA256").expect("fixture sha256"); assert_eq!(digest::sha256_hex(&bytes), hash);
    serde_json::from_slice(&bytes).unwrap()
}
pub struct Users { pub value: Result<Option<Document>, ()>, pub calls: Arc<AtomicUsize> }
impl ActivationUsers for Users { fn find<'a>(&'a self, _: &'a str) -> LookupFuture<'a> { self.calls.fetch_add(1, Ordering::SeqCst); let value = self.value.clone(); Box::pin(async move { value }) } }
