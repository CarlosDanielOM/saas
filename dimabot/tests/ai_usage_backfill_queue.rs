//! Not executed in the authoring turn.
//! Oracle cases fail when the fixture or TypeScript source is missing or empty.
//! Redis cases are ignored and panic, rather than return, when their owner or URL is absent.
//! Pure cases pass explicit TTLs. They do not read `AI_USAGE_BACKFILL_DEDUPE_SECONDS`.

use serde_json::Value;
use std::path::{Path, PathBuf};

const PINS: &[&str] = &[
    "return typeof value === 'string' ? value.trim() : '';",
    "const DEDUPE_PREFIX = 'cron:ai-usage-backfills:dedupe';",
    "const DEDUPE_SECONDS = Math.max(300, Number(process.env.AI_USAGE_BACKFILL_DEDUPE_SECONDS || 172_800));",
    "attempts: Math.max(0, Number.isInteger(parsed.attempts) ? Number(parsed.attempts) : 0),",
    "const coverageStart = new Date(String(parsed.coverageStart || ''));",
    "AI usage backfill requires channel and customer IDs",
    "coverageStart: coverageStart.toISOString(),",
    "export const AI_USAGE_BACKFILL_QUEUE_KEY = 'cron:ai-usage-backfills:queue';",
    "export const AI_USAGE_BACKFILL_PROCESSING_KEY = 'cron:ai-usage-backfills:processing';",
    "export const AI_USAGE_BACKFILL_DEAD_KEY = 'cron:ai-usage-backfills:dead';",
];

const FIXTURE: &str = r#####"
{
  "pins": [
    "return typeof value === 'string' ? value.trim() : '';",
    "const DEDUPE_PREFIX = 'cron:ai-usage-backfills:dedupe';",
    "const DEDUPE_SECONDS = Math.max(300, Number(process.env.AI_USAGE_BACKFILL_DEDUPE_SECONDS || 172_800));",
    "attempts: Math.max(0, Number.isInteger(parsed.attempts) ? Number(parsed.attempts) : 0),",
    "const coverageStart = new Date(String(parsed.coverageStart || ''));",
    "AI usage backfill requires channel and customer IDs",
    "coverageStart: coverageStart.toISOString(),",
    "export const AI_USAGE_BACKFILL_QUEUE_KEY = 'cron:ai-usage-backfills:queue';",
    "export const AI_USAGE_BACKFILL_PROCESSING_KEY = 'cron:ai-usage-backfills:processing';",
    "export const AI_USAGE_BACKFILL_DEAD_KEY = 'cron:ai-usage-backfills:dead';"
  ],
  "cases": [
    {"op":"safe","id":"trim-colon","value":" a:b ","expect":"a:b"},
    {"op":"safe","id":"number","value":42,"expect":""},
    {"op":"safe","id":"bom","value":"\ufeffid","expect":"id"},
    {"op":"safe","id":"nel","value":"\u0085x","expect":"\u0085x"},
    {"op":"safe","id":"colon-kept","value":"a:b","expect":"a:b"},
    {"op":"tier","id":"tier-free","value":"free","expect":"free"},
    {"op":"tier","id":"tier-premium","value":"premium","expect":"premium"},
    {"op":"tier","id":"tier-pro","value":"pro","expect":"pro"},
    {"op":"tier","id":"tier-other","value":"other","expect":"free"},
    {"op":"tier","id":"tier-capital","value":"Premium","expect":"free"},
    {"op":"tier","id":"tier-number","value":1,"expect":"free"},
    {"op":"coverage","id":"calendar-free","tier":"free","now":"2026-09-19T12:00:00.000Z","expect":"2026-08-21T00:00:00.000Z"},
    {"op":"coverage","id":"calendar-premium","tier":"premium","now":"2026-09-19T12:00:00.000Z","expect":"2026-07-22T00:00:00.000Z"},
    {"op":"coverage","id":"calendar-pro","tier":"pro","now":"2026-09-19T12:00:00.000Z","expect":"2026-06-22T00:00:00.000Z"},
    {"op":"coverage","id":"calendar-other","tier":"other","now":"2026-09-19T12:00:00.000Z","expect":"2026-08-21T00:00:00.000Z"},
    {"op":"coverage","id":"synthetic-free","tier":"free","nowMs":8640001234,"expectMs":6134400000},
    {"op":"coverage","id":"synthetic-premium","tier":"premium","nowMs":8640001234,"expectMs":3542400000},
    {"op":"coverage","id":"synthetic-pro","tier":"pro","nowMs":8640001234,"expectMs":950400000},
    {"op":"coverage","id":"synthetic-other","tier":"other","nowMs":8640001234,"expectMs":6134400000},
    {"op":"dedupe","id":"dedupe-unset","raw":null,"expect":"172800","ex":"172800"},
    {"op":"dedupe","id":"dedupe-empty","raw":"","expect":"172800","ex":"172800"},
    {"op":"dedupe","id":"dedupe-zero","raw":"0","expect":"300","ex":"300"},
    {"op":"dedupe","id":"dedupe-below","raw":"100","expect":"300","ex":"300"},
    {"op":"dedupe","id":"dedupe-space","raw":" ","expect":"300","ex":"300"},
    {"op":"dedupe","id":"dedupe-above","raw":"200000","expect":"200000","ex":"200000"},
    {"op":"dedupe","id":"dedupe-padded","raw":" 400 ","expect":"400","ex":"400"},
    {"op":"dedupe","id":"dedupe-abc","raw":"abc","expect":"NaN","ex":"NaN"},
    {"op":"dedupe","id":"dedupe-infinity","raw":"Infinity","expect":"Infinity","ex":"Infinity"},
    {"op":"dedupe","id":"dedupe-fraction","raw":"172800.9","expect":"172800.9","ex":"172800.9"},
    {"op":"parse","id":"reject-truncated","raw":"{","expect":null},
    {"op":"parse","id":"reject-array","raw":"[]","expect":null},
    {"op":"parse","id":"reject-null","raw":"null","expect":null},
    {"op":"parse","id":"reject-string","raw":"\"x\"","expect":null},
    {"op":"parse","id":"missing-id","raw":"{\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"missing-channel","raw":"{\"id\":\"id\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"missing-customer","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"dedupeKey\":\"d\",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"missing-dedupe","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"whitespace-id","raw":"{\"id\":\"   \",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"whitespace-dedupe","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"   \",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"non-string-id","raw":"{\"id\":1,\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"invalid-coverage","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":\"not-a-date\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"object-coverage","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":{},\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"true-coverage","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":true,\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"zero-coverage","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":0,\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"empty-array-coverage","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":[],\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"numeric-coverage","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":1700000000000,\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"empty-coverage","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":\"\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"whitespace-coverage","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":\"   \",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":null},
    {"op":"parse","id":"invalid-requested","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"not-a-date\"}","expect":null},
    {"op":"parse","id":"accept-z","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"planTier\":\"pro\",\"reason\":\"daily_sweep\",\"attempts\":4,\"coverageStart\":\"2026-01-01T00:00:00Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":{"id":"id","channelID":"c","customerId":"x","planTier":"pro","coverageStart":"2026-01-01T00:00:00.000Z","requestedAt":"2026-01-02T00:00:00.000Z","reason":"daily_sweep","attempts":"4","dedupeKey":"d"}},
    {"op":"parse","id":"date-only","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":\"2026-09-19\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":{"id":"id","channelID":"c","customerId":"x","planTier":"free","coverageStart":"2026-09-19T00:00:00.000Z","requestedAt":"2026-01-02T00:00:00.000Z","reason":"api_request","attempts":"0","dedupeKey":"d"}},
    {"op":"parse","id":"spaced-epoch","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":\" 1970-01-01T00:00:00.000Z \",\"requestedAt\":\" 2026-01-02T00:00:00.000Z \"}","expect":{"id":"id","channelID":"c","customerId":"x","planTier":"free","coverageStart":"1970-01-01T00:00:00.000Z","requestedAt":"2026-01-02T00:00:00.000Z","reason":"api_request","attempts":"0","dedupeKey":"d"}},
    {"op":"parse","id":"attempts-fraction","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"attempts\":1.5,\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":{"id":"id","channelID":"c","customerId":"x","planTier":"free","coverageStart":"2026-01-01T00:00:00.000Z","requestedAt":"2026-01-02T00:00:00.000Z","reason":"api_request","attempts":"0","dedupeKey":"d"}},
    {"op":"parse","id":"attempts-string","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"attempts\":\"4\",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":{"id":"id","channelID":"c","customerId":"x","planTier":"free","coverageStart":"2026-01-01T00:00:00.000Z","requestedAt":"2026-01-02T00:00:00.000Z","reason":"api_request","attempts":"0","dedupeKey":"d"}},
    {"op":"parse","id":"attempts-negative","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"attempts\":-2,\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":{"id":"id","channelID":"c","customerId":"x","planTier":"free","coverageStart":"2026-01-01T00:00:00.000Z","requestedAt":"2026-01-02T00:00:00.000Z","reason":"api_request","attempts":"0","dedupeKey":"d"}},
    {"op":"parse","id":"attempts-missing","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":{"id":"id","channelID":"c","customerId":"x","planTier":"free","coverageStart":"2026-01-01T00:00:00.000Z","requestedAt":"2026-01-02T00:00:00.000Z","reason":"api_request","attempts":"0","dedupeKey":"d"}},
    {"op":"parse","id":"attempts-true","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"attempts\":true,\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":{"id":"id","channelID":"c","customerId":"x","planTier":"free","coverageStart":"2026-01-01T00:00:00.000Z","requestedAt":"2026-01-02T00:00:00.000Z","reason":"api_request","attempts":"0","dedupeKey":"d"}},
    {"op":"parse","id":"attempts-integer","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"attempts\":4,\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":{"id":"id","channelID":"c","customerId":"x","planTier":"free","coverageStart":"2026-01-01T00:00:00.000Z","requestedAt":"2026-01-02T00:00:00.000Z","reason":"api_request","attempts":"4","dedupeKey":"d"}},
    {"op":"parse","id":"reason-case","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"planTier\":\"Premium\",\"reason\":\"Daily_Sweep\",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":{"id":"id","channelID":"c","customerId":"x","planTier":"free","coverageStart":"2026-01-01T00:00:00.000Z","requestedAt":"2026-01-02T00:00:00.000Z","reason":"api_request","attempts":"0","dedupeKey":"d"}},
    {"op":"parse","id":"reason-startup","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"reason\":\"startup_sweep\",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":{"id":"id","channelID":"c","customerId":"x","planTier":"free","coverageStart":"2026-01-01T00:00:00.000Z","requestedAt":"2026-01-02T00:00:00.000Z","reason":"startup_sweep","attempts":"0","dedupeKey":"d"}},
    {"op":"parse","id":"epoch-iso","raw":"{\"id\":\"id\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":\"1970-01-01T00:00:00.000Z\",\"requestedAt\":\"1970-01-01T00:00:00.000Z\"}","expect":{"id":"id","channelID":"c","customerId":"x","planTier":"free","coverageStart":"1970-01-01T00:00:00.000Z","requestedAt":"1970-01-01T00:00:00.000Z","reason":"api_request","attempts":"0","dedupeKey":"d"}},
    {"op":"parse","id":"trim-id","raw":"{\"id\":\" id \",\"channelID\":\" c \",\"customerId\":\" x \",\"dedupeKey\":\" d \",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":{"id":"id","channelID":"c","customerId":"x","planTier":"free","coverageStart":"2026-01-01T00:00:00.000Z","requestedAt":"2026-01-02T00:00:00.000Z","reason":"api_request","attempts":"0","dedupeKey":"d"}},
    {"op":"parse","id":"bom-id","raw":"{\"id\":\"\ufeffid\",\"channelID\":\"c\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":{"id":"id","channelID":"c","customerId":"x","planTier":"free","coverageStart":"2026-01-01T00:00:00.000Z","requestedAt":"2026-01-02T00:00:00.000Z","reason":"api_request","attempts":"0","dedupeKey":"d"}},
    {"op":"parse","id":"nel-channel","raw":"{\"id\":\"id\",\"channelID\":\"\u0085x\",\"customerId\":\"x\",\"dedupeKey\":\"d\",\"coverageStart\":\"2026-01-01T00:00:00.000Z\",\"requestedAt\":\"2026-01-02T00:00:00.000Z\"}","expect":{"id":"id","channelID":"\u0085x","customerId":"x","planTier":"free","coverageStart":"2026-01-01T00:00:00.000Z","requestedAt":"2026-01-02T00:00:00.000Z","reason":"api_request","attempts":"0","dedupeKey":"d"}},
    {"op":"parse-legacy-zero","id":"requested-string-zero"},
    {"op":"prepare-error","id":"empty-channel","channel":"","customer":"c","tier":"pro","now":"invalid","coverage":null,"error":"AI usage backfill requires channel and customer IDs"},
    {"op":"prepare-error","id":"whitespace-channel","channel":"   ","customer":"c","tier":"pro","now":"invalid","coverage":null,"error":"AI usage backfill requires channel and customer IDs"},
    {"op":"prepare-error","id":"non-string-channel","channel":1,"customer":"c","tier":"pro","now":"invalid","coverage":null,"error":"AI usage backfill requires channel and customer IDs"},
    {"op":"prepare-error","id":"whitespace-customer","channel":"a","customer":"  ","tier":"pro","now":"invalid","coverage":null,"error":"AI usage backfill requires channel and customer IDs"},
    {"op":"prepare-error","id":"invalid-now","channel":"a","customer":"c","tier":"pro","now":"invalid","coverage":null,"error":"Invalid time value"},
    {"op":"prepare-error","id":"invalid-coverage","channel":"a","customer":"c","tier":"pro","now":"2026-09-19T12:00:00.000Z","coverage":"invalid","error":"Invalid time value"},
    {"op":"prepare","id":"epoch-coverage","channel":"a","customer":"c","tier":"pro","now":"2026-09-19T12:00:00.000Z","coverage":"epoch","reason":"","jobId":"job-epoch","dedupeSeconds":172800,"expectTier":"pro","expectCoverage":"1970-01-01T00:00:00.000Z","expectRequested":"2026-09-19T12:00:00.000Z","expectReason":"api_request","expectEx":"172800"},
    {"op":"prepare","id":"raw-reason","channel":"a","customer":"c","tier":"Premium","now":"2026-09-19T12:00:00.000Z","coverage":null,"reason":"not_a_reason","jobId":"job-raw","dedupeSeconds":172800,"expectTier":"free","expectCoverage":"2026-08-21T00:00:00.000Z","expectRequested":"2026-09-19T12:00:00.000Z","expectReason":"not_a_reason","expectEx":"172800"},
    {"op":"prepare","id":"dedupe-floor","channel":"a","customer":"c","tier":"free","now":"2026-09-19T12:00:00.000Z","coverage":"epoch","reason":"api_request","jobId":"job-floor","dedupeSeconds":10,"expectTier":"free","expectCoverage":"1970-01-01T00:00:00.000Z","expectReason":"api_request","expectEx":"300"},
    {"op":"prepare","id":"queue-override","channel":"a","customer":"c","tier":"free","now":"2026-09-19T12:00:00.000Z","coverage":"epoch","reason":"startup_sweep","jobId":"job-q","queue":"injected-queue","prefix":"injected-prefix","dedupeSeconds":400,"expectQueue":"injected-queue","expectDedupe":"injected-prefix:v3:a:c","expectReason":"startup_sweep","expectEx":"400"},
    {"op":"prepare","id":"quote-channel","channel":"a\"b","customer":"c","tier":"pro","now":"2026-09-19T12:00:00.000Z","coverage":null,"reason":"daily_sweep","jobId":"job-1","dedupeSeconds":172800,"expectEx":"172800","expectPayload":"{\"id\":\"job-1\",\"channelID\":\"a\\\"b\",\"customerId\":\"c\",\"planTier\":\"pro\",\"coverageStart\":\"2026-06-22T00:00:00.000Z\",\"requestedAt\":\"2026-09-19T12:00:00.000Z\",\"reason\":\"daily_sweep\",\"attempts\":0,\"dedupeKey\":\"cron:ai-usage-backfills:dedupe:v3:a\\\"b:c\"}"},
    {"op":"prepare","id":"newline-channel","channel":"a\nb","customer":"c","tier":"free","now":"2026-09-19T12:00:00.000Z","coverage":null,"reason":null,"jobId":"job-2","dedupeSeconds":null,"env":null,"expectEx":"172800","expectPayload":"{\"id\":\"job-2\",\"channelID\":\"a\\nb\",\"customerId\":\"c\",\"planTier\":\"free\",\"coverageStart\":\"2026-08-21T00:00:00.000Z\",\"requestedAt\":\"2026-09-19T12:00:00.000Z\",\"reason\":\"api_request\",\"attempts\":0,\"dedupeKey\":\"cron:ai-usage-backfills:dedupe:v3:a\\nb:c\"}"},
    {"op":"resolve","id":"production-defaults","queue":null,"prefix":null,"seconds":null,"env":null,"expectQueue":"cron:ai-usage-backfills:queue","expectPrefix":"cron:ai-usage-backfills:dedupe","expectSeconds":"172800"},
    {"op":"resolve","id":"overrides","queue":"q-test","prefix":"p-test","seconds":null,"env":"400","expectQueue":"q-test","expectPrefix":"p-test","expectSeconds":"400"},
    {"op":"resolve","id":"explicit-floor","queue":null,"prefix":null,"seconds":10,"env":"99999","expectQueue":"cron:ai-usage-backfills:queue","expectPrefix":"cron:ai-usage-backfills:dedupe","expectSeconds":"300"},
    {"op":"resolve-nan","id":"explicit-nan"},
    {"op":"collision","id":"colon-pair","prefix":"cron:ai-usage-backfills:dedupe","leftChannel":"a:b","leftCustomer":"c","rightChannel":"a","rightCustomer":"b:c","expect":"cron:ai-usage-backfills:dedupe:v3:a:b:c"},
    {"op":"keys","id":"production-keys","queue":"cron:ai-usage-backfills:queue","processing":"cron:ai-usage-backfills:processing","dead":"cron:ai-usage-backfills:dead","prefix":"cron:ai-usage-backfills:dedupe","version":3},
    {"op":"script","id":"enqueue","source":"\nif redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then\n  redis.call('RPUSH', KEYS[2], ARGV[3])\n  return 1\nend\nreturn 0\n"}
  ]
}
"#####;

fn manifest_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn read_required(relative: &str) -> String {
    let path = manifest_path(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("missing required source {}: {error}", path.display()))
}

fn load_fixture(raw: &str) -> Value {
    assert!(!raw.trim().is_empty(), "oracle fixture is empty");
    let fixture: Value = serde_json::from_str(raw).expect("oracle fixture is not valid JSON");
    let cases = fixture["cases"].as_array().expect("oracle fixture has no cases");
    assert!(!cases.is_empty(), "oracle fixture has no cases");
    assert!(cases.len() >= 40, "oracle fixture is incomplete");
    fixture
}

fn next_item<'a>(source: &'a str, marker: &str) -> &'a str {
    let start = source.find(marker).unwrap_or_else(|| panic!("missing {marker}"));
    let rest = &source[start + marker.len()..];
    match rest.find("\npub ") {
        Some(index) => &rest[..index],
        None => rest,
    }
}

#[test]
fn oracle_fixture_is_nonempty_and_pinned_to_typescript() {
    let fixture = load_fixture(FIXTURE);
    let pins = fixture["pins"].as_array().expect("pins");
    assert_eq!(pins.len(), PINS.len());
    let typescript = read_required("src/utils/ai_usage_backfill_queue.ts");
    let rust = read_required("src/utils/ai_usage_backfill_queue.rs");
    assert!(!typescript.trim().is_empty(), "typescript source is empty");
    assert!(!rust.trim().is_empty(), "rust port is empty");
    for (index, pin) in PINS.iter().enumerate() {
        assert!(!pin.is_empty());
        assert_eq!(pins[index].as_str(), Some(*pin), "{pin}");
        assert!(typescript.contains(pin), "typescript missing {pin}");
        assert!(FIXTURE.contains(pin), "fixture missing {pin}");
    }
    let mut ops = std::collections::BTreeSet::new();
    for case in fixture["cases"].as_array().unwrap() {
        let op = case["op"].as_str().unwrap_or_else(|| panic!("case missing op: {case}"));
        assert!(!op.is_empty());
        ops.insert(op);
        if op == "script" {
            let source = case["source"].as_str().unwrap_or_else(|| panic!("script missing source"));
            assert!(!source.is_empty(), "script source is empty");
            assert!(typescript.contains(source), "typescript missing enqueue script");
            assert!(rust.contains(source), "rust port missing enqueue script");
        }
    }
    for op in [
        "safe",
        "tier",
        "coverage",
        "parse",
        "parse-legacy-zero",
        "dedupe",
        "prepare",
        "prepare-error",
        "resolve",
        "resolve-nan",
        "collision",
        "script",
        "keys",
    ] {
        assert!(ops.contains(op), "fixture missing {op}");
    }
    assert!(!rust.contains(".max(300)"), "old dedupe floor remains");
    for required in [
        "js_compat::trim",
        "AI_USAGE_BACKFILL_REPORT_VERSION",
        "get_redis_client",
        "AI usage backfill requires channel and customer IDs",
        "cron:ai-usage-backfills:queue",
        "cron:ai-usage-backfills:processing",
        "cron:ai-usage-backfills:dead",
        "cron:ai-usage-backfills:dedupe",
    ] {
        assert!(rust.contains(required), "rust port missing {required}");
    }
    assert!(!rust.contains("cron:ai-usage-backfills:queue:dead"));
    assert!(!next_item(&rust, "pub fn prepare_ai_usage_backfill_job").contains("std::env"));
    assert!(!next_item(&rust, "pub fn resolve_backfill_plan").contains("std::env"));
    let enqueue = next_item(&rust, "pub async fn enqueue_ai_usage_backfill");
    assert!(enqueue.contains("input.dedupe_seconds.is_none()"));
    assert_eq!(enqueue.matches("std::env::var").count(), 1);
}

#[test]
fn empty_oracle_fixture_panics() {
    assert!(std::panic::catch_unwind(|| load_fixture("")).is_err());
    assert!(std::panic::catch_unwind(|| load_fixture("   ")).is_err());
    assert!(std::panic::catch_unwind(|| load_fixture(r#"{"cases":[]}"#)).is_err());
}

#[allow(unexpected_cfgs)]
#[cfg(feature = "ai-usage-queues")]
mod parity {
    use super::{FIXTURE, load_fixture};
    use dima_rust::utils::ai_usage_backfill_queue::{
        AI_USAGE_BACKFILL_DEAD_KEY, AI_USAGE_BACKFILL_DEDUPE_PREFIX, AI_USAGE_BACKFILL_PROCESSING_KEY,
        AI_USAGE_BACKFILL_QUEUE_KEY, AI_USAGE_BACKFILL_REPORT_VERSION, ENQUEUE_SCRIPT,
        EnqueueAiUsageBackfillInput, backfill_dedupe_ex, backfill_dedupe_key,
        backfill_dedupe_seconds_from, backfill_job_json, desired_coverage_start,
        get_ai_usage_desired_coverage_start, normalize_tier, parse_ai_usage_backfill_job,
        prepare_ai_usage_backfill_job, resolve_backfill_plan, safe_part,
    };
    use dima_rust::utils::credit_policy::JsDate;
    use dima_rust::utils::js_date::parse_date;
    use dima_rust::utils::json_number::number_string;
    use dima_rust::utils::lossless_json::JsonValue;
    use serde_json::Value;

    fn id_of(case: &Value) -> &str {
        case["id"].as_str().unwrap_or("missing-id")
    }

    fn optional_str<'a>(case: &'a Value, key: &str) -> Option<&'a str> {
        match case.get(key) {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => Some(text.as_str()),
            Some(other) => panic!("{} {key} {other}", id_of(case)),
        }
    }

    fn optional_number(case: &Value, key: &str) -> Option<f64> {
        match case.get(key) {
            None | Some(Value::Null) => None,
            Some(Value::Number(number)) => Some(number.as_f64().unwrap_or_else(|| panic!("{} {key}", id_of(case)))),
            Some(other) => panic!("{} {key} {other}", id_of(case)),
        }
    }

    fn coverage_of(case: &Value) -> Option<JsDate> {
        match case.get("coverage") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) if text == "invalid" => Some(JsDate::invalid()),
            Some(Value::String(text)) if text == "epoch" => Some(JsDate::from_millis(0.0)),
            Some(other) => panic!("{} coverage {other}", id_of(case)),
        }
    }

    fn now_of(case: &Value) -> Option<JsDate> {
        match case.get("now").and_then(Value::as_str) {
            Some("invalid") => Some(JsDate::invalid()),
            Some(text) => Some(JsDate::from_millis(
                parse_date(text).unwrap_or_else(|| panic!("{} now {text}", id_of(case))) as f64,
            )),
            None => None,
        }
    }

    fn prepare_case(case: &Value) -> Result<dima_rust::utils::ai_usage_backfill_queue::BackfillEnqueuePlan, dima_rust::utils::ai_usage_backfill_queue::BackfillQueueError> {
        let input = EnqueueAiUsageBackfillInput {
            channel_id: &case["channel"],
            customer_id: &case["customer"],
            plan_tier: &case["tier"],
            coverage_start: coverage_of(case),
            reason: optional_str(case, "reason"),
            now: now_of(case),
            queue_key: optional_str(case, "queue"),
            dedupe_prefix: optional_str(case, "prefix"),
            dedupe_seconds: optional_number(case, "dedupeSeconds"),
            id: optional_str(case, "jobId"),
        };
        prepare_ai_usage_backfill_job(&input, optional_str(case, "env"))
    }

    fn assert_job(case: &Value, job: &dima_rust::utils::ai_usage_backfill_queue::AiUsageBackfillJob) {
        let expect = &case["expect"];
        assert_eq!(job.id, expect["id"].as_str().unwrap(), "{}", id_of(case));
        assert_eq!(job.channel_id, expect["channelID"].as_str().unwrap(), "{}", id_of(case));
        assert_eq!(job.customer_id, expect["customerId"].as_str().unwrap(), "{}", id_of(case));
        assert_eq!(job.plan_tier, expect["planTier"].as_str().unwrap(), "{}", id_of(case));
        assert_eq!(job.coverage_start, expect["coverageStart"].as_str().unwrap(), "{}", id_of(case));
        assert_eq!(job.requested_at, expect["requestedAt"].as_str().unwrap(), "{}", id_of(case));
        assert_eq!(job.reason, expect["reason"].as_str().unwrap(), "{}", id_of(case));
        assert_eq!(number_string(job.attempts), expect["attempts"].as_str().unwrap(), "{}", id_of(case));
        assert_eq!(job.dedupe_key, expect["dedupeKey"].as_str().unwrap(), "{}", id_of(case));
    }

    fn dispatch(case: &Value) {
        match case["op"].as_str().unwrap_or_else(|| panic!("missing op in {case}")) {
            "safe" => {
                assert_eq!(safe_part(&case["value"]), case["expect"].as_str().unwrap(), "{}", id_of(case));
            }
            "tier" => {
                assert_eq!(normalize_tier(&case["value"]), case["expect"].as_str().unwrap(), "{}", id_of(case));
            }
            "coverage" => {
                let tier = JsonValue::String(case["tier"].as_str().unwrap().into());
                let now_ms = case.get("nowMs").and_then(Value::as_i64).unwrap_or_else(|| {
                    parse_date(case["now"].as_str().unwrap()).unwrap_or_else(|| panic!("{} now", id_of(case)))
                });
                let start = get_ai_usage_desired_coverage_start(&tier, now_ms);
                assert_eq!(start, desired_coverage_start(&tier, now_ms), "{}", id_of(case));
                if let Some(expect_ms) = case.get("expectMs").and_then(Value::as_i64) {
                    assert_eq!(start, expect_ms, "{}", id_of(case));
                }
                if let Some(expect) = case.get("expect").and_then(Value::as_str) {
                    let iso = JsDate::from_millis(start as f64).to_iso_string().expect("coverage iso");
                    assert_eq!(iso, expect, "{}", id_of(case));
                }
            }
            "dedupe" => {
                let raw = match &case["raw"] {
                    Value::Null => None,
                    Value::String(text) => Some(text.as_str()),
                    other => panic!("{} raw {other}", id_of(case)),
                };
                let seconds = backfill_dedupe_seconds_from(raw);
                assert_eq!(number_string(seconds), case["expect"].as_str().unwrap(), "{}", id_of(case));
                assert_eq!(backfill_dedupe_ex(seconds), case["ex"].as_str().unwrap(), "{}", id_of(case));
            }
            "parse" => {
                let parsed = parse_ai_usage_backfill_job(case["raw"].as_str().unwrap());
                if case["expect"].is_null() {
                    assert!(parsed.is_none(), "{}", id_of(case));
                } else {
                    assert_job(case, &parsed.unwrap_or_else(|| panic!("{} rejected", id_of(case))));
                }
            }
            "parse-legacy-zero" => {
                let raw = r#"{"id":"id","channelID":"c","customerId":"x","dedupeKey":"d","coverageStart":"2026-09-19T00:00:00.000Z","requestedAt":"0","planTier":"free","reason":"api_request","attempts":0}"#;
                let job = parse_ai_usage_backfill_job(raw).expect("string 0 is accepted");
                assert_eq!(job.coverage_start, "2026-09-19T00:00:00.000Z");
                assert_ne!(job.requested_at, "1970-01-01T00:00:00.000Z");
                assert_ne!(job.requested_at, job.coverage_start);
                let millis = parse_date("0").expect("legacy year");
                let iso = JsDate::from_millis(millis as f64).to_iso_string().expect("legacy iso");
                assert_eq!(job.requested_at, iso);
            }
            "prepare-error" => {
                let error = prepare_case(case).expect_err(id_of(case));
                assert_eq!(error.to_string(), case["error"].as_str().unwrap(), "{}", id_of(case));
            }
            "prepare" => {
                let plan = prepare_case(case).unwrap_or_else(|error| panic!("{}: {error}", id_of(case)));
                assert_eq!(plan.payload, backfill_job_json(&plan.job), "{}", id_of(case));
                assert!(plan.payload.contains("\"attempts\":0"), "{}", id_of(case));
                assert!(!plan.payload.contains("\"attempts\":0.0"), "{}", id_of(case));
                if let Some(text) = case.get("expectTier").and_then(Value::as_str) {
                    assert_eq!(plan.job.plan_tier, text, "{}", id_of(case));
                }
                if let Some(text) = case.get("expectCoverage").and_then(Value::as_str) {
                    assert_eq!(plan.job.coverage_start, text, "{}", id_of(case));
                }
                if let Some(text) = case.get("expectRequested").and_then(Value::as_str) {
                    assert_eq!(plan.job.requested_at, text, "{}", id_of(case));
                }
                if let Some(text) = case.get("expectReason").and_then(Value::as_str) {
                    assert_eq!(plan.job.reason, text, "{}", id_of(case));
                }
                if let Some(text) = case.get("expectEx").and_then(Value::as_str) {
                    assert_eq!(plan.dedupe_ex, text, "{}", id_of(case));
                }
                if let Some(text) = case.get("expectQueue").and_then(Value::as_str) {
                    assert_eq!(plan.queue_key, text, "{}", id_of(case));
                }
                if let Some(text) = case.get("expectDedupe").and_then(Value::as_str) {
                    assert_eq!(plan.job.dedupe_key, text, "{}", id_of(case));
                }
                if let Some(payload) = case.get("expectPayload").and_then(Value::as_str) {
                    assert_eq!(plan.payload, payload, "{}", id_of(case));
                }
            }
            "resolve" => {
                let plan = resolve_backfill_plan(
                    optional_str(case, "queue"),
                    optional_str(case, "prefix"),
                    optional_number(case, "seconds"),
                    optional_str(case, "env"),
                );
                assert_eq!(plan.queue_key, case["expectQueue"].as_str().unwrap(), "{}", id_of(case));
                assert_eq!(plan.dedupe_prefix, case["expectPrefix"].as_str().unwrap(), "{}", id_of(case));
                assert_eq!(number_string(plan.dedupe_seconds), case["expectSeconds"].as_str().unwrap(), "{}", id_of(case));
            }
            "resolve-nan" => {
                let plan = resolve_backfill_plan(None, None, Some(f64::NAN), Some("99999"));
                assert_eq!(plan.queue_key, AI_USAGE_BACKFILL_QUEUE_KEY);
                assert_eq!(plan.dedupe_prefix, AI_USAGE_BACKFILL_DEDUPE_PREFIX);
                assert!(plan.dedupe_seconds.is_nan());
                assert_eq!(backfill_dedupe_ex(plan.dedupe_seconds), "NaN");
            }
            "collision" => {
                let prefix = case["prefix"].as_str().unwrap();
                let left = backfill_dedupe_key(prefix, case["leftChannel"].as_str().unwrap(), case["leftCustomer"].as_str().unwrap());
                let right = backfill_dedupe_key(prefix, case["rightChannel"].as_str().unwrap(), case["rightCustomer"].as_str().unwrap());
                assert_eq!(left, right, "{}", id_of(case));
                assert_eq!(left, case["expect"].as_str().unwrap(), "{}", id_of(case));
            }
            "keys" => {
                assert_eq!(AI_USAGE_BACKFILL_QUEUE_KEY, case["queue"].as_str().unwrap());
                assert_eq!(AI_USAGE_BACKFILL_PROCESSING_KEY, case["processing"].as_str().unwrap());
                assert_eq!(AI_USAGE_BACKFILL_DEAD_KEY, case["dead"].as_str().unwrap());
                assert_eq!(AI_USAGE_BACKFILL_DEDUPE_PREFIX, case["prefix"].as_str().unwrap());
                assert_eq!(AI_USAGE_BACKFILL_REPORT_VERSION, case["version"].as_i64().unwrap() as i32);
                assert!(!AI_USAGE_BACKFILL_DEAD_KEY.contains(":queue:dead"));
            }
            "script" => {
                assert_eq!(ENQUEUE_SCRIPT, case["source"].as_str().unwrap(), "{}", id_of(case));
            }
            other => panic!("unknown oracle op {other}"),
        }
    }

    #[test]
    fn fixture_cases_match_the_rust_port() {
        let fixture = load_fixture(FIXTURE);
        let cases = fixture["cases"].as_array().expect("cases");
        let mut ran = 0usize;
        for case in cases {
            dispatch(case);
            ran += 1;
        }
        assert_eq!(ran, cases.len());
    }

    #[test]
    fn unknown_fixture_op_panics() {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            dispatch(&serde_json::json!({"op":"not-a-real-op","id":"unknown"}));
        }));
        assert!(result.is_err());
    }

    #[test]
    fn typescript_source_matches_the_pinned_hash() {
        use sha2::{Digest, Sha256};
        let path = super::manifest_path("src/utils/ai_usage_backfill_queue.ts");
        let bytes = std::fs::read(&path).unwrap_or_else(|error| panic!("missing required source {}: {error}", path.display()));
        assert!(!bytes.is_empty(), "{} is empty", path.display());
        let digest = format!("{:x}", Sha256::digest(bytes));
        assert_eq!(digest, "3b8a3f7a55c0b5410de2edcffc892255d25357fa972c84ec0dc8cc5424b89dde");
    }
}

#[allow(unexpected_cfgs)]
#[cfg(feature = "ai-usage-queues")]
mod redis_fixture {
    use dima_rust::utils::ai_usage_backfill_queue::{
        AI_USAGE_BACKFILL_DEDUPE_PREFIX, AI_USAGE_BACKFILL_QUEUE_KEY, EnqueueAiUsageBackfillInput,
        backfill_dedupe_key, backfill_job_json, enqueue_ai_usage_backfill,
    };
    use dima_rust::utils::credit_policy::JsDate;
    use redis::aio::ConnectionManager;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    fn require_owned_redis() -> String {
        let url = std::env::var("DIMA_TEST_REDIS_URL").expect("explicit disposable DIMA_TEST_REDIS_URL required");
        assert!(!url.trim().is_empty(), "DIMA_TEST_REDIS_URL is empty");
        assert_eq!(
            std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
            Ok("dimabot-migration")
        );
        url
    }

    fn namespace(label: &str) -> String {
        static SEQUENCE: AtomicU64 = AtomicU64::new(1);
        format!(
            "dima:test:ai-usage:{label}:{}:{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        )
    }

    struct Owned {
        url: String,
        claim: String,
        token: String,
        keys: Vec<String>,
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            let result = (|| -> redis::RedisResult<()> {
                let client = redis::Client::open(self.url.as_str())?;
                let mut connection = client.get_connection_with_timeout(Duration::from_secs(2))?;
                connection.set_read_timeout(Some(Duration::from_secs(2)))?;
                connection.set_write_timeout(Some(Duration::from_secs(2)))?;
                let owner: Option<String> = redis::cmd("GET").arg(&self.claim).query(&mut connection)?;
                if owner.as_deref() != Some(self.token.as_str()) {
                    return Ok(());
                }
                for key in &self.keys {
                    let _: i64 = redis::cmd("DEL").arg(key).query(&mut connection)?;
                }
                let _: i64 = redis::cmd("DEL").arg(&self.claim).query(&mut connection)?;
                Ok(())
            })();
            if let Err(error) = result {
                eprintln!("ai usage backfill cleanup failed: {error}");
            }
        }
    }

    #[tokio::test]
    #[ignore = "requires an explicitly provided isolated Redis fixture"]
    async fn dedupe_set_nx_pushes_once_on_the_injected_queue() {
        let url = require_owned_redis();
        let mut cache: ConnectionManager = redis::Client::open(url.as_str())
            .expect("redis url")
            .get_connection_manager()
            .await
            .expect("redis connection");
        let ns = namespace("backfill-enqueue");
        let token = ns.clone();
        let claim = format!("{ns}:owner");
        let acquired: Option<String> = redis::cmd("SET")
            .arg(&claim)
            .arg(&token)
            .arg("NX")
            .arg("EX")
            .arg(600)
            .query_async(&mut cache)
            .await
            .expect("owner claim");
        assert_eq!(acquired.as_deref(), Some("OK"));
        let queue = format!("{ns}:queue");
        let prefix = format!("{ns}:dedupe");
        let dedupe = backfill_dedupe_key(&prefix, "channel", "customer");
        assert!(queue.starts_with("dima:test:ai-usage:"), "{queue}");
        assert!(dedupe.starts_with("dima:test:ai-usage:"), "{dedupe}");
        assert_ne!(queue, AI_USAGE_BACKFILL_QUEUE_KEY);
        assert_ne!(prefix, AI_USAGE_BACKFILL_DEDUPE_PREFIX);
        let _owned = Owned {
            url,
            claim,
            token,
            keys: vec![queue.clone(), dedupe.clone()],
        };
        let channel = serde_json::json!("channel");
        let customer = serde_json::json!("customer");
        let tier = serde_json::json!("pro");
        let now = JsDate::from_millis(1_700_000_000_000.0);
        let coverage = JsDate::from_millis(0.0);
        let first = enqueue_ai_usage_backfill(
            &mut cache,
            EnqueueAiUsageBackfillInput {
                channel_id: &channel,
                customer_id: &customer,
                plan_tier: &tier,
                coverage_start: Some(coverage),
                reason: Some("daily_sweep"),
                now: Some(now),
                queue_key: Some(&queue),
                dedupe_prefix: Some(&prefix),
                dedupe_seconds: Some(10.0),
                id: Some("job-a"),
            },
        )
        .await
        .expect("first enqueue");
        assert!(first.enqueued);
        assert_eq!(first.job.id, "job-a");
        assert_eq!(first.job.dedupe_key, dedupe);
        assert!(first.job.dedupe_key.starts_with(&prefix));
        assert_eq!(first.job.coverage_start, "1970-01-01T00:00:00.000Z");
        assert_eq!(first.job.requested_at, "2023-11-14T22:13:20.000Z");
        assert_eq!(first.job.reason, "daily_sweep");
        let stored: String = redis::cmd("GET").arg(&dedupe).query_async(&mut cache).await.expect("dedupe read");
        assert_eq!(stored, "job-a");
        let ttl: i64 = redis::cmd("TTL").arg(&dedupe).query_async(&mut cache).await.expect("dedupe ttl");
        assert!(ttl > 0 && ttl <= 300, "{ttl}");
        let len: i64 = redis::cmd("LLEN").arg(&queue).query_async(&mut cache).await.expect("queue len");
        assert_eq!(len, 1);
        let item: String = redis::cmd("LINDEX").arg(&queue).arg(0).query_async(&mut cache).await.expect("queue item");
        assert_eq!(item, backfill_job_json(&first.job));
        let second = enqueue_ai_usage_backfill(
            &mut cache,
            EnqueueAiUsageBackfillInput {
                channel_id: &channel,
                customer_id: &customer,
                plan_tier: &tier,
                coverage_start: Some(coverage),
                reason: Some("daily_sweep"),
                now: Some(now),
                queue_key: Some(&queue),
                dedupe_prefix: Some(&prefix),
                dedupe_seconds: Some(10.0),
                id: Some("job-b"),
            },
        )
        .await
        .expect("second enqueue");
        assert!(!second.enqueued);
        assert_eq!(second.job.id, "job-b");
        assert_eq!(second.job.dedupe_key, dedupe);
        let len_after: i64 = redis::cmd("LLEN").arg(&queue).query_async(&mut cache).await.expect("queue len after");
        assert_eq!(len_after, 1);
        let still: String = redis::cmd("LINDEX").arg(&queue).arg(0).query_async(&mut cache).await.expect("queue item after");
        assert_eq!(still, item);
    }
}
