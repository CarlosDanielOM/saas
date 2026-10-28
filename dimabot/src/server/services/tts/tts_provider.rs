pub use crate::utils::tts::TtsMode;
use crate::utils::{
    js_string::JsString,
    tts::{TtsLanguage, TtsProvider},
};
use std::path::PathBuf;
use tokio::sync::watch;

#[derive(Clone, Debug)]
pub struct TtsSynthesisRequest {
    pub channel_id: String,
    pub speech_id: String,
    pub mode: TtsMode,
    pub provider: TtsProvider,
    pub model: Option<String>,
    pub text: JsString,
    pub language: TtsLanguage,
    pub voice: JsString,
    pub output_path: PathBuf,
    pub clone_name: Option<String>,
    pub private_output: bool,
    /// None means no cancellation; Some(reason) aborts the request.
    pub signal: Option<watch::Receiver<Option<String>>>,
    pub max_audio_bytes: Option<usize>,
    pub single_attempt: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TtsSynthesisResult {
    pub error: bool,
    pub message: String,
    pub output_path: Option<PathBuf>,
    pub public_path: Option<String>,
    pub mime_type: Option<&'static str>,
}
impl TtsSynthesisResult {
    pub(crate) fn failure(message: String) -> Self {
        Self {
            error: true,
            message,
            output_path: None,
            public_path: None,
            mime_type: None,
        }
    }
}
