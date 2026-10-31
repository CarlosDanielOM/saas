//! Disposable private GridFS fixture and source-oracle checks for media assets.
#![cfg(feature = "media-assets")]

#[path = "support/api_admin.rs"]
mod api_admin;

use std::{path::Path, sync::Arc};
use dima_rust::media_assets::{library::{AssetConsumer, AssetError, AssetFuture, AssetInspector, AssetLibrary, Inspection, UploadFile, MAX_ASSET_BYTES}, library_service as service};
use mongodb::{Database, bson::{Document, doc, oid::ObjectId}};
use sha2::{Digest, Sha256};
use serde_json::json;

const LOGICAL: &str = "src/server/services/media_library.service.ts";
const SHA256: &str = "00e94178e6eaed6693bb038a4dde8f562d68fb040e384504557d7c593b5ef4f1";
const PROVENANCE: &str = "live dimabot TypeScript source; no archive substituted";

fn golden(env: &str, file: &str, script: &str) -> serde_json::Value {
    let hint = format!("Set {env} to the directory containing {file}; generate it inside the capped pinned Node 24.22.1 image via validate.py with: node dimabot/tests/fixtures/{script} --write DIR");
    let directory = std::env::var_os(env).unwrap_or_else(|| panic!("{hint}"));
    let path = Path::new(&directory).join(file);
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}. {hint}", path.display()));
    assert!(!raw.trim().is_empty(), "{} is empty. {hint}", path.display());
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap_or_else(|error| panic!("{} invalid JSON: {error}. {hint}", path.display()));
    assert!(value.as_object().is_some_and(|object| !object.is_empty()), "{} empty or invalid oracle. {hint}", path.display());
    value
}

fn source_path(root: &Path, logical: &str) -> std::path::PathBuf {
    let path = root.join(logical);
    assert!(std::fs::symlink_metadata(&path).expect("live source metadata").file_type().is_file());
    path
}

struct Inspector;
impl AssetInspector for Inspector {
    fn inspect<'a>(&'a self, _path: &'a Path) -> AssetFuture<'a, Result<Inspection, AssetError>> {
        Box::pin(async { Ok(Inspection { mime:"image/png", kind:"image", width:1, height:1, duration:None }) })
    }
}
struct Consumer(bool);
impl AssetConsumer for Consumer {
    fn in_use<'a>(&'a self, _owner: &'a str, _id: &'a str) -> AssetFuture<'a, Result<bool, AssetError>> { Box::pin(async move { Ok(self.0) }) }
}
fn create_library(db: Database, busy: bool) -> AssetLibrary {
    let library = AssetLibrary::with_adapters(db, Arc::new(Inspector));
    library.register_asset_consumer("pet".into(), Arc::new(Consumer(busy))).expect("pet consumer");
    library.register_asset_consumer("overlay-studio".into(), Arc::new(Consumer(false))).expect("overlay consumer");
    library
}

fn oracle_routes(db: Database) -> axum::Router {
    let service = dima_rust::media_assets::asset_library_route::AssetLibraryRouteService::new(
        create_library(db, false), Some(b"fixture secret".to_vec()),
    );
    let authenticated = service.authenticated_router().layer(axum::middleware::from_fn(api_admin::fixture_identity));
    service.with_public(authenticated)
}

#[tokio::test]
#[ignore = "requires explicitly leased task-owned keyword-mongo fixture and owner marker"]
async fn upload_list_range_delete_and_consumer_guard() {
    let fixture = api_admin::fixtures(&format!("media{}", ObjectId::new().to_hex())).await;
    let db = fixture.database.clone();
    db.collection::<Document>("users").insert_one(doc! {"accounts": [{"type":"twitch", "id":"fixture-owner"}], "plan_tier":"free"}).await.expect("fixture user");
    let library = create_library(db.clone(), false);
    let dir = std::env::temp_dir().join(format!("media-fixture-{}", ObjectId::new().to_hex()));
    std::fs::create_dir(&dir).expect("unique fixture directory");
    let path = dir.join("asset");
    let bytes = vec![0x5a; 300_000];
    std::fs::write(&path, &bytes).expect("fixture bytes");
    let file = UploadFile { path: path.clone(), original_name:"one.png".into(), size:bytes.len() as u64 };
    let first = library.upload_asset("fixture-owner", &file).await.expect("first upload");
    let second = library.upload_asset("fixture-owner", &file).await.expect("second upload");
    assert_eq!(second.string("state"), Some("ready"));
    let first_id = first.string("id").expect("first id").to_owned();
    let second_id = second.string("id").expect("second id").to_owned();
    let id = ObjectId::parse_str(&first_id).expect("object id");
    assert!(db.collection::<Document>("private_assets.files").find_one(doc! {"_id":id}).await.expect("GridFS file").is_some());
    let mut pending = first.0.clone();
    pending.insert("id", ObjectId::new().to_hex());
    pending.insert("state", "uploading");
    db.collection::<Document>("asset_libraries").update_one(doc! {"_id":"fixture-owner"}, doc! {"$push":{"assets":pending}}).await.expect("pending fixture");
    db.collection::<Document>("asset_libraries").update_one(doc! {"_id":"fixture-owner"}, doc! {"$push":{"assets":{}}}).await.expect("partial asset fixture");
    let listing = library.list_assets("fixture-owner").await.expect("listing");
    assert_eq!(listing.used_bytes, 600_000);
    assert_eq!(listing.assets.iter().map(|a| a.string("id").expect("asset id")).collect::<Vec<_>>(), vec![second_id.as_str(), first_id.as_str()]);
    db.collection::<Document>("asset_libraries").update_one(doc! {"_id":"fixture-owner"}, doc! {"$push":{"assets":{"id":"partial-ready","state":"ready"}}}).await.expect("partial ready fixture");
    let partial = library.find_asset("fixture-owner", "partial-ready").await.expect("ready partial asset");
    assert_eq!(partial.0, doc! {"id":"partial-ready","state":"ready"});
    db.collection::<Document>("asset_libraries").update_one(doc! {"_id":"fixture-owner"}, doc! {"$pull":{"assets":{"id":"partial-ready"}}}).await.expect("remove partial fixture");
    assert_eq!(library.read_range("fixture-owner", &first_id, 261_100, 261_200).await.expect("cross chunk range"), bytes[261_100..261_200]);
    assert_eq!(library.read_range("fixture-owner", &first_id, 0, u64::MAX).await.expect_err("oversize range").status, 416);
    let blocked = create_library(db.clone(), true);
    assert_eq!(blocked.delete_asset("fixture-owner", &first_id).await.expect_err("consumer blocks").status, 409);
    assert!(db.collection::<Document>("private_assets.files").find_one(doc! {"_id":id}).await.expect("file after blocked delete").is_some());
    library.delete_asset("fixture-owner", &first_id).await.expect("delete");
    assert!(db.collection::<Document>("private_assets.files").find_one(doc! {"_id":id}).await.expect("file lookup").is_none());
    assert_eq!(db.collection::<Document>("private_assets.chunks").count_documents(doc! {"files_id":id}).await.expect("chunk count"), 0);
    assert_eq!(library.list_assets("fixture-owner").await.expect("after delete").used_bytes, 300_000);
    assert_eq!(library.find_asset("fixture-owner", &first_id).await.expect_err("missing").status, 404);
    assert_eq!(dima_rust::media_assets::library::validate_size(MAX_ASSET_BYTES + 1).expect_err("oversize").status, 413);
    db.collection::<Document>("asset_libraries").update_one(doc! {"_id":"fixture-owner"}, doc! {"$set":{"usedBytes":100_000_000_i64}}).await.expect("quota fixture");
    assert_eq!(library.upload_asset("fixture-owner", &file).await.expect_err("quota exceeded").status, 413);
    let unknown = dir.join("unknown");
    std::fs::write(&unknown, b"not media").expect("unknown fixture");
    assert_eq!(dima_rust::media_assets::library::inspect_file(&unknown).await.expect_err("unsupported").status, 415);
    std::fs::remove_dir_all(dir).expect("fixture file cleanup");
    fixture.cleanup().await;
}

#[test]
#[ignore = "explicit pinned source oracle required"]
fn actual_typescript_service_matches_identical_cases() {
    let oracle = golden("DIMA_MEDIA_ASSET_REFERENCE_DIR", "media-asset-library-reference.json", "media_asset_library_reference.cjs");
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let source = std::fs::read(source_path(root, LOGICAL)).expect("live source");
    assert_eq!(format!("{:x}", Sha256::digest(&source)), SHA256);
    let input: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("tests/fixtures/media_asset_library_cases.json")).expect("cases")).expect("cases JSON");
    assert_eq!(input["provenance"], PROVENANCE);
    assert_eq!(oracle["source"], LOGICAL);
    assert_eq!(oracle["sha256"], SHA256);
    assert_eq!(oracle["provenance"], PROVENANCE);
    for (logical, pin) in input["sources"].as_object().expect("source pins") {
        let path = source_path(root, logical);
        assert_eq!(format!("{:x}", Sha256::digest(std::fs::read(path).expect("source bytes"))), pin["sha256"].as_str().expect("source pin"));
        assert_eq!(oracle["sources"][logical]["sha256"], pin["sha256"]);
        assert_eq!(oracle["sources"][logical]["provenance"], pin["provenance"]);
    }
    let extensions = oracle["extensions"].as_array().expect("extension output");
    let extension_inputs = input["extensions"].as_array().expect("extension inputs");
    assert_eq!(extensions.len(), extension_inputs.len());
    for (source, case) in extensions.iter().zip(extension_inputs) {
        let filename = case["filename"].as_str().expect("filename");
        let mime = case["mime"].as_str().expect("mime");
        let actual = serde_json::json!({"filename":filename,"mime":mime,"result":service::get_file_extension(filename, mime)});
        assert_eq!(&actual, source, "extension {filename:?} {mime:?}");
    }
    let documents = api_admin::cases(&oracle, "documents");
    let schema = dima_rust::media_assets::library::asset_library_schema();
    let mut fields: Vec<&str> = schema.fields.iter().map(|field| field.name).collect();
    fields.sort_unstable();
    let native_schema = serde_json::json!({"collection":schema.collection,"versionKey":schema.version_key,
        "indexes":schema.indexes.iter().map(|index| &index.keys).collect::<Vec<_>>(),"fields":fields});
    assert_eq!(native_schema, oracle["schema"], "source schema");
    assert_eq!(documents.len(), input["documents"].as_array().expect("document inputs").len());
    for case in input["documents"].as_array().expect("document inputs") {
        let name = case["name"].as_str().expect("document case name");
        let source = api_admin::find_case(&oracle, "documents", name);
        let source_errors = source["errors"].as_array().expect("source errors");
        let native_input = mongodb::bson::serialize_to_document(&case["input"]).expect("document input BSON");
        let actual = schema.construct(&native_input, mongodb::bson::DateTime::from_millis(0));
        let mut native_errors = match &actual {
            Ok(_) => Vec::new(),
            Err(errors) => errors.0.iter().map(|error| serde_json::json!({"path":error.path,"name":if error.kind == "cast" { "CastError" } else { "ValidatorError" }})).collect::<Vec<_>>(),
        };
        native_errors.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
        assert_eq!(&native_errors, source_errors, "{name} validation errors");
        if let Ok(document) = actual {
            assert_eq!(serde_json::to_value(document).expect("cast output"), source["document"], "{name} document");
        }
    }
    assert_eq!(input["cases"].as_array().expect("cases").len(), oracle["results"].as_array().expect("results").len());
    for (case, actual) in input["cases"].as_array().expect("cases").iter().zip(oracle["results"].as_array().expect("results")) {
        let tier = service::normalize_plan_tier(case["tier"].as_str());
        let scope = dima_rust::schemas::media_asset::MediaAssetScope::parse(case["scope"].as_str().expect("scope")).expect("scope enum");
        let selected = service::default_scope(tier, case["scope"].as_str());
        let mut result_fields: Vec<&str> = actual.as_object().expect("source result object").keys().map(String::as_str).collect();
        result_fields.sort_unstable();
        assert_eq!(result_fields, vec!["charge", "extension", "name", "quota", "scope", "search", "tier", "type", "upload"], "source result fields: {actual}");
        assert_eq!(actual["name"], case["name"]);
        let tier_name = match tier { service::PlanTier::Free => "free", service::PlanTier::Premium => "premium", service::PlanTier::Pro => "pro" };
        assert_eq!(actual["tier"].as_str(), Some(tier_name));
        let expected_type = service::infer_media_type(case["mime"].as_str().expect("mime")).map(|value| value.as_str());
        assert_eq!(actual["type"].as_str(), expected_type);
        assert_eq!(actual["quota"].as_u64(), Some(service::storage_quota_bytes(tier)));
        assert_eq!(actual["upload"].as_u64(), Some(service::upload_limit_bytes(tier)));
        assert_eq!(actual["charge"].as_f64(), Some(service::quota_charge_bytes(scope, case["bytes"].as_f64().expect("bytes"))));
        assert_eq!(actual["scope"].as_str(), Some(selected.as_str()));
        assert_eq!(actual["extension"].as_str(), Some(service::get_file_extension(case["filename"].as_str().expect("name"), case["mime"].as_str().expect("mime")).as_str()));
        assert_eq!(actual["search"].as_str(), Some(service::build_media_asset_search_pattern(case["search"].as_str().expect("search")).as_str()));
    }
}
#[tokio::test]
#[ignore = "requires leased task-owned Mongo and coordinator-written TypeScript HTTP oracle"]
async fn source_http_cases_match_rust_loopback() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use mongodb::bson::{Binary, Bson, DateTime, spec::BinarySubtype};
    let oracle = golden("DIMA_MEDIA_ASSET_REFERENCE_DIR", "media-asset-library-reference.json", "media_asset_library_reference.cjs");
    let fixture = api_admin::fixtures(&format!("mediaoracle{}", ObjectId::new().to_hex())).await;
    let db = fixture.database.clone();
    db.collection::<Document>("users").insert_one(doc! {"accounts":[{"type":"twitch","id":"fixture-owner"}],"plan_tier":"free"}).await.expect("fixture user");
    let inputs: serde_json::Value = serde_json::from_slice(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/media_asset_library_cases.json")).expect("case file")).expect("JSON");
    let ready = api_admin::find_case(&inputs, "documents", "ready");
    let asset = mongodb::bson::serialize_to_document(&ready["input"]["assets"][0]).expect("source asset BSON");
    let id = ObjectId::parse_str("507f1f77bcf86cd799439011").expect("fixed id");
    db.collection::<Document>("asset_libraries").insert_one(doc! {"_id":"fixture-owner","usedBytes":19_i64,"assets":[asset]}).await.expect("source library fixture");
    db.collection::<Document>("private_assets.files").insert_one(doc! {"_id":id,"length":19_i64,"chunkSize":8_i32,"uploadDate":DateTime::now(),"filename":"fixture.png"}).await.expect("GridFS file fixture");
    for (index, part) in b"fixture-image-bytes".chunks(8).enumerate() {
        db.collection::<Document>("private_assets.chunks").insert_one(doc! {"files_id":id,"n":index as i32,"data":Bson::Binary(Binary {subtype:BinarySubtype::Generic, bytes:part.to_vec()})}).await.expect("GridFS chunk fixture");
    }
    let app = api_admin::serve_app(oracle_routes(db.clone())).await;
    let client = reqwest::Client::new();
    let (_, issued) = api_admin::get_as(&client, &api_admin::app_url(app.addr, "/fixture-owner/507f1f77bcf86cd799439011/access"), Some("fixture-owner")).await;
    let issued_path = issued["data"]["path"].as_str().expect("issued ticket");
    let ticket = issued_path.split_once("?ticket=").expect("ticket parameter").1;
    let names = api_admin::case_names(&inputs, "http");
    assert_eq!(names, api_admin::case_names(&oracle, "http"));
    let headers = ["cache-control","referrer-policy","content-type","content-range","content-length","x-content-type-options","content-security-policy","accept-ranges"];
    let mut uploaded_id: Option<String> = None;
    let mut gridfs_before = serde_json::Value::Null;
    for case in api_admin::cases(&inputs, "http") {
        let name = case["name"].as_str().expect("case name");
        let expected = api_admin::find_case(&oracle, "http", name);
        let mut path = case["path"].as_str().expect("path").to_owned();
        if case["ticket"] == true { path.push_str(&format!("?ticket={ticket}")); }
        let url = api_admin::app_url(app.addr, &path);
        let mut request = match case["method"].as_str() {
            Some("POST") => client.post(url),
            Some("DELETE") => client.delete(url),
            _ => client.get(url),
        };
        if let Some(user) = case["user"].as_str() { request = request.header(api_admin::FIXTURE_USER_HEADER, user); }
        if let Some(range) = case["range"].as_str() { request = request.header("range", range); }
        if case["multipart"] == true {
            let mut body = b"--fixture-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"fixture.png\"\r\nContent-Type: image/png\r\n\r\n".to_vec();
            body.extend(STANDARD.decode(inputs["uploadBytesBase64"].as_str().expect("upload bytes")).expect("base64"));
            body.extend_from_slice(b"\r\n--fixture-boundary--\r\n");
            request = request.header("content-type", "multipart/form-data; boundary=fixture-boundary").body(body);
        }
        let response = request.send().await.expect("loopback response");
        assert_eq!(response.status().as_u16(), expected["status"].as_u64().expect("status") as u16, "{name}");
        let mut captured = serde_json::Map::new();
        for header in headers {
            if header == "content-length" && case["ticket"] != true { continue; }
            if let Some(value) = response.headers().get(header) { captured.insert(header.to_owned(), serde_json::Value::String(value.to_str().expect("header").to_owned())); }
        }
        assert_eq!(serde_json::Value::Object(captured), expected["headers"], "{name} headers");
        let content_type = response.headers().get("content-type").and_then(|value| value.to_str().ok()).unwrap_or("").to_owned();
        let text = response.text().await.expect("response body");
        let mut body = if content_type.starts_with("application/json") { serde_json::from_str::<serde_json::Value>(&text).expect("response JSON") } else { serde_json::Value::String(text) };
        if name == "access" {
            let path = body["data"]["path"].as_str().expect("access path").split_once("?ticket=").expect("ticket").0;
            body["data"]["path"] = serde_json::Value::String(format!("{path}?ticket=<issued>"));
        }
        if name == "upload" {
            let asset_id = body["data"]["id"].as_str().expect("uploaded id").to_owned();
            let oid = ObjectId::parse_str(&asset_id).expect("uploaded object id");
            let file = db.collection::<Document>("private_assets.files").find_one(doc! {"_id":oid}).await.expect("file query").expect("uploaded file");
            let mut file_fields: Vec<_> = file.keys().cloned().collect();
            file_fields.sort();
            let length = file.get_i64("length").or_else(|_| file.get_i32("length").map(i64::from)).expect("length");
            let chunk_size = file.get_i64("chunkSize").or_else(|_| file.get_i32("chunkSize").map(i64::from)).expect("chunk size");
            let count = db.collection::<Document>("private_assets.chunks").count_documents(doc! {"files_id":oid}).await.expect("chunk count");
            let library = AssetLibrary::native(db.clone());
            let range = library.read_range("fixture-owner", &asset_id, 1, 9).await.expect("source comparison range");
            let range_hex: String = range.iter().map(|byte| format!("{byte:02x}")).collect();
            let listing = library.list_assets("fixture-owner").await.expect("source comparison list");
            gridfs_before = json!({"fileFields":file_fields,"length":length,"chunkSize":chunk_size,"metadata":serde_json::to_value(file.get_document("metadata").expect("metadata")).expect("metadata JSON"),"chunks":count,"rangeHex":range_hex,"usedBeforeDelete":listing.used_bytes,"countBeforeDelete":listing.assets.len()});
            uploaded_id = Some(asset_id);
            body["data"]["id"] = serde_json::Value::String("<generated>".to_owned());
            body["data"]["createdAt"] = serde_json::Value::String("<generated>".to_owned());
        }
        assert_eq!(body, expected["body"], "{name} body");
    }
    let library = AssetLibrary::native(db.clone());
    let listing = library.list_assets("fixture-owner").await.expect("after delete");
    let after = json!({"fileCount":db.collection::<Document>("private_assets.files").count_documents(doc! {"_id":id}).await.expect("files"),
        "chunkCount":db.collection::<Document>("private_assets.chunks").count_documents(doc! {"files_id":id}).await.expect("chunks"),
        "usedBytes":listing.used_bytes,"assetCount":listing.assets.len(),
        "pulled":!listing.assets.iter().any(|asset| asset.string("id") == Some("507f1f77bcf86cd799439011"))});
    gridfs_before["afterDelete"] = after;
    assert_eq!(gridfs_before, oracle["gridfs"], "live GridFS source comparison");
    library.delete_asset("fixture-owner", uploaded_id.as_deref().expect("uploaded id")).await.expect("delete uploaded fixture");
    drop(app);
    fixture.cleanup().await;
}
