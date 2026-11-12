use anyhow::{Context, Result};
use bson::Document;
use dima_core::{ManualClock, Random, RandomError};
use dima_model::StrEnum;
use dima_platform::media_library::*;
use futures_util::{FutureExt, future::BoxFuture};
use serde_json::{Value, json};
use std::{panic::AssertUnwindSafe, time::Duration};
fn recording() -> Result<Value> {
    Ok(serde_json::from_slice(
        &dima_text::sanitize_lone_surrogates(include_bytes!("media-library-reference.json")),
    )?)
}
#[derive(Debug)]
struct Bytes;
impl Random for Bytes {
    fn fill(&self, out: &mut [u8]) -> Result<(), RandomError> {
        out.fill(0xab);
        Ok(())
    }
}
#[test]
fn pure_recording() -> Result<()> {
    assert_eq!(
        recording()?["sha256"],
        dima_core::crypto::digest::sha256(include_str!(
            "../../../../dimabot/src/server/services/media_library.service.ts"
        ))
        .hex()
    );
    for row in recording()?["rows"].as_array().context("rows")? {
        let a = &row["args"];
        let s = |i: usize| a[i].as_str().unwrap_or("");
        let scope = || AssetScope::parse(s(0)).unwrap();
        let tier = || normalize_plan_tier(a[0].as_str());
        let actual = match row["fn"].as_str().context("fn")? {
            "normalizePlanTier" => json!(tier().as_str()),
            "isValidMediaDisplayName" => json!(is_valid_media_display_name(s(0))),
            "buildMediaAssetSearchPattern" => {
                // User-text limit: the charter counts scalars, so this split emoji is kept whole.
                // Assert the intentional extension of the recorded pattern, not a skipped case.
                if dima_text::utf16_len(dima_text::truncate_utf16_budget(s(0), 80)) == 79
                    && s(0).contains('😀')
                {
                    let expected = row["result"]
                        .as_str()
                        .context("search pattern")?
                        .trim_end_matches('\u{fffd}');
                    assert_eq!(
                        build_media_asset_search_pattern(s(0)),
                        format!("{expected}😀")
                    );
                    continue;
                }
                json!(build_media_asset_search_pattern(s(0)))
            }
            "getPlanUploadLimitBytes" => json!(get_plan_upload_limit_bytes(tier())),
            "getPlanStorageQuotaBytes" => json!(get_plan_storage_quota_bytes(tier())),
            "getDefaultMediaScope" => {
                json!(get_default_media_scope(tier(), a[1].as_str()).as_str())
            }
            "getInitialMarketplaceStatus" => {
                json!(get_initial_marketplace_status(scope()).as_str())
            }
            "getMediaQuotaChargeBytes" => dima_text::js_number_value(get_media_quota_charge_bytes(
                scope(),
                a[1].as_f64().unwrap(),
            )),
            "inferMediaTypeFromMimeType" => {
                json!(infer_media_type_from_mime_type(s(0)).map(|m| m.as_str()))
            }
            "getFileExtension" => json!(get_file_extension(s(0), s(1))),
            "buildStoredMediaFileName" => match build_stored_media_file_name(
                s(0),
                s(1),
                &Bytes,
                &ManualClock::new(1794355200000),
            ) {
                Ok(file) => json!(file),
                Err(_) => {
                    assert!(!is_valid_media_display_name(s(0)) || s(0).len() > 1024);
                    continue;
                }
            },
            "buildMediaS3Key" => {
                match build_media_s3_key(scope(), MediaType::parse(s(1)).unwrap(), s(2), s(3)) {
                    Ok(key) => json!(key),
                    Err(_) => {
                        assert!(s(3).contains('/') || s(3).contains('\\') || s(3) == "..");
                        continue;
                    }
                }
            }
            "buildMediaPlaybackUrl" => json!(build_media_playback_url(
                "https://api.domdimabot.com",
                s(0).parse()?
            )),
            other => anyhow::bail!("unexpected {other}"),
        };
        assert_eq!(actual, row["result"], "{} {:?}", row["fn"], a);
    }
    Ok(())
}
#[test]
fn search_literals_and_prefix_safety() -> Result<()> {
    for metachar in [
        '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\',
    ] {
        let input = format!("xyz{metachar}");
        let re = regex::Regex::new(&build_media_asset_search_pattern(&input))?;
        assert!(re.is_match(&input));
        assert!(!re.is_match("xyz123"));
    }
    let re = regex::RegexBuilder::new(&build_media_asset_search_pattern("mejor país de chile"))
        .case_insensitive(true)
        .build()?;
    assert!(re.is_match("Mejor_Pais_de_Chile"));
    assert!(re.is_match("Mejor País de Chile"));
    assert!(!re.is_match("Mejor_Pais_del_Chile"));
    // Includes nested quantifiers, huge input and separator runs. All compile to a bounded,
    // linear-time Rust regex; Mongo expressions have no nested/overlapping quantifiers either.
    for s in ["(a+)+$".into(), "a ".repeat(10000), "[\\s_]+.*".into()] {
        let p = build_media_asset_search_pattern(&s);
        assert!(p.len() < 1500);
        regex::Regex::new(&p)?;
    }
    for file in [
        "../x",
        "x/../../y",
        "..",
        ".",
        "/x",
        "x\\y",
        "x%2fy",
        "x?y",
        "x#y",
        "x\0y",
    ] {
        for scope in [AssetScope::Public, AssetScope::Private] {
            assert!(build_media_s3_key(scope, MediaType::Video, "123", file).is_err());
        }
    }
    Ok(())
}
struct HungAccess;
impl GlobalChannelOwnerAccess for HungAccess {
    fn has_access<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<bool, Error>> {
        Box::pin(std::future::pending())
    }
}
struct Access;
impl GlobalChannelOwnerAccess for Access {
    fn has_access<'a>(
        &'a self,
        requester: &'a str,
        _: &'a str,
    ) -> BoxFuture<'a, Result<bool, Error>> {
        Box::pin(async move { Ok(requester == "global") })
    }
}
#[tokio::test]
async fn recorded_mongo_quota_and_permissions() -> Result<()> {
    use dima_store::mongo::{MongoConfig, MongoStore, WriteContext};
    let uri = match std::env::var("DIMA_TEST_MONGO_URI") {
        Ok(u) => u,
        Err(e) => {
            if std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1") {
                return Err(e.into());
            }
            return Ok(());
        }
    };
    let mut cfg = MongoConfig::new(uri);
    cfg.database = Some(format!(
        "dima_test_platform_{}",
        dima_core::SystemRandom.hex_token(12)?
    ));
    let store = MongoStore::connect(&cfg, None).await?;
    let result = AssertUnwindSafe(async {
        let r = recording()?;
        let r = &r["storeRecording"];
        for seed in r["seeds"].as_array().context("seeds")? {
            let d: Document = bson::deserialize_from_bson(bson::Bson::try_from(seed.clone())?)?;
            let p = dima_model::user_media_library_items::INFO
                .prepare_create(&d, &mut WriteContext::new(1794355200000))?;
            store
                .writes(dima_model::user_media_library_items::COLLECTION)
                .insert_one(&p)
                .await?;
        }
        for seed in r["adminSeeds"].as_array().context("admins")? {
            let p = dima_model::admins::NewAdmin {
                channel_id: Some(seed["channelID"].as_str().unwrap().into()),
                admin_id: Some(seed["adminID"].as_str().unwrap().into()),
                actived: seed["actived"].as_bool(),
                permissions: Some(serde_json::from_value(seed["permissions"].clone())?),
                ..Default::default()
            }
            .prepare(&mut WriteContext::new(1794355200000))?;
            store
                .writes(dima_model::admins::COLLECTION)
                .insert_one(&p)
                .await?;
        }
        for q in r["quotas"].as_array().context("quotas")? {
            assert_eq!(
                get_channel_quota_usage_bytes(
                    &store,
                    q["channel"].as_str().unwrap(),
                    Duration::from_secs(5)
                )
                .await?,
                q["result"].as_f64().unwrap()
            );
        }
        for p in r["permissions"].as_array().context("permissions")? {
            let required: Vec<String> = serde_json::from_value(p["required"].clone())?;
            assert_eq!(
                has_trigger_permission(
                    &store,
                    &Access,
                    p["requester"].as_str().unwrap(),
                    "123",
                    &required,
                    Duration::from_secs(5)
                )
                .await?,
                p["result"].as_bool().unwrap()
            );
        }
        assert!(matches!(
            has_trigger_permission(
                &store,
                &HungAccess,
                "viewer",
                "123",
                &[],
                Duration::from_millis(1)
            )
            .await,
            Err(Error::Timeout)
        ));
        assert!(
            get_channel_quota_usage_bytes(&store, "123", Duration::ZERO)
                .await
                .is_err()
        );
        for input in [".*", "test.*", "test|.*", "(a+)+$", "[\\s_]+.*"] {
            let collection = store.documents(dima_model::user_media_library_items::COLLECTION);
            let query = collection
                .count_documents(
                    bson::doc! {"channelName":{"$regex":build_media_asset_search_pattern(input)}},
                )
                .max_time(Duration::from_millis(200));
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(5), async { query.await }).await??,
                0
            );
        }
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
    store.database().drop().await?;
    match result {
        Ok(r) => r,
        Err(p) => std::panic::resume_unwind(p),
    }
}
