//! Filesystem adapter for `utils/fs.ts`.
use std::{
    io,
    path::{Path, PathBuf},
};

pub const MAX_FILE_SIZE: u64 = 1024 * 1024;
pub const TOO_LARGE: &str = "File too large. Maximum size is 1048576 bytes";

/// Node's `path.resolve` is lexical and does not resolve symlinks.
pub fn resolve(path: &Path) -> io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut result = PathBuf::new();
    for part in absolute.components() {
        match part {
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::CurDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    Ok(result)
}

/// Stat before reading, as in the source. Invalid UTF-8 is replaced, as in Node.
pub async fn read_file(path: impl AsRef<Path>) -> Result<String, String> {
    let path = resolve(path.as_ref()).map_err(|error| error.to_string())?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| node_io_error("stat", &path, &error))?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(TOO_LARGE.to_owned());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| node_io_error("open", &path, &error))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn node_io_error(operation: &str, path: &Path, error: &io::Error) -> String {
    if operation == "open" && error.raw_os_error() == Some(21) {
        return "EISDIR: illegal operation on a directory, read".to_owned();
    }
    let (code, description) = match error.raw_os_error() {
        Some(2) => ("ENOENT", "no such file or directory"),
        Some(13) => ("EACCES", "permission denied"),
        Some(21) => ("EISDIR", "illegal operation on a directory"),
        Some(20) => ("ENOTDIR", "not a directory"),
        _ => return format!("{operation} '{}': {error}", path.display()),
    };
    format!("{code}: {description}, {operation} '{}'", path.display())
}
