//! `dima-cron recovery ...`: the operator commands of the rollback procedure
//! (`ledger/packages.md`, phase 7; `dima_twitch` `recovery` and `operator` modules), run with
//! every Rust service stopped, with the same environment as the cron.
//!
//! ```text
//! dima-cron recovery reconcile
//! dima-cron recovery list
//! dima-cron recovery settle <streamer-id> <parked|conflict|quarantine> <apply|discard> <operation-id> <operator>
//! ```
//!
//! - `reconcile` runs [`dima_twitch::Twitch::reconcile_recovery`] once, prints its counts, then
//!   lists the records left. Status 0 when nothing blocks a rollback (`failed`, `left` and
//!   `unmatched` are 0 and no record is unreadable), 2 when something is left (run it again, then
//!   settle what stays), 1 when it could not run.
//! - `list` prints every record ([`dima_twitch::Twitch::recovery_records`]). Status 0, or 1.
//! - `settle` applies or discards one named record
//!   ([`dima_twitch::Twitch::settle_recovery_record`]; the operation id and the operator's name
//!   are logged with the decision). Status 0 when it was applied or discarded, 2 when there was
//!   no such record or the account is gone, 1 on an error (`busy`: a refresh of that streamer
//!   holds its lease; try again).
//!
//! Output is one JSON object per line on standard output: streamer ids, record keys, states and
//! generations, never a token. Log lines go to the Dragonfly debug log and the telemetry
//! export only, so standard output holds the answer alone.

use crate::app;
use crate::config::Config;
use dima_core::runtime::Shutdown;
use dima_telemetry::{ConsoleTarget, Telemetry};
use dima_twitch::{RecordState, RecoveryKey, RecoveryRecord, SettleAction, SettleOutcome, Twitch};
use serde_json::{Value, json};
use std::time::Duration;

/// One operator command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecoveryCommand {
    /// Run the reconciliation, then list what is left.
    Reconcile,
    /// List the records.
    List,
    /// Settle one record.
    Settle {
        /// The streamer's Twitch id.
        streamer: String,
        /// Which record.
        key: RecoveryKey,
        /// Apply or discard.
        action: SettleAction,
        /// The operation id (1 to 200 characters), logged.
        operation_id: String,
        /// The operator's name (1 to 200 characters), logged.
        operator: String,
    },
}

/// The usage text.
pub const USAGE: &str = "usage:\n  dima-cron                 run every worker until SIGTERM\n  dima-cron recovery reconcile\n  dima-cron recovery list\n  dima-cron recovery settle <streamer-id> <parked|conflict|quarantine> <apply|discard> <operation-id> <operator>";

/// What the command line asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    /// Run the workers.
    Run,
    /// An operator command.
    Recovery(RecoveryCommand),
    /// Print the usage.
    Help,
}

impl Command {
    /// Parses the arguments after the program name.
    pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Result<Self, String> {
        let args: Vec<String> = args.into_iter().collect();
        let words: Vec<&str> = args.iter().map(String::as_str).collect();
        match words.as_slice() {
            [] => Ok(Self::Run),
            ["--help" | "-h" | "help"] => Ok(Self::Help),
            ["recovery", "reconcile"] => Ok(Self::Recovery(RecoveryCommand::Reconcile)),
            ["recovery", "list"] => Ok(Self::Recovery(RecoveryCommand::List)),
            [
                "recovery",
                "settle",
                streamer,
                key,
                action,
                operation_id,
                operator,
            ] => {
                let key = match *key {
                    "parked" => RecoveryKey::Parked,
                    "conflict" => RecoveryKey::Conflict,
                    "quarantine" => RecoveryKey::Quarantine,
                    other => return Err(format!("unknown record {other:?}")),
                };
                let action = match *action {
                    "apply" => SettleAction::Apply,
                    "discard" => SettleAction::Discard,
                    other => return Err(format!("unknown decision {other:?}")),
                };
                if streamer.is_empty() || !streamer.chars().all(|c| c.is_ascii_digit()) {
                    return Err("the streamer id is Twitch's numeric id".to_owned());
                }
                Ok(Self::Recovery(RecoveryCommand::Settle {
                    streamer: (*streamer).to_owned(),
                    key,
                    action,
                    operation_id: (*operation_id).to_owned(),
                    operator: (*operator).to_owned(),
                }))
            }
            _ => Err("unknown command".to_owned()),
        }
    }
}

fn key_name(key: RecoveryKey) -> &'static str {
    match key {
        RecoveryKey::Parked => "parked",
        RecoveryKey::Conflict => "conflict",
        RecoveryKey::Quarantine => "quarantine",
        _ => "other",
    }
}

fn state_name(state: RecordState) -> &'static str {
    match state {
        RecordState::Unmatched => "unmatched",
        RecordState::Pending => "pending",
        RecordState::Unreadable => "unreadable",
        RecordState::Quarantined => "quarantined",
        _ => "other",
    }
}

/// One record as printed: never a token.
pub fn record_json(record: &RecoveryRecord) -> Value {
    json!({
        "record": {
            "streamerId": record.streamer_id,
            "key": key_name(record.key),
            "origin": record.origin.map(key_name),
            "state": state_name(record.state),
            "generation": record.generation,
            "storedGeneration": record.stored_generation,
            "quarantinedAt": record.quarantined_at,
        }
    })
}

fn print(line: &Value) {
    println!("{line}");
}

/// Runs `command`; returns the exit status.
pub async fn run(mut config: Config, command: RecoveryCommand) -> u8 {
    // The answer alone on standard output; logs still reach the debug log and the export.
    config.telemetry.console = ConsoleTarget::Off;
    let telemetry = match Telemetry::new(config.telemetry.clone()) {
        Ok(telemetry) => telemetry,
        Err(error) => {
            eprintln!("telemetry: {error}");
            return 1;
        }
    };
    let running = telemetry.start();
    let shutdown = Shutdown::new();
    let status = match tokio::time::timeout(
        app::CONNECT_DEADLINE,
        app::connect(&config, &telemetry),
    )
    .await
    {
        Ok(Ok(stores)) => match app::twitch(&config, &stores, &telemetry, &shutdown) {
            Ok(twitch) => {
                let status = execute(&twitch, command).await;
                shutdown.trigger();
                twitch.shutdown().await;
                status
            }
            Err(error) => {
                eprintln!("{error}");
                1
            }
        },
        Ok(Err(error)) => {
            eprintln!("{error}");
            1
        }
        Err(_) => {
            eprintln!("the stores did not answer within 35 s");
            1
        }
    };
    running.shutdown(Duration::from_secs(5)).await;
    status
}

async fn list(twitch: &Twitch) -> Result<Vec<RecoveryRecord>, u8> {
    match twitch.recovery_records().await {
        Ok(records) => {
            for record in &records {
                print(&record_json(record));
            }
            print(&json!({ "records": records.len() }));
            Ok(records)
        }
        Err(error) => {
            eprintln!("listing the records failed: {error}");
            Err(1)
        }
    }
}

async fn execute(twitch: &Twitch, command: RecoveryCommand) -> u8 {
    match command {
        RecoveryCommand::Reconcile => {
            let report = match twitch.reconcile_recovery().await {
                Ok(report) => report,
                Err(error) => {
                    eprintln!("the reconciliation did not finish: {error}; run it again");
                    return 1;
                }
            };
            print(&json!({
                "reconciled": {
                    "applied": report.applied,
                    "alreadyNewer": report.already_newer,
                    "accountGone": report.account_gone,
                    "failed": report.failed,
                    "left": report.left,
                    "unmatched": report.unmatched,
                    "quarantined": report.quarantined,
                }
            }));
            let records = match list(twitch).await {
                Ok(records) => records,
                Err(status) => return status,
            };
            let unreadable = records
                .iter()
                .any(|record| record.state == RecordState::Unreadable);
            if report.failed == 0 && report.left == 0 && report.unmatched == 0 && !unreadable {
                0
            } else {
                2
            }
        }
        RecoveryCommand::List => match list(twitch).await {
            Ok(_) => 0,
            Err(status) => status,
        },
        RecoveryCommand::Settle {
            streamer,
            key,
            action,
            operation_id,
            operator,
        } => {
            match twitch
                .settle_recovery_record(&streamer, key, action, &operation_id, &operator)
                .await
            {
                Ok(outcome) => {
                    let (name, generation, status) = match outcome {
                        SettleOutcome::Applied { generation } => ("applied", Some(generation), 0),
                        SettleOutcome::Discarded => ("discarded", None, 0),
                        SettleOutcome::NotFound => ("not_found", None, 2),
                        SettleOutcome::AccountGone => ("account_gone", None, 2),
                        _ => ("other", None, 2),
                    };
                    print(&json!({
                        "settled": {
                            "streamerId": streamer,
                            "key": key_name(key),
                            "outcome": name,
                            "generationWritten": generation,
                            "operationId": operation_id,
                        }
                    }));
                    status
                }
                Err(error) => {
                    eprintln!("settling the record failed: {error}");
                    1
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(words: &[&str]) -> Result<Command, String> {
        Command::parse(words.iter().map(|word| (*word).to_owned()))
    }

    #[test]
    fn the_command_line() {
        assert_eq!(parse(&[]), Ok(Command::Run));
        assert_eq!(parse(&["--help"]), Ok(Command::Help));
        assert_eq!(
            parse(&["recovery", "reconcile"]),
            Ok(Command::Recovery(RecoveryCommand::Reconcile))
        );
        assert_eq!(
            parse(&["recovery", "list"]),
            Ok(Command::Recovery(RecoveryCommand::List))
        );
        assert_eq!(
            parse(&[
                "recovery", "settle", "123", "conflict", "discard", "op-1", "dom"
            ]),
            Ok(Command::Recovery(RecoveryCommand::Settle {
                streamer: "123".to_owned(),
                key: RecoveryKey::Conflict,
                action: SettleAction::Discard,
                operation_id: "op-1".to_owned(),
                operator: "dom".to_owned(),
            }))
        );
        for bad in [
            &["recovery"][..],
            &["recovery", "settle", "123", "parked", "apply", "op"],
            &["recovery", "settle", "abc", "parked", "apply", "op", "dom"],
            &["recovery", "settle", "123", "record", "apply", "op", "dom"],
            &["recovery", "settle", "123", "parked", "keep", "op", "dom"],
            &["run"],
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
    }
}
