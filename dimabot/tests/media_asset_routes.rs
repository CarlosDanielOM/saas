//! Loopback route checks against explicitly leased private Mongo/GridFS fixtures.
#![cfg(feature = "media-assets")]

#[path = "support/api_admin.rs"]
mod api_admin;

use std::{path::Path, sync::Arc};
use axum::middleware;
use dima_rust::media_assets::{asset_library_route::AssetLibraryRouteService, library::{AssetConsumer, AssetError, AssetFuture, AssetInspector, AssetLibrary, Inspection}};
use mongodb::{Database, bson::{Document, doc, oid::ObjectId}};
use serde_json::json;

struct Inspector;
impl AssetInspector for Inspector {
    fn inspect<'a>(&'a self, _path: &'a Path) -> AssetFuture<'a, Result<Inspection, AssetError>> {
        Box::pin(async { Ok(Inspection { mime:"image/png", kind:"image", width:1, height:1, duration:None }) })
    }
}
struct Consumer;
impl AssetConsumer for Consumer {
    fn in_use<'a>(&'a self, _: &'a str, _: &'a str) -> AssetFuture<'a, Result<bool, AssetError>> { Box::pin(async { Ok(false) }) }
}
fn routes(db: Database, secret: Option<Vec<u8>>) -> axum::Router {
    let library = AssetLibrary::with_adapters(db, Arc::new(Inspector));
    library.register_asset_consumer("pet".into(), Arc::new(Consumer)).expect("pet");
    library.register_asset_consumer("overlay-studio".into(), Arc::new(Consumer)).expect("overlay");
    let service = AssetLibraryRouteService::new(library, secret);
    let authenticated = service.authenticated_router().layer(middleware::from_fn(api_admin::fixture_identity));
    service.with_public(authenticated)
}

#[tokio::test]
#[ignore = "requires explicitly leased task-owned keyword-mongo fixture and loopback listener"]
async fn multipart_ticket_range_and_owner_routes() {
    let fixture = api_admin::fixtures(&format!("media{}", ObjectId::new().to_hex())).await;
    let db = fixture.database.clone();
    db.collection::<Document>("users").insert_one(doc! {"accounts":[{"type":"twitch","id":"fixture-owner"}],"plan_tier":"free"}).await.expect("user");
    let app = api_admin::serve_app(routes(db.clone(), Some(b"fixture secret".to_vec()))).await;
    let client = reqwest::Client::new();
    let body = b"--fixture-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\nfixture-image-bytes\r\n--fixture-boundary--\r\n";
    let response = client.post(api_admin::app_url(app.addr, "/fixture-owner"))
        .header(api_admin::FIXTURE_USER_HEADER, "fixture-owner")
        .header("content-type", "multipart/form-data; boundary=fixture-boundary")
        .body(body.to_vec()).send().await.expect("upload response");
    assert_eq!(response.status().as_u16(), 200);
    let result: serde_json::Value = response.json().await.expect("upload JSON");
    let id = result["data"]["id"].as_str().expect("asset id");
    let oid = ObjectId::parse_str(id).expect("id");
    assert!(db.collection::<Document>("private_assets.files").find_one(doc! {"_id":oid}).await.expect("GridFS file").is_some());
    let (status, list) = api_admin::get_as(&client, &api_admin::app_url(app.addr, "/fixture-owner"), Some("fixture-owner")).await;
    assert_eq!(status, 200);
    assert_eq!(list["data"]["usedBytes"], 19);
    assert_eq!(api_admin::get_as(&client, &api_admin::app_url(app.addr, "/fixture-owner"), Some("other")).await.0, 403);
    let access = format!("/fixture-owner/{id}/access");
    let (status, issued) = api_admin::get_as(&client, &api_admin::app_url(app.addr, &access), Some("fixture-owner")).await;
    assert_eq!(status, 200);
    let path = issued["data"]["path"].as_str().expect("ticket path").strip_prefix("/asset-library").expect("mount prefix");
    db.collection::<Document>("asset_libraries").update_one(doc! {"_id":"fixture-owner", "assets.id":id}, doc! {"$set":{"assets.$.bytes":999_i64}}).await.expect("stale recorded size fixture");
    let content = client.get(api_admin::app_url(app.addr, path)).send().await.expect("preview");
    assert_eq!(content.status().as_u16(), 200);
    assert_eq!(&content.bytes().await.expect("preview bytes")[..], b"fixture-image-bytes");
    let partial = client.get(api_admin::app_url(app.addr, path)).header("range", "bytes=1-3").send().await.expect("partial");
    assert_eq!(partial.status().as_u16(), 206);
    assert_eq!(&partial.bytes().await.expect("range bytes")[..], b"ixt");
    let clamped = client.get(api_admin::app_url(app.addr, path)).header("range", "bytes=0-18446744073709551615").send().await.expect("clamped range");
    assert_eq!(clamped.status().as_u16(), 206);
    assert_eq!(clamped.headers().get("content-range").expect("clamped range"), "bytes 0-18/19");
    assert_eq!(clamped.headers().get("content-length").expect("clamped length"), "19");
    assert_eq!(&clamped.bytes().await.expect("clamped body")[..], b"fixture-image-bytes");
    let invalid = client.get(api_admin::app_url(app.addr, path)).header("range", "bytes=19-").send().await.expect("invalid range");
    assert_eq!(invalid.status().as_u16(), 416);
    assert_eq!(invalid.headers().get("content-range").expect("real length"), "bytes */19");
    let (preview_path, token) = path.split_once("?ticket=").expect("signed preview");
    let mut altered = token.as_bytes().to_vec();
    let payload_start = altered.iter().position(|byte| *byte == b'.').expect("first segment") + 1;
    altered[payload_start] = if altered[payload_start] == b'A' { b'B' } else { b'A' };
    let altered = std::str::from_utf8(&altered).expect("ASCII ticket");
    assert_eq!(client.get(api_admin::app_url(app.addr, &format!("{preview_path}?ticket={altered}"))).send().await.expect("tampered").status().as_u16(), 401);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_secs();
    let wrong_audience = jsonwebtoken::encode(&jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256), &json!({"owner":"fixture-owner","sub":id,"aud":"wrong","exp":now+60}), &jsonwebtoken::EncodingKey::from_secret(b"fixture secret")).expect("ticket");
    let wrong_subject = jsonwebtoken::encode(&jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256), &json!({"owner":"fixture-owner","sub":"wrong","aud":"asset-preview","exp":now+60}), &jsonwebtoken::EncodingKey::from_secret(b"fixture secret")).expect("ticket");
    let expired = jsonwebtoken::encode(&jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256), &json!({"owner":"fixture-owner","sub":id,"aud":"asset-preview","exp":now-1}), &jsonwebtoken::EncodingKey::from_secret(b"fixture secret")).expect("ticket");
    for token in [wrong_audience, wrong_subject, expired, "eyJhbGciOiJub25lIn0.e30.".into(), "eyJhbGciOiJSUzI1NiJ9.e30.eA".into(), "bad.token.x".into()] {
        let response = client.get(api_admin::app_url(app.addr, &format!("/content/{id}?ticket={token}"))).send().await.expect("ticket response");
        assert_eq!(response.status().as_u16(), 401);
    }
    assert_eq!(api_admin::get_as(&client, &api_admin::app_url(app.addr, "/fixture-owner/missing/access"), Some("fixture-owner")).await.0, 404);
    let no_secret = api_admin::serve_app(routes(db.clone(), None)).await;
    assert_eq!(api_admin::get_as(&client, &api_admin::app_url(no_secret.addr, &access), Some("fixture-owner")).await.0, 503);
    let mut oversized = b"--fixture-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\n\r\n".to_vec();
    oversized.resize(oversized.len() + 50_000_001, b'x');
    oversized.extend_from_slice(b"\r\n--fixture-boundary--\r\n");
    let too_large = client.post(api_admin::app_url(app.addr, "/fixture-owner"))
        .header(api_admin::FIXTURE_USER_HEADER, "fixture-owner")
        .header("content-type", "multipart/form-data; boundary=fixture-boundary")
        .body(oversized).send().await.expect("oversize response");
    assert_eq!(too_large.status().as_u16(), 413);
    db.collection::<Document>("asset_libraries").update_one(doc! {"_id":"fixture-owner"}, doc! {"$set":{"usedBytes":100_000_000_i64}}).await.expect("quota fixture");
    let over_quota = client.post(api_admin::app_url(app.addr, "/fixture-owner"))
        .header(api_admin::FIXTURE_USER_HEADER, "fixture-owner")
        .header("content-type", "multipart/form-data; boundary=fixture-boundary")
        .body(body.to_vec()).send().await.expect("quota response");
    assert_eq!(over_quota.status().as_u16(), 413);
    db.collection::<Document>("asset_libraries").update_one(doc! {"_id":"fixture-owner"}, doc! {"$set":{"usedBytes":999_i64}}).await.expect("restore fixture usage");
    let native = AssetLibraryRouteService::new(AssetLibrary::native(db.clone()), Some(b"fixture secret".to_vec()));
    let native_app = api_admin::serve_app(native.with_public(native.authenticated_router().layer(middleware::from_fn(api_admin::fixture_identity)))).await;
    let unsupported = client.post(api_admin::app_url(native_app.addr, "/fixture-owner"))
        .header(api_admin::FIXTURE_USER_HEADER, "fixture-owner")
        .header("content-type", "multipart/form-data; boundary=fixture-boundary")
        .body(body.to_vec()).send().await.expect("unsupported response");
    assert_eq!(unsupported.status().as_u16(), 415);
    drop(native_app);
    let deleted = client.delete(api_admin::app_url(app.addr, &format!("/fixture-owner/{id}"))).header(api_admin::FIXTURE_USER_HEADER, "fixture-owner").send().await.expect("delete");
    assert_eq!(deleted.status().as_u16(), 200);
    drop(no_secret);
    drop(app);
    fixture.cleanup().await;
}

