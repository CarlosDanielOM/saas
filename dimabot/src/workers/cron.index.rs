//! Side-effect-free CLI entrypoint until explicit environment/runtime startup.

use std::process::ExitCode;

use dima_rust::supervisor::{
    Args, Config, HELP, load_env_files, print_dry_run, process,
    registry::{Environment, selected_workers},
};

fn shutdown_runtime_after_run(runtime: tokio::runtime::Runtime) {
    // process::run has reaped every owned child and drained/cancelled and
    // joined its async samplers/exporter before returning (startup errors
    // precede children). A cancelled DNS lookup can still occupy a blocking
    // thread: do not add an unbounded Runtime::drop wait after the 27s budget.
    // This consumes the runtime with zero wait. Residual blocking work may
    // continue only until main returns and the OS exits this process.
    runtime.shutdown_background();
}

fn main() -> ExitCode {
    let arguments = match std::env::args_os()
        .skip(1)
        .map(|argument| argument.into_string().map_err(|_| ()))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(arguments) => arguments,
        Err(_) => {
            eprintln!("cron_index: Invalid argument encoding");
            return ExitCode::FAILURE;
        }
    };
    let args = match Args::parse(arguments.into_iter()) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("cron_index: {message}");
            return ExitCode::FAILURE;
        }
    };
    if args.help {
        println!("{HELP}");
        return ExitCode::SUCCESS;
    }
    if let Err(message) = load_env_files(&args.env_files) {
        eprintln!("cron_index: {message}");
        return ExitCode::FAILURE;
    }
    let workers = match selected_workers(args.workers.as_deref()) {
        Ok(workers) => workers,
        Err(message) => {
            eprintln!("cron_index: {message}");
            return ExitCode::FAILURE;
        }
    };
    let env: Environment = std::env::vars_os().collect();
    let config = Config::from_args(&args, &env);
    if args.dry_run {
        print_dry_run(&workers, config, &env);
        return ExitCode::SUCCESS;
    }
    // A panicked child task must not leave an apparently healthy supervisor.
    // Do not expose panic payloads, environment values, or private child data.
    // Children retain our process group so the production bridge can clean it.
    std::panic::set_hook(Box::new(|_| {
        eprintln!("cron_index:{{\"event\":\"fatal\",\"code\":\"SUPERVISOR_PANIC\"}}");
        std::process::exit(1);
    }));
    // Runtime diagnostics own a duplicated raw stdout fd, never Rust's stdout
    // lock/buffer. Normal return and process::exit can therefore clean up empty
    // global stdout without waiting for a writer blocked on an undrained pipe.
    if let Err(message) = process::start_diagnostics() {
        eprintln!("cron_index: {message}");
        return ExitCode::FAILURE;
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            eprintln!("cron_index: Cannot create supervisor runtime");
            return ExitCode::FAILURE;
        }
    };
    let result = runtime.block_on(process::run(config, workers, env));
    shutdown_runtime_after_run(runtime);
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(message) => {
            eprintln!("cron_index: {message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::shutdown_runtime_after_run;
    use std::{
        process::Stdio,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
            mpsc,
        },
        time::{Duration, Instant},
    };

    #[tokio::test]
    async fn process_exit_does_not_wait_for_a_started_blocking_pool_job() {
        // The guard exists only in this test executable; no production CLI
        // switch, database connection, DNS query, or extra executable is used.
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::stalled_blocking_job_process_fixture",
                "--nocapture",
                "--test-threads=1",
            ])
            .env_clear()
            .env("CRON_INDEX_BLOCKING_POOL_TEST_PROCESS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let status = match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(status) => status.unwrap(),
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                panic!("Runtime teardown waited for the stalled blocking fixture job");
            }
        };
        assert!(
            status.success(),
            "Stalled blocking-pool exit fixture failed"
        );
    }

    #[test]
    fn stalled_blocking_job_process_fixture() {
        if std::env::var_os("CRON_INDEX_BLOCKING_POOL_TEST_PROCESS").as_deref()
            != Some(std::ffi::OsStr::new("1"))
        {
            return;
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let (entered, started) = mpsc::sync_channel(1);
        let (keep_blocked, blocked) = mpsc::sync_channel::<()>(0);
        let completed = Arc::new(AtomicBool::new(false));
        let task_completed = completed.clone();
        let blocking = runtime.spawn_blocking(move || {
            entered.send(()).unwrap();
            let _ = blocked.recv();
            task_completed.store(true, Ordering::Release);
        });
        // Ensure the blocking closure really started, rather than only being
        // queued and cancellable. Its release sender remains alive until exit.
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        let timed_out = runtime
            .block_on(async { tokio::time::timeout(Duration::from_millis(10), blocking).await });
        assert!(timed_out.is_err());
        assert!(!completed.load(Ordering::Acquire));
        let before_shutdown = Instant::now();
        shutdown_runtime_after_run(runtime);
        assert!(before_shutdown.elapsed() < Duration::from_secs(1));
        assert!(!completed.load(Ordering::Acquire));
        std::hint::black_box(&keep_blocked);
        // Exercise the same immediate process exit as main. The blocking job
        // is still running; no destructor releases it before exit cleanup.
        std::process::exit(0);
    }
}
