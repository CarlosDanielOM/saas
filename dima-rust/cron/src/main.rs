//! `dima-cron`: reads the command line and the environment, builds the runtime, and runs the
//! workers ([`dima_cron::app::run`]) or an operator command ([`dima_cron::recovery`]). Exit
//! statuses: [`dima_cron::host::Exit`] for the workers, [`dima_cron::recovery`] for the
//! commands.
#![forbid(unsafe_code)]

use dima_core::env::EnvSource;
use dima_cron::config::Config;
use dima_cron::recovery::{self, Command, USAGE};
use std::process::ExitCode;
use std::time::Duration;

/// How long the runtime waits for its threads at exit; a thread stuck in a worker's synchronous
/// code is left behind and ends with the process.
const RUNTIME_EXIT: Duration = Duration::from_millis(500);

fn main() -> ExitCode {
    let command = match Command::parse(std::env::args().skip(1)) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("{error}\n{USAGE}");
            return ExitCode::from(1);
        }
    };
    if command == Command::Help {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            eprintln!("working directory: {error}");
            return ExitCode::from(1);
        }
    };
    let (env, _dotenv) = EnvSource::load(&cwd);
    let config = Config::from_env(&env);
    drop(env);
    let config = match config {
        Ok(config) => config,
        Err(error) => {
            eprintln!("dima-cron: {error}");
            return ExitCode::from(1);
        }
    };
    let runtime = match dima_cron::runtime(config.worker_threads) {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("dima-cron: runtime: {error}");
            return ExitCode::from(1);
        }
    };
    let status = match command {
        Command::Recovery(command) => runtime.block_on(recovery::run(config, command)),
        Command::Run | Command::Help => runtime.block_on(dima_cron::app::run(config)).code(),
    };
    runtime.shutdown_timeout(RUNTIME_EXIT);
    ExitCode::from(status)
}
