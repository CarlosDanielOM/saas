//! The rule of `src/state.rs`, checked on the source of every route module: a handler takes
//! its channel from a guard and its body as a typed value. Reading the `channelID` path
//! parameter, or the raw body, is refused here unless the line just above says why with a
//! `// raw body:` (or `// raw channel:`) comment, which a reviewer then reads.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn handlers_read_neither_the_channel_nor_the_raw_body() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&root, &mut files);
    let mut refused = Vec::new();
    for file in files {
        let relative = file.strip_prefix(&root).unwrap().display().to_string();
        // The rule's own helpers.
        if relative == "state.rs" {
            continue;
        }
        let text = std::fs::read_to_string(&file).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        for (index, line) in lines.iter().enumerate() {
            let code = line.split("//").next().unwrap_or_default();
            let above = index
                .checked_sub(1)
                .and_then(|above| lines.get(above))
                .map(|above| above.trim())
                .unwrap_or_default();
            let raw_body = [
                "req.body()",
                "req.body_bytes()",
                "req.take_body_stream()",
                "req.body_as",
            ]
            .iter()
            .any(|call| code.contains(call));
            if raw_body && !above.starts_with("// raw body:") {
                refused.push(format!("{relative}:{}: raw body", index + 1));
            }
            if code.contains("\"channelID\"") && !above.starts_with("// raw channel:") {
                refused.push(format!("{relative}:{}: channelID read by hand", index + 1));
            }
        }
    }
    assert!(refused.is_empty(), "{refused:#?}");
}
