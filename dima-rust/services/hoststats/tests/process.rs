#![forbid(unsafe_code)]
#![allow(clippy::unwrap_used)]
use std::{
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
fn first_sample_healthcheck_and_both_shutdown_signals() -> anyhow::Result<()> {
    for signal in [
        nix::sys::signal::Signal::SIGINT,
        nix::sys::signal::Signal::SIGTERM,
    ] {
        let reservation = std::net::TcpListener::bind("127.0.0.1:0")?;
        let port = reservation.local_addr()?.port();
        drop(reservation);
        let mut child = ChildGuard(
            Command::new(env!("CARGO_BIN_EXE_dima-hoststats"))
                .env("PORT", port.to_string())
                .env("DOCKER_SOCKET", "/tmp/hoststats-process-test-absent.sock")
                .env("HOSTSTATS_PROC", "/no-hoststats-proc")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?,
        );
        let start = Instant::now();
        loop {
            if std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).is_ok() {
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(5));
            assert!(child.0.try_wait()?.is_none());
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            Command::new(env!("CARGO_BIN_EXE_dima-hoststats"))
                .arg("--healthcheck")
                .env("PORT", port.to_string())
                .status()?
                .success()
        );
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(child.0.id() as i32), signal)?;
        let start = Instant::now();
        loop {
            if let Some(status) = child.0.try_wait()? {
                assert!(status.success());
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    Ok(())
}
