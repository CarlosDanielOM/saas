use std::{collections::HashSet, path::PathBuf};
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub socket: PathBuf,
    pub projects: HashSet<String>,
    pub sample_ms: u64,
    pub df_ms: u64,
    pub proc: PathBuf,
    pub net_dev: PathBuf,
    pub disk_path: PathBuf,
}
impl Config {
    pub fn from_values(get: impl Fn(&str) -> Option<String>) -> Self {
        let val = |key, default: &str| {
            get(key)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| default.into())
        };
        let interval = |key, default: u64, min: f64| {
            let n = dima_text::parse_number(&val(key, &default.to_string()));
            if n.is_finite() {
                n.max(min) as u64
            } else {
                default
            }
        };
        Self{port:dima_text::parse_number(&val("PORT","3211")) as u16,socket:val("DOCKER_SOCKET","/var/run/docker.sock").into(),projects:val("HOSTSTATS_PROJECTS","dimabot,dimafx,admin,dimasite,dimadocs,dimadb,databases,dima-analytics,dima-hoststats,network").split(',').map(dima_text::trim).filter(|s|!s.is_empty()).map(String::from).collect(),sample_ms:interval("HOSTSTATS_SAMPLE_MS",15000,5000.),df_ms:interval("HOSTSTATS_DF_MS",600000,60000.),proc:val("HOSTSTATS_PROC","/proc").into(),net_dev:val("HOSTSTATS_NET_DEV","/host/net_dev").into(),disk_path:val("HOSTSTATS_DISK_PATH","/").into()}
    }
}
