#![forbid(unsafe_code)]
// Shared HTTP Path takes static templates. Generate bounded arities for all valid S3 keys
// (1024 bytes, nonempty segments), including a path-style bucket. No leaked allocations.
fn main() -> std::io::Result<()> {
    let out =
        std::env::var_os("OUT_DIR").ok_or_else(|| std::io::Error::other("OUT_DIR missing"))?;
    let templates: Vec<String> = (0..=514)
        .map(|n| format!("/{}", vec!["{}"; n].join("/")))
        .collect();
    std::fs::write(
        std::path::PathBuf::from(out).join("paths.rs"),
        format!("const TEMPLATES: &[&str] = &{templates:?};"),
    )
}
