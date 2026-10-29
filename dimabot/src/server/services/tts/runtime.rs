//! Application-owned TTS services. Construction creates no speech directories,
//! starts no subprocesses and sends no provider requests. The HTTP client may
//! load its native TLS/proxy configuration. TTS values are read at source boundaries.
use std::{
    fmt,
    path::{Path, PathBuf},
    sync::Arc,
};

use super::{
    fish_tts::{FishConfig, FishTtsService},
    fish_voice_catalog::{
        FishCatalog, FishCatalogConfig, FishCatalogError, FishSearchResult, FishVoice,
        FishVoiceSearch,
    },
    http_support,
    kokoro_tts::{KokoroConfig, KokoroTtsService},
    piper_tts::{PiperConfig, PiperTtsService},
    speech_paths::{SpeechPaths, node_join},
    tts_provider::{TtsSynthesisRequest, TtsSynthesisResult},
};
use crate::utils::{js_compat, tts::TtsProvider};

pub use super::tts_provider::Environment;

/// Concrete Linux process adapter. Invalid UTF-8 is replaced with U+FFFD rather
/// than treating a present environment variable as absent.
pub fn process_environment() -> Environment {
    Arc::new(|name| std::env::var_os(name).map(|value| value.to_string_lossy().into_owned()))
}

/// Derive the source's path.resolve(module directory, '../../routes/public/speech').
/// The module directory must be an absolute, UTF-8 Linux path supplied by the
/// application layout, not the build-time manifest directory.
pub fn speech_root_from_module_dir(module_dir: &Path) -> Option<PathBuf> {
    if !module_dir.is_absolute() || module_dir.to_str().is_none() {
        return None;
    }
    Some(node_join(module_dir, "../../routes/public/speech"))
}

/// Templates allow callers to override endpoints and deadlines for isolated tests.
/// Environment-owned fields and paths are refreshed for every operation.
#[derive(Clone)]
pub struct TtsRuntimeConfig {
    pub speech_root: PathBuf,
    pub piper: PiperConfig,
    pub fish: FishConfig,
    pub kokoro: KokoroConfig,
    pub catalog: FishCatalogConfig,
}
impl TtsRuntimeConfig {
    pub fn new(speech_root: PathBuf) -> Self {
        let paths = SpeechPaths::new(speech_root.clone(), None, false);
        Self {
            speech_root,
            piper: PiperConfig::new(paths.clone()),
            fish: FishConfig::new(paths.clone(), None, None),
            kokoro: KokoroConfig::new(paths, None),
            catalog: FishCatalogConfig::new(None),
        }
    }
}
impl fmt::Debug for TtsRuntimeConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TtsRuntimeConfig")
            .field("speech_root", &"[REDACTED]")
            .field("piper", &self.piper)
            .field("fish", &self.fish)
            .field("kokoro", &self.kokoro)
            .field("catalog", &self.catalog)
            .finish()
    }
}

#[derive(Clone)]
pub struct TtsRuntime {
    env: Environment,
    client: reqwest::Client,
    config: TtsRuntimeConfig,
    catalog: FishCatalog,
}
impl fmt::Debug for TtsRuntime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TtsRuntime")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}
impl TtsRuntime {
    pub fn new(config: TtsRuntimeConfig) -> Self {
        Self::with_client(config, process_environment(), http_support::new_client())
    }
    pub fn with_client(
        config: TtsRuntimeConfig,
        env: Environment,
        client: reqwest::Client,
    ) -> Self {
        let catalog = FishCatalog::with_client(config.catalog.clone(), client.clone())
            .with_environment(Arc::clone(&env));
        Self {
            env,
            client,
            config,
            catalog,
        }
    }
    fn value(&self, name: &str) -> Option<String> {
        (self.env)(name)
    }
    fn key(&self, name: &str) -> Option<String> {
        self.value(name).map(|s| js_compat::trim(&s).to_owned())
    }
    pub fn paths(&self) -> SpeechPaths {
        let url = self.value("PUBLIC_API_URL");
        // getPublicApiUrl returns before reading NODE_ENV when configured.
        let production = url
            .as_deref()
            .is_none_or(|url| js_compat::trim(url).is_empty())
            && self.value("NODE_ENV").as_deref() == Some("production");
        SpeechPaths::new(self.config.speech_root.clone(), url.as_deref(), production)
    }

    pub fn piper_config(&self) -> PiperConfig {
        let mut config = self.config.piper.clone();
        config.paths = self.paths();
        config.python_bin = self
            .value("PIPER_PYTHON_BIN")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "python3".into())
            .into();
        config.data_dir = self
            .value("PIPER_DATA_DIR")
            .map(|s| js_compat::trim(&s).to_owned())
            .filter(|s| !s.is_empty());
        config.http_url = self
            .value("PIPER_HTTP_URL")
            .filter(|s| !js_compat::trim(s).is_empty())
            .map(|s| s.trim_end_matches('/').to_owned());
        config
    }

    fn output_paths(&self) -> SpeechPaths {
        // Only the filesystem root is needed until synthesis finishes. Public
        // URL configuration is read below after audio has been written.
        SpeechPaths::new(self.config.speech_root.clone(), None, false)
    }

    /// An absent or unresolved provider selects Piper, as in the queue registry.
    pub async fn synthesize(
        &self,
        provider: Option<TtsProvider>,
        request: &TtsSynthesisRequest,
    ) -> TtsSynthesisResult {
        let mut result = match provider.unwrap_or(TtsProvider::Piper) {
            TtsProvider::Piper => {
                let mut config = self.config.piper.clone();
                config.paths = self.output_paths();
                PiperTtsService::with_client(config, self.client.clone())
                    .with_environment(Arc::clone(&self.env))
                    .synthesize(request)
                    .await
            }
            TtsProvider::Fish => {
                let mut config = self.config.fish.clone();
                config.paths = self.output_paths();
                FishTtsService::with_client(config, self.client.clone())
                    .with_environment(Arc::clone(&self.env))
                    .synthesize(request)
                    .await
            }
            TtsProvider::Kokoro => {
                let mut config = self.config.kokoro.clone();
                config.paths = self.output_paths();
                config.openrouter_api_key = self.key("OPENROUTER_API_KEY");
                KokoroTtsService::with_client(config, self.client.clone())
                    .synthesize(request)
                    .await
            }
        };
        if !result.error && !request.private_output {
            result.public_path = Some(
                self.paths()
                    .public_path(&request.channel_id, &request.speech_id),
            );
        }
        result
    }

    pub async fn get_fish_voice(&self, id: &str) -> Result<FishVoice, FishCatalogError> {
        self.catalog.get_fish_voice(id).await
    }

    pub async fn search_fish_voices(
        &self,
        search: &FishVoiceSearch,
    ) -> Result<FishSearchResult, FishCatalogError> {
        self.catalog.search_fish_voices(search).await
    }
}
