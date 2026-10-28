use std::path::{Path, PathBuf};

/// The caller supplies the deployed module's public/speech directory explicitly.
#[derive(Clone, Debug)]
pub struct SpeechPaths {
    pub speech_root: PathBuf,
    pub public_api_url: String,
}
impl SpeechPaths {
    pub fn new(speech_root: PathBuf, configured_api_url: Option<&str>, production: bool) -> Self {
        let url = configured_api_url
            .filter(|s| !crate::utils::js_compat::trim(s).is_empty())
            .unwrap_or(if production {
                "https://api.domdimabot.com"
            } else {
                "http://localhost:3000"
            });
        Self {
            speech_root,
            public_api_url: url.trim_end_matches('/').to_owned(),
        }
    }
    pub fn output_dir(&self, channel: &str) -> PathBuf {
        node_join(&self.speech_root, channel)
    }
    pub fn public_path(&self, channel: &str, speech: &str) -> String {
        format!(
            "{}/speech/audio/{}/{}",
            self.public_api_url,
            encode_component(channel),
            encode_component(speech)
        )
    }
}
/// Node path.join uses concatenation then lexical normalization, including for
/// later absolute-looking segments; this does not enforce a security boundary.
pub fn node_join(base: &Path, part: &str) -> PathBuf {
    // Runtime paths and IDs originate as ordinary Unicode strings, as in Node.
    let base = base.to_string_lossy();
    let joined = if base.is_empty() {
        part.to_owned()
    } else if part.is_empty() {
        base.into_owned()
    } else {
        format!("{base}/{part}")
    };
    let absolute = joined.starts_with('/');
    let trailing_slash = joined.ends_with('/');
    let mut parts = Vec::new();
    for component in joined.split('/') {
        match component {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            ".." if !absolute => parts.push(".."),
            ".." => {}
            other => parts.push(other),
        }
    }
    let mut normalized = if absolute {
        String::from("/")
    } else {
        String::new()
    };
    normalized.push_str(&parts.join("/"));
    if normalized.is_empty() {
        normalized.push('.');
    }
    if trailing_slash && !normalized.ends_with('/') {
        normalized.push('/');
    }
    PathBuf::from(normalized)
}

fn encode_component(s: &str) -> String {
    use std::fmt::Write;
    let mut result = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            result.push(b as char);
        } else {
            let _ = write!(result, "%{b:02X}");
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_join_keeps_unresolved_relative_parents() {
        for (base, part, expected) in [
            ("..", "../child", "../../child"),
            ("../..", "../child", "../../../child"),
            ("../a", "../../b", "../../b"),
            ("/a", "/b/../c", "/a/c"),
            ("/", "../../b", "/b"),
            ("", "relative", "relative"),
            ("", "", "."),
            ("a", "../", "./"),
        ] {
            assert_eq!(
                node_join(Path::new(base), part).as_os_str(),
                Path::new(expected).as_os_str()
            );
        }
    }

    #[test]
    fn api_url_and_uri_components_match_public_helper() {
        let paths = SpeechPaths::new("/speech".into(), Some(" https://example.test///"), true);
        assert_eq!(
            paths.public_path("a/b ?", "é+!"),
            " https://example.test/speech/audio/a%2Fb%20%3F/%C3%A9%2B!"
        );
        assert_eq!(
            SpeechPaths::new("/speech".into(), Some("\u{feff} "), true).public_api_url,
            "https://api.domdimabot.com"
        );
        assert_eq!(
            SpeechPaths::new("/speech".into(), Some("///"), false).public_api_url,
            ""
        );
    }
}
