//! Session-fenced queue primitives. Keys have no TTL; processing's 150s TTL belongs to playback.
//! Cutover disposition: drain the TypeScript queue, rebuild sessions in the Rust database.
//! Reset cleanup is in batches of 128 and pop yields after eight failed minimum CAS attempts.
use dima_store::dragonfly::{Dragonfly, DragonflyError, Script};
static ENQUEUE: Script = Script::new("DIMA032_ENQUEUE", include_str!("lua/enqueue.lua"));
static POP: Script = Script::new("DIMA032_POP", include_str!("lua/pop.lua"));
static RESET: Script = Script::new("DIMA032_RESET", include_str!("lua/reset.lua"));
static CLEAN_OLD: Script = Script::new("DIMA032_CLEAN_OLD", include_str!("lua/clean_old.lua"));
pub fn key(channel: &str, suffix: &str) -> String {
    format!("twitch:{channel}:tts:{suffix}")
}
pub async fn enqueue(
    store: &Dragonfly,
    channel: &str,
    id: &str,
    score: f64,
    payload: &str,
) -> Result<(), DragonflyError> {
    let _: String = ENQUEUE
        .run(
            store,
            &[
                key(channel, "queue"),
                key(channel, &format!("queue:data:{id}")),
                key(channel, "session"),
            ],
            &[
                payload.to_owned(),
                dima_text::number_to_string(score),
                id.into(),
            ],
        )
        .await?;
    Ok(())
}
#[derive(Debug, PartialEq)]
pub struct Popped {
    pub value: String,
    pub payload: String,
    pub session: Option<String>,
}
pub async fn pop(store: &Dragonfly, channel: &str) -> Result<Option<Popped>, DragonflyError> {
    for _ in 0..8 {
        let ids: Vec<String> = store
            .query(
                redis::cmd("ZRANGE")
                    .arg(key(channel, "queue"))
                    .arg(0)
                    .arg(0),
            )
            .await?;
        let Some(id) = ids.first() else {
            return Ok(None);
        };
        let result: Vec<String> = POP
            .run(
                store,
                &[
                    key(channel, "queue"),
                    key(channel, "session"),
                    key(channel, &format!("queue:data:{id}")),
                ],
                &[id],
            )
            .await?;
        if result == ["retry"] {
            continue;
        }
        if let [value, payload, session] = result.as_slice() {
            return Ok(Some(Popped {
                value: value.clone(),
                payload: payload.clone(),
                session: (!session.is_empty()).then(|| session.clone()),
            }));
        }
        return Ok(None);
    }
    Ok(None)
}
pub async fn reset(
    store: &Dragonfly,
    channel: &str,
    session: &str,
    orphans: &[String],
) -> Result<(), DragonflyError> {
    let mut keys = [
        "session",
        "queue",
        "processing",
        "connected",
        "last_cleanup",
    ]
    .map(|s| key(channel, s))
    .to_vec();
    keys.extend_from_slice(orphans);
    let result: Vec<String> = RESET.run(store, &keys, &[session]).await?;
    let previous = result.first().cloned().unwrap_or_default();
    let mut ids = Vec::new();
    for id in result.iter().skip(1) {
        let k = key(channel, &format!("queue:data:{id}"));
        if !ids.contains(&k) {
            ids.push(k);
        }
    }
    for batch in ids.chunks(128) {
        let _: i64 = CLEAN_OLD.run(store, batch, &[&previous]).await?;
    }
    Ok(())
}
