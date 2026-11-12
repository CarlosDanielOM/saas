//! The end of a speech session (`utils/speech.ts`): the reset gets the queued payload keys seen
//! before the boundary, the files seen before it are removed, and the announcement comes last.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod runtime_support;

use std::sync::Mutex;

use anyhow::Result;
use dima_commands::runtime::speech::{SpeechError, SpeechSession, clear_speech_files};
use runtime_support::*;

#[derive(Default)]
struct Session {
    calls: Mutex<Vec<String>>,
}

impl SpeechSession for Session {
    type Error = std::convert::Infallible;

    async fn reset(
        &self,
        channel_id: &str,
        session: &str,
        orphan_keys: &[String],
    ) -> Result<(), Self::Error> {
        let mut keys = orphan_keys.to_vec();
        keys.sort();
        self.calls
            .lock()
            .unwrap()
            .push(format!("reset {channel_id} {} {keys:?}", session.len()));
        Ok(())
    }

    async fn publish_ended(&self, channel_id: &str, session: &str) -> Result<(), Self::Error> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("ended {channel_id} {}", session.len()));
        Ok(())
    }
}

#[tokio::test]
async fn session_end_resets_removes_then_announces() -> Result<()> {
    with_env(0, |env| async move {
        let root = std::env::temp_dir().join(format!("dima-commands-speech-{}", random_suffix()));
        let channel_dir = root.join("990000001");
        std::fs::create_dir_all(&channel_dir)?;
        std::fs::write(channel_dir.join("a.mp3"), b"a")?;
        std::fs::write(channel_dir.join("b.mp3"), b"b")?;
        for id in ["1", "2"] {
            env.stores
                .dragonfly
                .query_value(redis::cmd("SET").arg(env.key(&format!("twitch:990000001:tts:queue:data:{id}"))).arg("x"))
                .await?;
        }
        let session = Session::default();
        let id = clear_speech_files(&env.stores, &root, "990000001", &session, &dima_core::SystemRandom).await?;
        assert_eq!(id.len(), 36);
        assert_eq!(
            *session.calls.lock().unwrap(),
            [
                "reset 990000001 36 [\"twitch:990000001:tts:queue:data:1\", \"twitch:990000001:tts:queue:data:2\"]".to_owned(),
                "ended 990000001 36".to_owned(),
            ]
        );
        assert!(!channel_dir.exists(), "emptied and removed");
        for bad in ["../x", "", "..", "99*"] {
            let refused = clear_speech_files(&env.stores, &root, bad, &session, &dima_core::SystemRandom).await;
            assert!(matches!(refused, Err(SpeechError::InvalidChannel)), "{bad}");
        }
        std::fs::remove_dir_all(&root)?;
        Ok(())
    })
    .await
}
