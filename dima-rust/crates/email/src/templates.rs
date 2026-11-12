//! Generated HTML skeletons, with disjoint conditional patches and escaped scalar slots.
use crate::Error;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::OnceLock;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Welcome {
    pub streamer_name: String,
    pub discount_code: Option<String>,
    pub dashboard_link: String,
    pub language: Option<String>,
    pub theme: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationReminder {
    pub streamer_name: String,
    pub activation_link: String,
    pub language: Option<String>,
    pub theme: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub average_viewers: f64,
    pub peak_viewers: f64,
    pub follows: f64,
    pub subs: f64,
    pub bits: f64,
    pub donations: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSummary {
    pub streamer_name: String,
    pub stream_date: String,
    pub stream_duration: f64,
    pub headline: String,
    pub recap_snippet: String,
    #[serde(default)]
    pub highlights: Vec<String>,
    pub stats: Stats,
    pub memory_count: f64,
    pub full_summary_link: String,
    pub dashboard_link: String,
    pub language: Option<String>,
    pub theme: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipAnalysisFinished {
    pub streamer_name: String,
    pub approved_count: f64,
    pub dashboard_url: String,
    pub language: Option<String>,
    pub theme: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Email {
    pub subject: String,
    pub html: String,
    pub text: String,
}
#[derive(Deserialize)]
struct Patch {
    start: usize,
    old: String,
    replacement: String,
}
#[derive(Deserialize)]
struct Patches {
    html: Patch,
    text: Patch,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Template {
    kind: String,
    language: String,
    theme: String,
    highlight_count: usize,
    html: String,
    text: String,
    subject: String,
    patches: BTreeMap<String, Patches>,
}
static TEMPLATES: OnceLock<Result<Vec<Template>, serde_json::Error>> = OnceLock::new();
fn escape(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        out.push_str(match c {
            '&' => "&amp;",
            '<' => "&lt;",
            '>' => "&gt;",
            '"' => "&quot;",
            '\'' => "&#x27;",
            _ => {
                out.push(c);
                continue;
            }
        });
    }
    out
}
fn fill(template: &str, slots: &[(String, String)], html: bool) -> String {
    // One pass: inserted user text is never interpreted as another slot.
    let mut out = String::new();
    let mut rest = template;
    while !rest.is_empty() {
        let next = slots
            .iter()
            .filter_map(|(key, value)| rest.find(key).map(|pos| (pos, key, value)))
            .min_by_key(|(pos, _, _)| *pos);
        if let Some((pos, key, value)) = next {
            out.push_str(rest.get(..pos).unwrap_or_default());
            out.push_str(&if html { escape(value) } else { value.clone() });
            rest = rest.get(pos + key.len()..).unwrap_or_default();
        } else {
            out.push_str(rest);
            break;
        }
    }
    out
}
fn render(
    kind: &str,
    language: Option<&str>,
    theme: Option<&str>,
    count: usize,
    patches: &[&str],
    slots: Vec<(String, String)>,
) -> Result<Email, Error> {
    let templates = TEMPLATES
        .get_or_init(|| serde_json::from_str(include_str!("generated.json")))
        .as_ref()
        .map_err(|_| Error::Template)?;
    let lang = if language == Some("es") { "es" } else { "en" };
    let theme = if theme == Some("light") {
        "light"
    } else {
        "dark"
    };
    let t = templates
        .iter()
        .find(|t| {
            t.kind == kind && t.language == lang && t.theme == theme && t.highlight_count == count
        })
        .ok_or(Error::Template)?;
    let (mut html, mut text) = (t.html.clone(), t.text.clone());
    let selected = patches
        .iter()
        .map(|name| t.patches.get(*name).ok_or(Error::Template))
        .collect::<Result<Vec<_>, _>>()?;
    apply(&mut html, selected.iter().map(|p| &p.html).collect())?;
    apply(&mut text, selected.iter().map(|p| &p.text).collect())?;
    Ok(Email {
        subject: fill(&t.subject, &slots, false),
        html: render_html(&html, &slots),
        text: plain_text(&fill(
            &text,
            &slots
                .iter()
                .map(|(k, v)| (k.clone(), collapse(v)))
                .collect::<Vec<_>>(),
            false,
        )),
    })
}
fn slot(key: &str, value: &str) -> (String, String) {
    (key.into(), value.into())
}
pub fn welcome(p: &Welcome) -> Result<Email, Error> {
    render(
        "welcome",
        p.language.as_deref(),
        p.theme.as_deref(),
        0,
        if p.discount_code.as_ref().is_none_or(String::is_empty) {
            &["discount"]
        } else {
            &[]
        },
        vec![
            slot("DIMA_NAME_TOKEN", &p.streamer_name),
            slot(
                "DIMA_DISCOUNT_TOKEN",
                p.discount_code.as_deref().unwrap_or_default(),
            ),
            slot("https://dima.dashboard.invalid/TOKEN", &p.dashboard_link),
        ],
    )
}
pub fn activation_reminder(p: &ActivationReminder) -> Result<Email, Error> {
    render(
        "activation-reminder",
        p.language.as_deref(),
        p.theme.as_deref(),
        0,
        &[],
        vec![
            slot("DIMA_NAME_TOKEN", &p.streamer_name),
            slot("https://dima.activation.invalid/TOKEN", &p.activation_link),
        ],
    )
}
pub fn clip_analysis_finished(p: &ClipAnalysisFinished) -> Result<Email, Error> {
    let count = if p.approved_count.is_nan() {
        0.0
    } else {
        p.approved_count.max(0.0)
    };
    render(
        "vod-clip-analysis-finished",
        p.language.as_deref(),
        p.theme.as_deref(),
        0,
        if count == 1.0 { &["count1"] } else { &[] },
        vec![
            slot("DIMA_NAME_TOKEN", &p.streamer_name),
            slot("678", &dima_text::number_to_string(count)),
            slot("https://dima.clips.invalid/TOKEN", &p.dashboard_url),
        ],
    )
}
fn number(n: f64) -> String {
    let n = if n.is_nan() { 0.0 } else { n };
    if n >= 1e6 {
        format!("{}M", fixed(n / 1e6))
    } else if n >= 1e4 {
        format!(
            "{}k",
            dima_text::number_to_string(dima_text::math_round(n / 1000.0))
        )
    } else if n >= 1000.0 {
        format!("{}k", fixed(n / 1000.0))
    } else {
        dima_text::number_to_string(dima_text::math_round(n))
    }
}
fn fixed(n: f64) -> String {
    let s = dima_text::to_fixed(n, 1);
    s.strip_suffix(".0").unwrap_or(&s).into()
}
fn duration(n: f64) -> String {
    let n = dima_text::math_round(if n.is_nan() { 0.0 } else { n }).max(0.0);
    let h = (n / 60.0).floor();
    let m = dima_text::number_to_string(n % 60.0);
    if h > 0.0 {
        format!("{}h {m:0>2}m", dima_text::number_to_string(h))
    } else {
        format!("{m}m")
    }
}
pub fn stream_summary(p: &StreamSummary) -> Result<Email, Error> {
    let highlights: Vec<_> = p
        .highlights
        .iter()
        .filter(|s| !s.is_empty())
        .take(5)
        .collect();
    let mut patches = vec![];
    if p.memory_count <= 0.0 || p.memory_count.is_nan() {
        patches.push("memory0");
    } else if p.memory_count == 1.0 {
        patches.push("memory1");
    }
    if p.recap_snippet.is_empty() {
        patches.push("recap");
    }
    for (name, n) in [
        ("follows", p.stats.follows),
        ("subs", p.stats.subs),
        ("bits", p.stats.bits),
    ] {
        if n == 0.0 || n.is_nan() {
            patches.push(name);
        }
    }
    let mut slots = vec![
        slot("DIMA_DATE_TOKEN", &p.stream_date),
        slot("DIMA_HEADLINE_TOKEN", &p.headline),
        slot("DIMA_RECAP_TOKEN", &p.recap_snippet),
        slot("789", &dima_text::number_to_string(p.memory_count)),
        slot("2h 17m", &duration(p.stream_duration)),
        slot("231", &number(p.stats.average_viewers)),
        slot("432", &number(p.stats.peak_viewers)),
        slot("123", &number(p.stats.follows)),
        slot("234", &number(p.stats.subs)),
        slot("345", &number(p.stats.bits)),
        slot("https://dima.dashboard.invalid/TOKEN", &p.dashboard_link),
        slot("https://dima.summary.invalid/TOKEN", &p.full_summary_link),
    ];
    for (i, h) in highlights.iter().enumerate() {
        slots.push(slot(&format!("DIMA_HIGHLIGHT_{i}_TOKEN"), h));
    }
    render(
        "stream-summary",
        p.language.as_deref(),
        p.theme.as_deref(),
        highlights.len(),
        &patches,
        slots,
    )
}
fn render_html(template: &str, slots: &[(String, String)]) -> String {
    let marker = "data-skip-in-text=\"true\">";
    if let Some((before, after)) = template.split_once(marker)
        && let Some((preview, tail)) = after.split_once("<div>")
        && let Some((_, end)) = tail.split_once("</div>")
    {
        let raw = fill(preview, slots, false);
        let text = dima_text::truncate_utf16_budget(&raw, 150);
        let pad = 150_usize.saturating_sub(dima_text::utf16_len(text));
        let filler = if pad == 0 {
            String::new()
        } else {
            format!(
                "<div>{}</div>",
                "\u{a0}\u{200c}\u{200b}\u{200d}\u{200e}\u{200f}\u{feff}".repeat(pad)
            )
        };
        return format!(
            "{}{}{}{}{}",
            fill(before, slots, true),
            marker,
            escape(text),
            filler,
            fill(end, slots, true)
        );
    }
    fill(template, slots, true)
}

fn collapse(s: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for c in s.chars() {
        if matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{c}') {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out
}

fn apply(s: &mut String, mut patches: Vec<&Patch>) -> Result<(), Error> {
    patches.sort_by_key(|p| std::cmp::Reverse(p.start));
    for p in patches {
        let end = p.start + p.old.len();
        if s.get(p.start..end) != Some(p.old.as_str()) {
            return Err(Error::Template);
        }
        s.replace_range(p.start..end, &p.replacement);
    }
    Ok(())
}

fn plain_text(s: &str) -> String {
    s.split('\n')
        .map(collapse)
        .map(|s| s.trim_matches(' ').to_owned())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}
