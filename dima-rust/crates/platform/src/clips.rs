//! Twitch clip files for the clip overlay, ported from `utils/video.ts` (`downloadClip`,
//! `deleteOldClip`, `checkIfClipExists`).
//!
//! The reference runs `yt-dlp --no-progress -S "res:480" -o "<dir>/<channel>-clip.mp4" "<url>"`
//! through a shell (`exec`) and builds the paths by concatenation. This port uses no shell:
//!
//! - Inputs are checked before anything is built. A channel id is 1 to 20 ASCII digits (Twitch
//!   user ids; the overlay namespace `/clip/\w+` only lets in an id with a Twitch account,
//!   `server/websocket.ts:65`). A clip URL is what Helix `GET /clips` returns in `url`
//!   (`functions/clips/show_clip.clip.ts:157`, carried through the Dragonfly clip queue by
//!   `queue.clip.ts:75` and `clip_queue.handler.ts:116`): `https://clips.twitch.tv/<slug>`, or
//!   Twitch's newer channel form `https://www.twitch.tv/<login>/clip/<slug>`. [`ClipUrl`] parses
//!   it, refuses everything else (other schemes and hosts, credentials, ports, queries,
//!   fragments, percent escapes, whitespace and controls, non-ASCII, over 2048 bytes; a slug is
//!   1 to 100 of `[A-Za-z0-9_-]` starting with a letter or digit, a login 1 to 25 of
//!   `[A-Za-z0-9_]`) and re-serialises it from the parsed parts.
//! - The downloader is a [`Program`] at a configured absolute path. Argument vector:
//!   `--ignore-config --no-cache-dir --no-progress -S res:480 --max-filesize <max_bytes>
//!   -o clip.mp4 -- <url>`; the URL comes after `--`, so it is never read as an option (it also
//!   always starts with `https://`). `--ignore-config` and `--no-cache-dir` keep yt-dlp from
//!   reading configuration or writing a cache outside the run directory. Environment: `HOME`
//!   (the run directory) and `LANG=C.UTF-8`; no `PATH`, so yt-dlp starts no helper programs
//!   (Twitch clips are single progressive MP4 files; the reference's comment says so too).
//!   Working directory: a new private directory `clip-<24 hex>` (mode 0700) inside the
//!   configured temporary directory, removed on every path, cancellation included.
//! - Limits: the reference's 60 s time limit (the whole group is killed, where the reference sent
//!   SIGTERM to the shell only), a cap on captured output (the reference had none), and a
//!   maximum file size (the reference had none): yt-dlp's own `--max-filesize`, plus a watchdog
//!   that polls the run directory every 250 ms and kills the download when the directory holds
//!   more than the limit. The finished file must be a non-empty regular file within the limit.
//! - Paths: the served file is always `<download dir>/<channel id>-clip.mp4` (the name
//!   `server/routes/file.route.ts:23` serves), with the directory canonicalised at startup and a
//!   name built only from a checked id, so no separator or `..` can reach it. The finished file
//!   is moved into place with `rename` (the temporary and download directories must be on one
//!   file system, checked at startup), which replaces the name and never follows a symlink
//!   there. Delete unlinks the name (a symlink is removed, not followed); exists reports only a
//!   regular file (`lstat`; the reference's `existsSync` followed symlinks).
//! - Two downloads for one channel at once: in the reference both wrote to the same path and
//!   `.part` file and could interleave. Here each writes in its own run directory and the
//!   rename is atomic: the served file is always one complete download, the last to finish.
//!
//! Reference gaps (`video.ts`): lines 18, 29 to 30, 118 and 138 interpolate the channel id and
//! URL unchecked into a path and a shell line. Today nothing outside reaches them: the URL is
//! Helix's `url` for a clip of a channel the bot picked (a streamer's login from chat only
//! selects whose clips are fetched), and the channel id is a stored account's numeric id. They
//! are missing defences, not open holes; this port closes them anyway.
//!
//! Callers supply typed configuration (no environment is read here) and the randomness for run
//! directory names. Errors carry the program's captured output; the caller logs it, as the
//! reference did. Directories are created and checked once at startup in [`Clips::new`].
use crate::process::{self, Invocation, Program, RunDir};
use dima_core::Random;
use std::ffi::OsString;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use url::{Host, Url};

const FILE_SUFFIX: &str = "-clip.mp4";
const OUTPUT_NAME: &str = "clip.mp4";
const MAX_URL_BYTES: usize = 2048;
const MAX_SLUG: usize = 100;
const MAX_LOGIN: usize = 25;
const MAX_CHANNEL_ID: usize = 20;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid clip configuration: {0}")]
    Config(&'static str),
    #[error("not a Twitch clip URL")]
    InvalidUrl,
    #[error("not a Twitch channel id")]
    InvalidChannel,
    #[error("clip download exceeded the size limit")]
    TooLarge,
    #[error("download completed but no clip file was produced")]
    Missing,
    #[error(transparent)]
    Process(#[from] process::Error),
    #[error("clip file I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Random(#[from] dima_core::RandomError),
}

/// Startup configuration (from the process's typed settings, never read here).
#[derive(Clone, Debug)]
pub struct Config {
    /// Absolute path of `yt-dlp`.
    pub downloader: PathBuf,
    /// The directory the clip route serves (reference: `<cwd>/dist/server/routes/public/downloads`).
    /// Created when missing, as the reference's `mkdirSync(recursive)` did.
    pub download_dir: PathBuf,
    /// Where each download gets its private run directory; same file system as `download_dir`.
    pub temp_dir: PathBuf,
    /// Reference: 60 s.
    pub timeout: Duration,
    /// Largest clip accepted. The reference had none; 100 MiB is far above a 60 s clip at 480p.
    pub max_bytes: u64,
    /// Captured output of the downloader (stdout and stderr together).
    pub max_output: usize,
    /// How often the watchdog measures the run directory.
    pub size_poll: Duration,
}

impl Config {
    /// The reference's limits with the stated defaults for what it lacked.
    pub fn new(downloader: PathBuf, download_dir: PathBuf, temp_dir: PathBuf) -> Self {
        Self {
            downloader,
            download_dir,
            temp_dir,
            timeout: Duration::from_secs(60),
            max_bytes: 100 * 1024 * 1024,
            max_output: 1024 * 1024,
            size_poll: Duration::from_millis(250),
        }
    }
}

/// A Twitch channel (user) id: 1 to 20 ASCII digits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelId(String);

impl ChannelId {
    pub fn parse(value: &str) -> Result<Self, Error> {
        if value.is_empty()
            || value.len() > MAX_CHANNEL_ID
            || !value.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(Error::InvalidChannel);
        }
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    fn file_name(&self) -> String {
        format!("{}{FILE_SUFFIX}", self.0)
    }
}

/// A Twitch clip URL as Helix returns it, re-serialised from its parsed parts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClipUrl(String);

impl ClipUrl {
    pub fn parse(value: &str) -> Result<Self, Error> {
        // The URL parser strips surrounding controls and spaces and drops tabs and newlines
        // inside; refuse them on the raw text so what is checked is what was given.
        if value.is_empty()
            || value.len() > MAX_URL_BYTES
            || !value.bytes().all(|b| b.is_ascii_graphic())
            || value.contains('%')
        {
            return Err(Error::InvalidUrl);
        }
        let url = Url::parse(value).map_err(|_| Error::InvalidUrl)?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::InvalidUrl);
        }
        let Some(Host::Domain(host)) = url.host() else {
            return Err(Error::InvalidUrl);
        };
        // The parser resolves dot segments and reads `\` as `/`: the path given must already be
        // the path parsed, so nothing was normalised away.
        let raw_path = value
            .split_once("://")
            .and_then(|(_, rest)| rest.find('/').and_then(|i| rest.get(i..)));
        if raw_path != Some(url.path()) {
            return Err(Error::InvalidUrl);
        }
        let segments: Vec<&str> = url.path_segments().ok_or(Error::InvalidUrl)?.collect();
        let canonical = match (host, segments.as_slice()) {
            ("clips.twitch.tv", [slug]) if is_slug(slug) => {
                format!("https://clips.twitch.tv/{slug}")
            }
            ("www.twitch.tv", [login, "clip", slug]) if is_login(login) && is_slug(slug) => {
                format!("https://www.twitch.tv/{login}/clip/{slug}")
            }
            _ => return Err(Error::InvalidUrl),
        };
        Ok(Self(canonical))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn is_slug(s: &str) -> bool {
    s.len() <= MAX_SLUG
        && s.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn is_login(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_LOGIN
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Clip downloads into the served directory.
#[derive(Clone, Debug)]
pub struct Clips {
    downloader: Program,
    download_dir: PathBuf,
    temp_dir: PathBuf,
    config: Config,
    random: Arc<dyn Random>,
}

impl Clips {
    /// Checks the configuration at startup: the downloader (absolute, executable regular
    /// file), both directories (absolute; the download directory is created when missing;
    /// symlinks resolved now, never later) on one file system, and the limits.
    pub fn new(config: Config, random: Arc<dyn Random>) -> Result<Self, Error> {
        if config.timeout.is_zero()
            || config.max_bytes == 0
            || config.max_output == 0
            || config.size_poll.is_zero()
        {
            return Err(Error::Config("limits must be non-zero"));
        }
        let downloader =
            Program::new(&config.downloader).map_err(|_| Error::Config("downloader"))?;
        if !config.download_dir.is_absolute() || !config.temp_dir.is_absolute() {
            return Err(Error::Config("directories must be absolute"));
        }
        std::fs::create_dir_all(&config.download_dir)
            .map_err(|_| Error::Config("download directory"))?;
        let download_dir = std::fs::canonicalize(&config.download_dir)
            .map_err(|_| Error::Config("download directory"))?;
        let temp_dir = std::fs::canonicalize(&config.temp_dir)
            .map_err(|_| Error::Config("temporary directory"))?;
        let download_meta =
            std::fs::metadata(&download_dir).map_err(|_| Error::Config("download directory"))?;
        let temp_meta =
            std::fs::metadata(&temp_dir).map_err(|_| Error::Config("temporary directory"))?;
        if !download_meta.is_dir() || !temp_meta.is_dir() {
            return Err(Error::Config("directories must be directories"));
        }
        if download_meta.dev() != temp_meta.dev() {
            return Err(Error::Config(
                "temporary and download directories must share a file system",
            ));
        }
        Ok(Self {
            downloader,
            download_dir,
            temp_dir,
            config,
            random,
        })
    }

    /// `<download dir>/<channel id>-clip.mp4`.
    pub fn clip_path(&self, channel: &ChannelId) -> PathBuf {
        self.download_dir.join(channel.file_name())
    }

    /// `downloadClip`: downloads `url` and puts it in place for `channel`; returns its path.
    pub async fn download_clip(&self, url: &str, channel_id: &str) -> Result<PathBuf, Error> {
        let url = ClipUrl::parse(url)?;
        let channel = ChannelId::parse(channel_id)?;
        let run = RunDir::create(&self.temp_dir, "clip", self.random.as_ref()).await?;
        let result = self.download_in(&run, &url, &channel).await;
        run.remove().await;
        result
    }

    async fn download_in(
        &self,
        run: &RunDir,
        url: &ClipUrl,
        channel: &ChannelId,
    ) -> Result<PathBuf, Error> {
        let args: Vec<OsString> = [
            "--ignore-config",
            "--no-cache-dir",
            "--no-progress",
            "-S",
            "res:480",
            "--max-filesize",
            &self.config.max_bytes.to_string(),
            "-o",
            OUTPUT_NAME,
            "--",
            url.as_str(),
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        let invocation = Invocation {
            args,
            env: vec![
                ("HOME", run.path.clone().into_os_string()),
                ("LANG", OsString::from("C.UTF-8")),
            ],
            cwd: &run.path,
            timeout: self.config.timeout,
            max_output: self.config.max_output,
        };
        let watchdog = size_watchdog(&run.path, self.config.max_bytes, self.config.size_poll);
        match self.downloader.run_until(invocation, watchdog).await {
            Ok(_) => {}
            Err(process::Error::Stopped) => return Err(Error::TooLarge),
            Err(e) => return Err(e.into()),
        }
        let produced = run.path.join(OUTPUT_NAME);
        let meta = match tokio::fs::symlink_metadata(&produced).await {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Error::Missing),
            Err(e) => return Err(e.into()),
        };
        if !meta.file_type().is_file() || meta.len() == 0 {
            return Err(Error::Missing);
        }
        if meta.len() > self.config.max_bytes {
            return Err(Error::TooLarge);
        }
        let target = self.clip_path(channel);
        tokio::fs::rename(&produced, &target).await?;
        Ok(target)
    }

    /// `deleteOldClip`: removes the channel's clip file if there is one (a symlink there is
    /// removed, never followed). The reference logged and swallowed failures; the caller does.
    pub async fn delete_old_clip(&self, channel_id: &str) -> Result<(), Error> {
        let channel = ChannelId::parse(channel_id)?;
        match tokio::fs::remove_file(self.clip_path(&channel)).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// `checkIfClipExists`: whether a regular file is in place for the channel (`lstat`: a
    /// symlink there is not followed and counts as no clip).
    pub async fn clip_exists(&self, channel_id: &str) -> Result<bool, Error> {
        let channel = ChannelId::parse(channel_id)?;
        match tokio::fs::symlink_metadata(self.clip_path(&channel)).await {
            Ok(meta) => Ok(meta.file_type().is_file()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }
}

/// Completes when the files directly in `dir` hold more than `max` bytes.
async fn size_watchdog(dir: &Path, max: u64, poll: Duration) {
    let mut tick = tokio::time::interval(poll);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        if directory_bytes(dir).await > max {
            return;
        }
    }
}

async fn directory_bytes(dir: &Path) -> u64 {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return 0;
    };
    let mut total = 0_u64;
    while let Ok(Some(entry)) = entries.next_entry().await {
        if let Ok(meta) = entry.metadata().await {
            total = total.saturating_add(meta.len());
        }
    }
    total
}
