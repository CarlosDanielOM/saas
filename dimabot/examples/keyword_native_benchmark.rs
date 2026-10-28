//! Paired with the compiled-JS keyword_native_benchmark.mjs; explicit disposable
//! fixtures only. Never connects through production environment/global clients.

#[cfg(feature = "keyword-store")]
mod benchmark {
    use dima_rust::utils::keywords::{
        self, KeywordEntry, KeywordIndex, KeywordMatchMode, KeywordStorage,
        native::{MongoRedisKeywordStorage, NativeKeywordCache},
    };
    use futures_util::FutureExt;
    use mongodb::bson::{DateTime, Document, doc, oid::ObjectId};
    use serde_json::{Value, json};
    use std::{hint::black_box, panic::AssertUnwindSafe, time::Instant};

    struct State {
        service: NativeKeywordCache,
        channel: String,
        id: String,
        pure: KeywordIndex,
    }
    fn match_count(state: &State) -> u64 {
        black_box(keywords::match_keywords(
            &state.pure,
            black_box("WORD99 word12! unrelated word99"),
        ))
        .len() as u64
    }
    async fn operation(state: &State, operation: &str) -> u64 {
        let State {
            service,
            channel,
            id,
            pure,
        } = state;
        match operation {
            "index_match" => black_box(keywords::match_keywords(
                pure,
                black_box("WORD99 word12! unrelated word99"),
            ))
            .len() as u64,
            "local_index_hit" => service.index.get(channel).await.unwrap().word_count() as u64,
            "shared_index_hit" => {
                service.index.invalidate(channel);
                service.index.get(channel).await.unwrap().word_count() as u64
            }
            "index_mongo_miss" => {
                service
                    .storage
                    .delete(&keywords::keyword_index_key(channel))
                    .await
                    .unwrap();
                service.index.invalidate(channel);
                service.index.get(channel).await.unwrap().word_count() as u64
            }
            "body_cache_hit" => service.body(channel, id).await.unwrap().unwrap()["count"]
                .as_f64()
                .unwrap() as u64,
            "body_mongo_miss" => {
                service
                    .storage
                    .delete(&keywords::keyword_body_key(channel, id))
                    .await
                    .unwrap();
                service.body(channel, id).await.unwrap().unwrap()["count"]
                    .as_f64()
                    .unwrap() as u64
            }
            "refresh" => {
                service.refresh(channel, Some(id)).await.unwrap();
                service.index.get(channel).await.unwrap().word_count() as u64
            }
            "count_write" => {
                service.save_count(channel, id, 7.0).await.unwrap();
                7
            }
            _ => panic!("unknown benchmark operation"),
        }
    }
    pub async fn run() {
        let mongo_uri =
            std::env::var("KEYWORD_FIXTURE_MONGO_URI").expect("explicit fixture address");
        let redis_url =
            std::env::var("KEYWORD_FIXTURE_REDIS_URL").expect("explicit fixture address");
        assert_eq!(mongo_uri, "mongodb://keyword-mongo:27017");
        assert_eq!(redis_url, "redis://keyword-redis:6379/");
        let namespace =
            std::env::var("KEYWORD_FIXTURE_NAMESPACE").expect("unique fixture namespace");
        assert!(
            namespace.starts_with("keyword-fixture-")
                && namespace.ends_with(':')
                && (24..=60).contains(&namespace.len())
        );
        assert!(
            namespace
                .trim_end_matches(':')
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        );
        let database_name = namespace.trim_end_matches(':').replace('-', "_");
        let client = mongodb::Client::with_uri_str(&mongo_uri).await.unwrap();
        let database = client.database(&database_name);
        assert!(
            database.list_collection_names().await.unwrap().is_empty(),
            "database must be unused"
        );
        let redis_client = redis::Client::open(redis_url).unwrap();
        let connection = redis::aio::ConnectionManager::new_with_config(
            redis_client.clone(),
            redis::aio::ConnectionManagerConfig::new().set_response_timeout(None),
        )
        .await
        .unwrap();
        let store = MongoRedisKeywordStorage::new(&database, connection.clone());
        let ids = (1..=100).map(|i| format!("{i:024x}")).collect::<Vec<_>>();
        let state = State {
            service: NativeKeywordCache::new(store, redis_client),
            channel: namespace.clone(),
            id: ids[0].clone(),
            pure: keywords::compile_keyword_index(ids.iter().enumerate().map(|(i, id)| {
                KeywordEntry {
                    id: id.clone(),
                    text: format!("word{i}"),
                    match_mode: KeywordMatchMode::Anywhere,
                }
            })),
        };
        let cache_keys = [
            keywords::keyword_index_key(&namespace),
            keywords::keyword_revision_key(&namespace),
        ]
        .into_iter()
        .chain(
            ids.iter()
                .map(|id| keywords::keyword_body_key(&namespace, id)),
        )
        .collect::<Vec<_>>();
        let mut raw = connection;
        let existing: i64 = redis::cmd("EXISTS")
            .arg(&cache_keys)
            .query_async(&mut raw)
            .await
            .unwrap();
        assert_eq!(existing, 0);
        let setting = |name: &str, default| {
            std::env::var(name)
                .ok()
                .map_or(default, |value| value.parse::<usize>().unwrap())
        };
        let iterations = setting("KEYWORD_BENCH_ITERATIONS", 100);
        let samples = setting("KEYWORD_BENCH_SAMPLES", 7);
        assert!(iterations > 0 && samples > 0);
        let result=AssertUnwindSafe(async {
            let commands=database.collection::<Document>("commands");
            commands.insert_many(ids.iter().enumerate().map(|(i,id)|doc!{"_id":ObjectId::parse_str(id).unwrap(),"channelID":&namespace,"activation":"keyword","enabled":true,"cmd":format!("word{i}"),"keywordSettings":{"matchMode":"anywhere"},"message":format!("Hello {i}"),"count":0,"createdAt":DateTime::from_millis(0),"date":{"day":1,"month":1,"year":1970}})).await.unwrap();
            assert_eq!(operation(&state,"index_match").await,2);
            let mut results=Vec::new();
            for name in ["index_match","local_index_hit","shared_index_hit","index_mongo_miss","body_cache_hit","body_mongo_miss","refresh","count_write"] {
                commands.update_one(doc!{"_id":ObjectId::parse_str(&state.id).unwrap()},doc!{"$set":{"count":0}}).await.unwrap();
                state.service.storage.delete(&keywords::keyword_body_key(&namespace,&state.id)).await.unwrap();
                state.service.index.get(&namespace).await.unwrap();state.service.body(&namespace,&state.id).await.unwrap();
                let mut checksum=0_u64;
                for _ in 0..iterations {checksum+=if name=="index_match"{match_count(&state)}else{operation(&state,name).await};}
                let mut measurements=Vec::new();let mut elapsed=Vec::new();
                for _ in 0..samples {
                    let cpu_before=cpu_ticks();let started=Instant::now();
                    for _ in 0..iterations {checksum+=black_box(if name=="index_match"{match_count(&state)}else{operation(&state,black_box(name)).await});}
                    let nanos=started.elapsed().as_nanos() as u64;
                    measurements.push(json!({"elapsedNs":nanos,"cpuTicks":cpu_ticks().zip(cpu_before).map(|(after,before)|after-before),"rssBytes":rss_bytes()}));
                    elapsed.push(nanos);
                }
                elapsed.sort_unstable();results.push(json!({"operation":name,"iterations":iterations,"checksum":checksum,"samples":measurements,"medianElapsedNs":elapsed[elapsed.len()/2]}));
            }
            assert_eq!(commands.find_one(doc!{"_id":ObjectId::parse_str(&state.id).unwrap()}).await.unwrap().unwrap().get_i32("count").unwrap(),7);
            let fixture:Value=serde_json::from_str(include_str!("../tests/fixtures/keyword_native_cases.json")).unwrap();
            println!("{}",json!({"implementation":"rust","sources":fixture["sources"],"fixtureRows":100,"results":results}));
        }).catch_unwind().await;
        database.drop().await.expect("drop task-owned benchmark DB");
        let _: i64 = redis::cmd("DEL")
            .arg(cache_keys)
            .query_async(&mut raw)
            .await
            .unwrap();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }
    fn cpu_ticks() -> Option<u64> {
        let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
        let fields = stat
            .rsplit_once(')')?
            .1
            .split_whitespace()
            .collect::<Vec<_>>();
        Some(fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?)
    }
    fn rss_bytes() -> Option<u64> {
        std::fs::read_to_string("/proc/self/status")
            .ok()?
            .lines()
            .find_map(|line| {
                line.strip_prefix("VmRSS:")?
                    .split_whitespace()
                    .next()?
                    .parse::<u64>()
                    .ok()
                    .map(|kb| kb * 1024)
            })
    }
}

#[cfg(feature = "keyword-store")]
#[tokio::main]
async fn main() {
    benchmark::run().await;
}

#[cfg(not(feature = "keyword-store"))]
fn main() {
    eprintln!("Enable keyword-store for the native keyword benchmark");
    std::process::exit(2);
}
