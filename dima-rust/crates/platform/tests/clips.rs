// Tests use a fake downloader (a shell script written into the test's own directory); the real
// yt-dlp is never run and nothing leaves the machine.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use anyhow::Result;
use dima_core::{Random, SystemRandom};
use dima_platform::clips::{ChannelId, ClipUrl, Clips, Config, Error};
use dima_platform::process;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// The fake downloader. Its working directory is `<base>/tmp/clip-<hex>`, so `../..` is the
/// test's base directory, where it reads its `mode` and writes what it observed to `rec/`.
const FAKE: &str = r#"#!/bin/sh
B="$(cd ../.. && pwd -P)"
R="$B/rec"
/usr/bin/mkdir -p "$R"
printf '%s\0' "$@" > "$R/args"
/usr/bin/cat /proc/$$/environ > "$R/env"
pwd -P > "$R/cwd"
echo $$ > "$R/pid"
mode="$(/usr/bin/cat "$B/mode")"
case "$mode" in
  ok) printf 'MP4DATA' > clip.mp4.part; /usr/bin/mv clip.mp4.part clip.mp4; echo done ;;
  slow) echo $$ > clip.mp4.part; /usr/bin/sleep 0.3; /usr/bin/mv clip.mp4.part clip.mp4 ;;
  fail) echo "ERROR: Unsupported URL" >&2; echo partial > clip.mp4.part; exit 1 ;;
  noisy) /usr/bin/head -c 3000000 /dev/zero ;;
  hang) : > "$R/started"; /usr/bin/sleep 1000 ;;
  fork) /usr/bin/sleep 1000 & echo $! > "$R/child"; : > "$R/started"; /usr/bin/sleep 1000 ;;
  forkexit) /usr/bin/sleep 1000 & echo $! > "$R/child"; printf 'x' > clip.mp4; exit 0 ;;
  big) /usr/bin/head -c 3000000 /dev/zero > clip.mp4.part; /usr/bin/sleep 1000 ;;
  bigdone) /usr/bin/head -c 3000000 /dev/zero > clip.mp4 ;;
  missing) exit 0 ;;
  empty) : > clip.mp4 ;;
  symlink) /usr/bin/ln -s /etc/hostname clip.mp4 ;;
  enospc) printf 'x' > /dev/full 2>/dev/null || { echo "ERROR: [Errno 28] No space left on device" >&2; exit 1; } ;;
esac
"#;

struct Rig {
    base: PathBuf,
}

impl Rig {
    fn new() -> Result<Self> {
        let base = std::env::temp_dir().join(format!(
            "dima_test_platform_{}",
            SystemRandom.hex_token(12)?
        ));
        std::fs::create_dir(&base)?;
        std::fs::create_dir(base.join("tmp"))?;
        std::fs::create_dir(base.join("bin"))?;
        let fake = base.join("bin/yt-dlp");
        std::fs::write(&fake, FAKE)?;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755))?;
        Ok(Self { base })
    }
    fn config(&self) -> Config {
        let mut c = Config::new(
            self.base.join("bin/yt-dlp"),
            self.base.join("public/downloads"),
            self.base.join("tmp"),
        );
        c.timeout = Duration::from_secs(10);
        c.max_bytes = 1024 * 1024;
        c.max_output = 64 * 1024;
        c.size_poll = Duration::from_millis(50);
        c
    }
    fn clips(&self, config: Config) -> Clips {
        Clips::new(config, Arc::new(SystemRandom)).unwrap()
    }
    fn mode(&self, mode: &str) {
        std::fs::write(self.base.join("mode"), mode).unwrap();
    }
    fn rec(&self, name: &str) -> Option<Vec<u8>> {
        std::fs::read(self.base.join("rec").join(name)).ok()
    }
    fn pid(&self, name: &str) -> i32 {
        String::from_utf8(self.rec(name).unwrap())
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }
    fn temp_entries(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(self.base.join("tmp"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }
    async fn wait_for(&self, name: &str) {
        for _ in 0..500 {
            if self.rec(name).is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("fake never wrote {name}");
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        for dir in ["tmp", "public/downloads"] {
            let _ = std::fs::set_permissions(
                self.base.join(dir),
                std::fs::Permissions::from_mode(0o755),
            );
        }
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

/// `download_clip`, retrying a start refused with ETXTBSY: another test thread forking while
/// this test wrote its script can hold the file open for writing for an instant.
async fn download(clips: &Clips, url: &str, channel: &str) -> Result<PathBuf, Error> {
    let mut tries = 0;
    loop {
        match clips.download_clip(url, channel).await {
            Err(Error::Process(process::Error::Spawn(e)))
                if e.kind() == std::io::ErrorKind::ExecutableFileBusy && tries < 100 =>
            {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            other => return other,
        }
    }
}

/// Dead means gone, or a zombie waiting for whoever adopted it.
async fn assert_dead(pid: i32) {
    for _ in 0..500 {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => return,
            Ok(stat) => {
                let state = stat.rsplit_once(") ").map(|(_, rest)| rest.chars().next());
                if state == Some(Some('Z')) || state == Some(Some('X')) {
                    return;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("process {pid} is still alive");
}

const URL: &str = "https://clips.twitch.tv/AwkwardHelplessSalamanderSwiftRage-6Un4sDP4ITkHJYEk";

#[tokio::test]
async fn success_runs_exact_vector_env_and_cwd_and_renames_into_place() -> Result<()> {
    let rig = Rig::new()?;
    rig.mode("ok");
    let clips = rig.clips(rig.config());
    let path = download(&clips, URL, "123456").await?;
    let downloads = std::fs::canonicalize(rig.base.join("public/downloads"))?;
    assert_eq!(path, downloads.join("123456-clip.mp4"));
    assert_eq!(std::fs::read(&path)?, b"MP4DATA");
    let args: Vec<String> = String::from_utf8(rig.rec("args").unwrap())?
        .split_terminator('\0')
        .map(str::to_owned)
        .collect();
    assert_eq!(
        args,
        [
            "--ignore-config",
            "--no-cache-dir",
            "--no-progress",
            "-S",
            "res:480",
            "--max-filesize",
            "1048576",
            "-o",
            "clip.mp4",
            "--",
            URL
        ]
    );
    let cwd = String::from_utf8(rig.rec("cwd").unwrap())?;
    let cwd = Path::new(cwd.trim());
    let temp = std::fs::canonicalize(rig.base.join("tmp"))?;
    assert_eq!(cwd.parent(), Some(temp.as_path()));
    let name = cwd.file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with("clip-") && name.len() == 5 + 24, "{name}");
    let env: Vec<String> = String::from_utf8(rig.rec("env").unwrap())?
        .split_terminator('\0')
        .map(str::to_owned)
        .collect();
    assert_eq!(
        env,
        [format!("HOME={}", cwd.display()), "LANG=C.UTF-8".to_owned()]
    );
    assert!(rig.temp_entries().is_empty(), "run directory removed");
    assert!(clips.clip_exists("123456").await?);
    Ok(())
}

#[tokio::test]
async fn non_zero_exit_reports_output_and_cleans_up() -> Result<()> {
    let rig = Rig::new()?;
    rig.mode("fail");
    let clips = rig.clips(rig.config());
    let err = download(&clips, URL, "1").await.unwrap_err();
    let Error::Process(process::Error::Failed { status, stderr, .. }) = err else {
        panic!("{err:?}");
    };
    assert_eq!(status.code(), Some(1));
    assert_eq!(stderr, b"ERROR: Unsupported URL\n");
    assert!(rig.temp_entries().is_empty());
    assert!(!clips.clip_exists("1").await?);
    Ok(())
}

#[tokio::test]
async fn full_disk_in_the_program_is_a_failure_and_cleans_up() -> Result<()> {
    let rig = Rig::new()?;
    rig.mode("enospc");
    let clips = rig.clips(rig.config());
    let err = download(&clips, URL, "1").await.unwrap_err();
    assert!(
        matches!(&err, Error::Process(process::Error::Failed { stderr, .. })
            if String::from_utf8_lossy(stderr).contains("No space left")),
        "{err:?}"
    );
    assert!(rig.temp_entries().is_empty());
    Ok(())
}

#[tokio::test]
async fn output_over_the_limit_kills_the_program() -> Result<()> {
    let rig = Rig::new()?;
    rig.mode("noisy");
    let clips = rig.clips(rig.config());
    let err = download(&clips, URL, "1").await.unwrap_err();
    assert!(
        matches!(err, Error::Process(process::Error::OutputLimit)),
        "{err:?}"
    );
    assert_dead(rig.pid("pid")).await;
    assert!(rig.temp_entries().is_empty());
    Ok(())
}

#[tokio::test]
async fn a_hanging_program_is_killed_at_the_time_limit() -> Result<()> {
    let rig = Rig::new()?;
    rig.mode("hang");
    let mut config = rig.config();
    config.timeout = Duration::from_millis(500);
    let clips = rig.clips(config);
    let started = std::time::Instant::now();
    let err = download(&clips, URL, "1").await.unwrap_err();
    assert!(
        matches!(err, Error::Process(process::Error::Timeout)),
        "{err:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_dead(rig.pid("pid")).await;
    assert!(rig.temp_entries().is_empty());
    Ok(())
}

#[tokio::test]
async fn a_forked_child_dies_with_its_group_at_the_time_limit() -> Result<()> {
    let rig = Rig::new()?;
    rig.mode("fork");
    let mut config = rig.config();
    config.timeout = Duration::from_millis(500);
    let clips = rig.clips(config);
    let err = download(&clips, URL, "1").await.unwrap_err();
    assert!(
        matches!(err, Error::Process(process::Error::Timeout)),
        "{err:?}"
    );
    assert_dead(rig.pid("pid")).await;
    assert_dead(rig.pid("child")).await;
    assert!(rig.temp_entries().is_empty());
    Ok(())
}

#[tokio::test]
async fn a_child_left_behind_after_a_clean_exit_is_killed() -> Result<()> {
    let rig = Rig::new()?;
    rig.mode("forkexit");
    let clips = rig.clips(rig.config());
    let started = std::time::Instant::now();
    // The leftover holds the output pipes open: without the group kill this would wait for
    // the 10 s limit.
    let path = download(&clips, URL, "77").await?;
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(std::fs::read(path)?, b"x");
    assert_dead(rig.pid("child")).await;
    Ok(())
}

#[tokio::test]
async fn dropping_the_caller_kills_the_group_and_removes_the_run_directory() -> Result<()> {
    let rig = Arc::new(Rig::new()?);
    rig.mode("fork");
    let clips = rig.clips(rig.config());
    let task = tokio::spawn(async move { download(&clips, URL, "1").await });
    rig.wait_for("started").await;
    rig.wait_for("child").await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_dead(rig.pid("pid")).await;
    assert_dead(rig.pid("child")).await;
    assert!(rig.temp_entries().is_empty());
    Ok(())
}

#[tokio::test]
async fn size_limit_stops_a_growing_download_and_refuses_a_finished_one() -> Result<()> {
    let rig = Rig::new()?;
    let clips = rig.clips(rig.config());
    rig.mode("big");
    let err = download(&clips, URL, "1").await.unwrap_err();
    assert!(matches!(err, Error::TooLarge), "{err:?}");
    assert_dead(rig.pid("pid")).await;
    assert!(rig.temp_entries().is_empty());
    rig.mode("bigdone");
    let err = download(&clips, URL, "1").await.unwrap_err();
    assert!(matches!(err, Error::TooLarge), "{err:?}");
    assert!(rig.temp_entries().is_empty());
    assert!(!clips.clip_exists("1").await?);
    Ok(())
}

#[tokio::test]
async fn missing_empty_or_symlinked_output_is_refused() -> Result<()> {
    let rig = Rig::new()?;
    let clips = rig.clips(rig.config());
    for mode in ["missing", "empty", "symlink"] {
        rig.mode(mode);
        let err = download(&clips, URL, "1").await.unwrap_err();
        assert!(matches!(err, Error::Missing), "{mode}: {err:?}");
        assert!(rig.temp_entries().is_empty());
        assert!(!clips.clip_exists("1").await?);
    }
    Ok(())
}

#[tokio::test]
async fn hostile_urls_and_channel_ids_are_refused_before_anything_runs() -> Result<()> {
    let rig = Rig::new()?;
    rig.mode("ok");
    let clips = rig.clips(rig.config());
    let urls = [
        "--exec=touch /tmp/pwned",
        "-o/etc/passwd",
        "https://clips.twitch.tv/Slug\"; touch /tmp/pwned; echo \"",
        "https://clips.twitch.tv/Slug$(id)",
        "https://clips.twitch.tv/Slug`id`",
        "https://clips.twitch.tv/Slug;id",
        "https://clips.twitch.tv/Slug|id",
        "https://clips.twitch.tv/../../etc/passwd",
        "https://clips.twitch.tv/%2e%2e/x",
        "https://clips.twitch.tv/a/../b",
        "https://clips.twitch.tv/./Slug",
        "https://clips.twitch.tv\\Slug",
        "https://clips.twitch.tv/a\\..\\Slug",
        "https://clips.twitch.tv/Slug\n--exec=id",
        "https://clips.twitch.tv/Slug\r",
        "https://clips.twitch.tv/Sl\tug",
        " https://clips.twitch.tv/Slug",
        "https://clips.twitch.tv/-Slug",
        "https://clips.twitch.tv/",
        "https://clips.twitch.tv/Slug/",
        "https://clips.twitch.tv/Slug?x=1",
        "https://clips.twitch.tv/Slug#x",
        "https://user:pass@clips.twitch.tv/Slug",
        "https://clips.twitch.tv:8443/Slug",
        "https://clips.twitch.tv.evil.example/Slug",
        "https://evil.example/Slug",
        "https://127.0.0.1/Slug",
        "https://clіps.twitch.tv/Slug",
        "http://clips.twitch.tv/Slug",
        "file:///etc/passwd",
        "ftp://clips.twitch.tv/Slug",
        "https://www.twitch.tv/some-one/clip/Slug",
        "https://www.twitch.tv/login/clips/Slug",
        "https://m.twitch.tv/login/clip/Slug",
        "",
    ];
    for url in urls {
        assert!(
            matches!(ClipUrl::parse(url), Err(Error::InvalidUrl)),
            "{url:?}"
        );
        let err = download(&clips, url, "1").await.unwrap_err();
        assert!(matches!(err, Error::InvalidUrl), "{url:?} {err:?}");
    }
    let long = format!("https://clips.twitch.tv/{}", "a".repeat(101));
    assert!(ClipUrl::parse(&long).is_err());
    let channels = [
        "",
        "-1",
        "--exec",
        "12 34",
        "1;id",
        "$(id)",
        "../1",
        "..",
        "1/2",
        "1\n2",
        "١٢٣",
        "123456789012345678901",
        "abc",
    ];
    for channel in channels {
        assert!(ChannelId::parse(channel).is_err(), "{channel:?}");
        let err = download(&clips, URL, channel).await.unwrap_err();
        assert!(matches!(err, Error::InvalidChannel), "{channel:?} {err:?}");
        assert!(matches!(
            clips.delete_old_clip(channel).await,
            Err(Error::InvalidChannel)
        ));
        assert!(matches!(
            clips.clip_exists(channel).await,
            Err(Error::InvalidChannel)
        ));
    }
    assert!(rig.rec("args").is_none(), "the downloader never ran");
    assert!(rig.temp_entries().is_empty());
    Ok(())
}

#[test]
fn accepted_urls_are_re_serialised() -> Result<()> {
    for (given, canonical) in [
        (URL, URL),
        (
            "https://clips.twitch.tv:443/Slug_9",
            "https://clips.twitch.tv/Slug_9",
        ),
        (
            "HTTPS://CLIPS.TWITCH.TV/Slug",
            "https://clips.twitch.tv/Slug",
        ),
        (
            "https://www.twitch.tv/some_one/clip/Fancy-Slug_1",
            "https://www.twitch.tv/some_one/clip/Fancy-Slug_1",
        ),
    ] {
        assert_eq!(ClipUrl::parse(given)?.as_str(), canonical);
    }
    assert_eq!(ChannelId::parse("533538623")?.as_str(), "533538623");
    Ok(())
}

#[tokio::test]
async fn delete_and_exists_never_follow_a_symlink() -> Result<()> {
    let rig = Rig::new()?;
    let clips = rig.clips(rig.config());
    clips.delete_old_clip("5").await?;
    assert!(!clips.clip_exists("5").await?);
    let outside = rig.base.join("outside.mp4");
    std::fs::write(&outside, b"keep")?;
    let link = rig.base.join("public/downloads/5-clip.mp4");
    std::os::unix::fs::symlink(&outside, &link)?;
    assert!(!clips.clip_exists("5").await?, "a symlink is not a clip");
    clips.delete_old_clip("5").await?;
    assert!(std::fs::symlink_metadata(&link).is_err(), "link removed");
    assert_eq!(std::fs::read(&outside)?, b"keep", "target untouched");
    // A download replaces a symlink at the name instead of writing through it.
    std::os::unix::fs::symlink(&outside, &link)?;
    rig.mode("ok");
    download(&clips, URL, "5").await?;
    assert_eq!(std::fs::read(&outside)?, b"keep");
    assert!(std::fs::symlink_metadata(&link)?.file_type().is_file());
    clips.delete_old_clip("5").await?;
    assert!(!clips.clip_exists("5").await?);
    Ok(())
}

#[tokio::test]
async fn unwritable_directories_fail_cleanly() -> Result<()> {
    let rig = Rig::new()?;
    rig.mode("ok");
    let clips = rig.clips(rig.config());
    let tmp = rig.base.join("tmp");
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o555))?;
    let err = download(&clips, URL, "1").await.unwrap_err();
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    assert!(
        matches!(&err, Error::Io(e) if e.kind() == std::io::ErrorKind::PermissionDenied),
        "{err:?}"
    );
    assert!(rig.rec("args").is_none());
    let downloads = rig.base.join("public/downloads");
    std::fs::set_permissions(&downloads, std::fs::Permissions::from_mode(0o555))?;
    let err = download(&clips, URL, "1").await.unwrap_err();
    std::fs::set_permissions(&downloads, std::fs::Permissions::from_mode(0o755))?;
    assert!(
        matches!(&err, Error::Io(e) if e.kind() == std::io::ErrorKind::PermissionDenied),
        "{err:?}"
    );
    assert!(rig.temp_entries().is_empty(), "run directory removed");
    assert!(!clips.clip_exists("1").await?);
    Ok(())
}

#[tokio::test]
async fn two_downloads_for_one_channel_leave_one_complete_file() -> Result<()> {
    let rig = Rig::new()?;
    rig.mode("slow");
    let clips = rig.clips(rig.config());
    let (a, b) = tokio::join!(download(&clips, URL, "9"), download(&clips, URL, "9"));
    let (a, b) = (a?, b?);
    assert_eq!(a, b);
    let content = String::from_utf8(std::fs::read(&a)?)?;
    let pid: i32 = content.trim().parse()?;
    assert!(pid > 1, "one whole download: {content:?}");
    assert!(rig.temp_entries().is_empty());
    Ok(())
}

#[test]
fn configuration_is_checked_at_startup() -> Result<()> {
    let rig = Rig::new()?;
    let refused =
        |c: Config| matches!(Clips::new(c, Arc::new(SystemRandom)), Err(Error::Config(_)));
    let mut c = rig.config();
    c.downloader = PathBuf::from("bin/yt-dlp");
    assert!(refused(c), "relative program");
    let mut c = rig.config();
    c.downloader = rig.base.join("bin/none");
    assert!(refused(c), "missing program");
    let plain = rig.base.join("bin/plain");
    std::fs::write(&plain, "x")?;
    let mut c = rig.config();
    c.downloader = plain;
    assert!(refused(c), "not executable");
    let mut c = rig.config();
    c.downloader = rig.base.join("bin");
    assert!(refused(c), "a directory");
    let mut c = rig.config();
    c.temp_dir = PathBuf::from("tmp");
    assert!(refused(c), "relative directory");
    let mut c = rig.config();
    c.temp_dir = rig.base.join("nope");
    assert!(refused(c), "missing temporary directory");
    let mut c = rig.config();
    c.timeout = Duration::ZERO;
    assert!(refused(c), "zero limit");
    // A symlinked program path is resolved once, at startup.
    let link = rig.base.join("bin/link");
    std::os::unix::fs::symlink(rig.base.join("bin/yt-dlp"), &link)?;
    let program = process::Program::new(&link)?;
    assert_eq!(
        program.path(),
        std::fs::canonicalize(rig.base.join("bin/yt-dlp"))?
    );
    Ok(())
}
