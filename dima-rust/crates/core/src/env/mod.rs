//! The process environment, read once at startup.
//!
//! Binaries build one [`EnvSource`] before anything else ([`EnvSource::load`] reproduces the
//! reference's dotenv order) and hand typed configuration structs to the library crates. No other
//! code in the workspace calls `std::env::var`. The readers in [`read`] reproduce each JavaScript
//! idiom the reference uses to parse a value; their module documentation lists them.
//!
//! Each crate that reads variables declares them in a `pub const ENV: &[EnvVar]`, so a binary can
//! print the full list ([`describe`]) and warn at startup about variables that are set but that no
//! crate reads, or declared but not set ([`EnvSource::audit`]).

pub mod dotenv;
pub mod read;

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};

/// Configuration errors found while reading the environment.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EnvError {
    /// A value the reference rejects at startup (`throw new Error('Invalid <name>')`).
    #[error("Invalid {name}")]
    Invalid {
        /// The variable name.
        name: String,
    },
    /// A variable the reference requires at startup is unset or empty.
    #[error("{name} is not set")]
    Missing {
        /// The variable name.
        name: String,
    },
}

/// An immutable snapshot of environment variables, in the order they were added.
#[derive(Clone, Default)]
pub struct EnvSource {
    entries: Vec<(String, String)>,
    index: HashMap<String, usize>,
}

impl fmt::Debug for EnvSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Values may be secrets: show only how many there are.
        write!(f, "EnvSource({} variables)", self.entries.len())
    }
}

impl EnvSource {
    /// The process environment as it is now. Names and values that are not UTF-8 are converted
    /// lossily. This is the only place in the workspace that reads the process environment.
    pub fn from_process() -> Self {
        Self::from_pairs(std::env::vars_os().map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        }))
    }

    /// A snapshot from explicit pairs (tests, child environments). A later duplicate name
    /// replaces the earlier value in place.
    pub fn from_pairs<I, K, V>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let mut env = Self::default();
        for (name, value) in pairs {
            env.set(name.into(), value.into());
        }
        env
    }

    fn set(&mut self, name: String, value: String) {
        match self.index.get(&name) {
            Some(&position) => {
                if let Some(entry) = self.entries.get_mut(position) {
                    entry.1 = value;
                }
            }
            None => {
                self.index.insert(name.clone(), self.entries.len());
                self.entries.push((name, value));
            }
        }
    }

    /// The process environment plus the dotenv files in the reference's order (see
    /// [`EnvSource::apply_dotenv_files`]), reading the files from `cwd`.
    pub fn load(cwd: &Path) -> (Self, DotenvReport) {
        let mut env = Self::from_process();
        let report = env.apply_dotenv_files(cwd);
        (env, report)
    }

    /// The reference's loading order: when `NODE_ENV` is not `production`, `cwd/.env.local`
    /// first; then `cwd/.env`. A file never overrides a variable that is already set, so
    /// precedence is: real environment, then `.env.local`, then `.env`. A missing or unreadable
    /// file is skipped, as dotenv does, and noted in the report.
    pub fn apply_dotenv_files(&mut self, cwd: &Path) -> DotenvReport {
        let mut report = DotenvReport::default();
        if self.get("NODE_ENV") != Some("production") {
            report
                .files
                .push(self.apply_dotenv_file(&cwd.join(".env.local")));
        }
        report.files.push(self.apply_dotenv_file(&cwd.join(".env")));
        report
    }

    /// `dotenv.config({ path })`: parse one file and add the variables that are not set yet.
    pub fn apply_dotenv_file(&mut self, path: &Path) -> DotenvFile {
        let status = match std::fs::read(path) {
            Ok(bytes) => {
                let parsed = dotenv::parse(&String::from_utf8_lossy(&bytes));
                let mut applied = 0;
                let total = parsed.len();
                for (name, value) in parsed {
                    if self.get(&name).is_none() {
                        self.set(name, value);
                        applied += 1;
                    }
                }
                DotenvStatus::Loaded {
                    parsed: total,
                    applied,
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => DotenvStatus::Missing,
            Err(error) => DotenvStatus::Unreadable(error.kind().to_string()),
        };
        DotenvFile {
            path: path.to_path_buf(),
            status,
        }
    }

    /// The value of `name`, or `None` when it is not set (JavaScript `undefined`).
    pub fn get(&self, name: &str) -> Option<&str> {
        let position = *self.index.get(name)?;
        self.entries.get(position).map(|(_, value)| value.as_str())
    }

    /// Every variable, in the order it was added (`Object.entries(process.env)`).
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }

    /// The variables whose names start with `prefix`, in order (for families such as
    /// `DIMADB_REDIS_*`).
    pub fn with_prefix<'a>(&'a self, prefix: &'a str) -> impl Iterator<Item = (&'a str, &'a str)> {
        self.iter()
            .filter(move |(name, _)| name.starts_with(prefix))
    }

    /// Compares what is set with what the crates declare. `ignore` adds exact names to the
    /// built-in list of operating-system and runtime variables ([`is_system_variable`]).
    pub fn audit(&self, declared: &[&[EnvVar]], ignore: &[&str]) -> EnvAudit {
        let is_declared = |name: &str| {
            declared
                .iter()
                .flat_map(|vars| vars.iter())
                .any(|var| var.name == name)
        };
        let mut unknown: Vec<String> = self
            .entries
            .iter()
            .map(|(name, _)| name.as_str())
            .filter(|name| {
                !is_declared(name) && !ignore.contains(name) && !is_system_variable(name)
            })
            .map(str::to_owned)
            .collect();
        unknown.sort();
        let mut unset: Vec<&'static str> = declared
            .iter()
            .flat_map(|vars| vars.iter())
            .filter(|var| self.get(var.name).is_none())
            .map(|var| var.name)
            .collect();
        unset.sort_unstable();
        unset.dedup();
        EnvAudit { unknown, unset }
    }
}

/// What happened to each dotenv file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DotenvReport {
    /// The files in the order they were tried.
    pub files: Vec<DotenvFile>,
}

/// One dotenv file and its outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DotenvFile {
    /// The path that was tried.
    pub path: PathBuf,
    /// The outcome.
    pub status: DotenvStatus,
}

/// The outcome of loading one dotenv file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DotenvStatus {
    /// Parsed; `applied` of the `parsed` variables were not already set and were added.
    Loaded {
        /// Variables in the file.
        parsed: usize,
        /// Variables added to the snapshot.
        applied: usize,
    },
    /// The file does not exist (the production case: images contain no `.env`).
    Missing,
    /// The file exists but could not be read; the reason is the I/O error kind.
    Unreadable(String),
}

/// One environment variable a crate reads. Declare them in a `pub const ENV: &[EnvVar]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnvVar {
    /// The variable name.
    pub name: &'static str,
    /// The default the reference applies when it is unset, as text, if any.
    pub default: Option<&'static str>,
    /// Whether the value is a secret (never printed).
    pub secret: bool,
    /// One line on what it controls.
    pub about: &'static str,
}

impl EnvVar {
    /// A variable with no default that is not secret.
    pub const fn new(name: &'static str, about: &'static str) -> Self {
        Self {
            name,
            default: None,
            secret: false,
            about,
        }
    }

    /// The same variable with a default.
    pub const fn with_default(self, default: &'static str) -> Self {
        Self {
            default: Some(default),
            ..self
        }
    }

    /// The same variable marked secret.
    pub const fn secret(self) -> Self {
        Self {
            secret: true,
            ..self
        }
    }
}

/// The variables this crate reads itself.
pub const ENV: &[EnvVar] = &[EnvVar::new(
    "NODE_ENV",
    "`production` skips `.env.local` when loading dotenv files",
)];

/// The result of [`EnvSource::audit`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnvAudit {
    /// Set, but no crate declares it (unused or misspelt), sorted.
    pub unknown: Vec<String>,
    /// Declared, but not set, so the default applies, sorted.
    pub unset: Vec<&'static str>,
}

/// Operating-system and runtime variables that are never configuration of ours.
pub fn is_system_variable(name: &str) -> bool {
    const NAMES: &[&str] = &[
        "_",
        "PATH",
        "HOME",
        "HOSTNAME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TERM",
        "PWD",
        "OLDPWD",
        "SHLVL",
        "LANG",
        "LANGUAGE",
        "TZ",
        "TMPDIR",
        "MAIL",
        "COLORTERM",
        "DISPLAY",
        "EDITOR",
        "PAGER",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
        "all_proxy",
        "RUST_BACKTRACE",
        "RUST_LOG",
        "CARGO_TARGET_DIR",
        "INVOCATION_ID",
        "JOURNAL_STREAM",
        "SYSTEMD_EXEC_PID",
        "MANAGERPID",
        "DBUS_SESSION_BUS_ADDRESS",
        "WAYLAND_DISPLAY",
        "SSH_AUTH_SOCK",
        "GPG_AGENT_INFO",
    ];
    const PREFIXES: &[&str] = &["LC_", "XDG_", "CARGO_", "RUSTUP_", "SSH_", "GIT_"];
    NAMES.contains(&name) || PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

/// One line per declared variable: name, whether it is set (values are never printed), default,
/// and what it controls. For a binary's `--print-env`.
pub fn describe(declared: &[&[EnvVar]], env: &EnvSource) -> String {
    let mut vars: Vec<&EnvVar> = declared.iter().flat_map(|vars| vars.iter()).collect();
    vars.sort_by_key(|var| var.name);
    vars.dedup_by_key(|var| var.name);
    let mut out = String::new();
    for var in vars {
        let state = if env.get(var.name).is_some() {
            "set"
        } else {
            "unset"
        };
        out.push_str(var.name);
        out.push('\t');
        out.push_str(state);
        if let Some(default) = var.default {
            out.push_str("\tdefault=");
            out.push_str(default);
        }
        if var.secret {
            out.push_str("\tsecret");
        }
        out.push('\t');
        out.push_str(var.about);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn later_duplicates_replace_in_place() {
        let env = EnvSource::from_pairs([("A", "1"), ("B", "2"), ("A", "3")]);
        assert_eq!(env.get("A"), Some("3"));
        assert_eq!(env.iter().collect::<Vec<_>>(), vec![("A", "3"), ("B", "2")]);
        assert_eq!(format!("{env:?}"), "EnvSource(2 variables)");
    }

    #[test]
    fn audit_reports_unknown_and_unset() {
        const MINE: &[EnvVar] = &[
            EnvVar::new("A", "a"),
            EnvVar::new("C", "c").with_default("5"),
            EnvVar::new("S", "s").secret(),
        ];
        let env = EnvSource::from_pairs([
            ("A", "1"),
            ("PATH", "/bin"),
            ("LC_ALL", "C"),
            ("ZED", "x"),
            ("S", "k"),
        ]);
        let audit = env.audit(&[MINE, ENV], &["IGNORED"]);
        assert_eq!(audit.unknown, vec!["ZED".to_owned()]);
        assert_eq!(audit.unset, vec!["C", "NODE_ENV"]);
        let text = describe(&[MINE], &env);
        assert!(text.contains("S\tset\tsecret\ts\n"));
        assert!(!text.contains('k'));
    }

    #[test]
    fn dotenv_files_follow_the_reference_order() {
        let dir = std::env::temp_dir().join(format!("dima-core-dotenv-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".env.local"), "A=local\nB=local\n").unwrap();
        std::fs::write(dir.join(".env"), "A=env\nB=env\nC=env\n").unwrap();

        let mut env = EnvSource::from_pairs([("B", "real")]);
        let report = env.apply_dotenv_files(&dir);
        assert_eq!(env.get("A"), Some("local"));
        assert_eq!(env.get("B"), Some("real"));
        assert_eq!(env.get("C"), Some("env"));
        assert_eq!(report.files.len(), 2);
        assert_eq!(
            report.files[0].status,
            DotenvStatus::Loaded {
                parsed: 2,
                applied: 1
            }
        );

        let mut production = EnvSource::from_pairs([("NODE_ENV", "production")]);
        let report = production.apply_dotenv_files(&dir);
        assert_eq!(production.get("A"), Some("env"));
        assert_eq!(report.files.len(), 1);

        let mut missing = EnvSource::default();
        let report = missing.apply_dotenv_files(&dir.join("nowhere"));
        assert!(
            report
                .files
                .iter()
                .all(|file| file.status == DotenvStatus::Missing)
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
