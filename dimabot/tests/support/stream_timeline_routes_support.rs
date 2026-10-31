//! External oracle reader; fixture production is owned by the integration team.
#![allow(dead_code)]
use serde_json::Value;
#[path = "sha256.rs"]
mod digest;
use std::path::PathBuf;

pub fn fixture() -> Value {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).canonicalize().expect("manifest directory").parent().expect("workspace").to_path_buf();
    let directory = PathBuf::from(std::env::var_os("DIMA_STREAM_TIMELINE_ROUTES_FIXTURE_DIR").expect("fixture directory"));
    assert!(directory.is_absolute(), "fixture directory must be absolute");
    assert_eq!(directory.canonicalize().expect("fixture directory"), directory);
    assert!(!directory.starts_with(workspace), "fixture must be outside workspace");
    let expected = std::env::var("DIMA_STREAM_TIMELINE_ROUTES_FIXTURE_SHA256").expect("fixture digest");
    assert!(expected.len() == 64 && expected.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    let path = directory.join("stream-timeline-routes-reference.json");
    assert!(std::fs::symlink_metadata(&path).expect("fixture metadata").file_type().is_file());
    let bytes = std::fs::read(path).expect("fixture");
    assert_eq!(digest::sha256_hex(&bytes), expected);
    serde_json::from_slice(&bytes).expect("fixture JSON")
}
pub fn fixture_case<'a>(fixture: &'a Value, name: &str) -> &'a Value {
    fixture["cases"].as_array().expect("cases").iter().find(|case| case["name"] == name).unwrap_or_else(|| panic!("fixture case {name}")).get("expected").expect("expected")
}
pub fn fixture_case_names(fixture: &Value) -> Vec<String> { fixture["cases"].as_array().expect("cases").iter().map(|case| case["name"].as_str().expect("name").to_owned()).collect() }
pub fn assert_case(fixture: &Value, name: &str, status: u16, body: &Value) {
    let expected = fixture_case(fixture, name);
    assert_eq!(expected["status"].as_u64(), Some(u64::from(status)), "{name}: status");
    assert_eq!(&expected["body"], body, "{name}: body");
}

/// Mirrors the source oracle's in-memory timeline, owner and model seams.
/// Each case gets its own instance and therefore its own scripted responses.
pub struct TimelineCase { pub name: String }
impl dima_rust::stream_timeline_route::TimelineRouteData for TimelineCase {
    fn permissions<'a>(&'a self, _requester: &'a str, _channel: &'a str) -> dima_rust::stream_timeline_route::RouteFuture<'a, (bool, bool)> {
        Box::pin(async move { Ok((self.name != "access-denied", true)) })
    }
    fn owner<'a>(&'a self, _channel: &'a str) -> dima_rust::stream_timeline_route::RouteFuture<'a, Option<mongodb::bson::Document>> {
        Box::pin(async move { Ok(Some(mongodb::bson::doc! {"plan_tier": if self.name.ends_with("-free") { "free" } else { "pro" }, "polar_sh_customer_id": "fixture-customer"})) })
    }
    fn list<'a>(&'a self, _channel: &'a str, page: u64) -> dima_rust::stream_timeline_route::RouteFuture<'a, mongodb::bson::Document> {
        Box::pin(async move { Ok(mongodb::bson::doc! {"streams": [], "page": page as i64, "hasMore": false}) })
    }
    fn session<'a>(&'a self, _channel: &'a str, id: &'a str) -> dima_rust::stream_timeline_route::RouteFuture<'a, Option<mongodb::bson::Document>> {
        Box::pin(async move {
            let id = mongodb::bson::oid::ObjectId::parse_str(id).map_err(|error| dima_rust::stream_timeline_route::RouteError::internal().with_error(&error))?;
            Ok(Some(mongodb::bson::doc! {"_id": id, "started_at": mongodb::bson::DateTime::from_millis(1_767_225_600_000), "ended_at": mongodb::bson::DateTime::from_millis(1_767_229_200_000)}))
        })
    }
    fn timeline<'a>(&'a self, _channel: &'a str, _id: &'a str, _tier: &'a str) -> dima_rust::stream_timeline_route::RouteFuture<'a, Option<mongodb::bson::Document>> {
        Box::pin(async move { Ok(if self.name == "missing-stream" { None } else { Some(mongodb::bson::doc! {"points": []}) }) })
    }
    fn rows<'a>(&'a self, _collection: dima_rust::stream_timeline_route::TimelineRows, _filter: mongodb::bson::Document) -> dima_rust::stream_timeline_route::RouteFuture<'a, Vec<mongodb::bson::Document>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn insert_marker<'a>(&'a self, _filter: mongodb::bson::Document, update: mongodb::bson::Document) -> dima_rust::stream_timeline_route::RouteFuture<'a, ()> {
        Box::pin(async move {
            let expected = match self.name.as_str() {
                "marker-fraction-inside" => Some(1_767_229_199_000),
                "marker-fraction-end" => Some(1_767_229_200_000),
                _ => None,
            };
            if let Some(expected) = expected {
                let date = update.get_document("$setOnInsert").unwrap().get_datetime("occurredAt").unwrap();
                assert_eq!(date.timestamp_millis(), expected);
            }
            Ok(())
        })
    }
    fn delete_marker<'a>(&'a self, _filter: mongodb::bson::Document) -> dima_rust::stream_timeline_route::RouteFuture<'a, ()> { Box::pin(async { Ok(()) }) }
}
impl dima_rust::stream_summary_route::SummaryRouteData for TimelineCase {
    fn access<'a>(&'a self, _requester: &'a str, _channel: &'a str) -> dima_rust::stream_timeline_route::RouteFuture<'a, bool> { Box::pin(async { Ok(false) }) }
    fn list<'a>(&'a self, _filter: mongodb::bson::Document, _limit: i64, _skip: u64) -> dima_rust::stream_timeline_route::RouteFuture<'a, (Vec<mongodb::bson::Document>, u64)> { Box::pin(async { Ok((vec![], 0)) }) }
    fn details<'a>(&'a self, _filter: mongodb::bson::Document) -> dima_rust::stream_timeline_route::RouteFuture<'a, Option<mongodb::bson::Document>> { Box::pin(async move {
        Ok((self.name == "summary-detail-ok").then(|| mongodb::bson::doc! {"_id": "507f1f77bcf86cd799439011", "channelID": "123"}))
    }) }
}
impl dima_rust::analytics_route::AnalyticsRouteData for TimelineCase {
    fn streamer<'a>(&'a self, _channel: &'a str) -> dima_rust::stream_timeline_route::RouteFuture<'a, Option<String>> { Box::pin(async move { Ok((self.name != "follow-missing").then(|| "fixture".to_owned())) }) }
    fn access<'a>(&'a self, _requester: &'a str, _channel: &'a str) -> dima_rust::stream_timeline_route::RouteFuture<'a, (bool, String)> { Box::pin(async move { Ok((self.name != "follow-forbidden", "owner".into())) }) }
    fn rows<'a>(&'a self, _filter: mongodb::bson::Document, _order: i32, _skip: u64, _limit: u64) -> dima_rust::stream_timeline_route::RouteFuture<'a, Vec<mongodb::bson::Document>> { Box::pin(async { Ok(vec![]) }) }
    fn count<'a>(&'a self, _filter: mongodb::bson::Document) -> dima_rust::stream_timeline_route::RouteFuture<'a, u64> { Box::pin(async { Ok(0) }) }
}
