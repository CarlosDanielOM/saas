//! Category matching and app-authenticated game searches.
use super::{Envelope, has_error, payload};
use crate::{Auth, HelixRequest, Twitch};
use dima_http::Path;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

const ROMAN: [&str; 40] = [
    "", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv",
    "xv", "xvi", "xvii", "xviii", "xix", "xx", "xxi", "xxii", "xxiii", "xxiv", "xxv", "xxvi",
    "xxvii", "xxviii", "xxix", "xxx", "xxxi", "xxxii", "xxxiii", "xxxiv", "xxxv", "xxxvi",
    "xxxvii", "xxxviii", "xxxix",
];
fn numeric(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}
/// NFKD, mark removal, letter/digit boundaries, and bounded Roman installments.
pub fn category_tokens(title: &str) -> Result<Vec<String>, regex::Error> {
    let marks = Regex::new(r"\p{M}")?;
    let decomposed = title.nfkd().collect::<String>();
    let lower = dima_text::to_lower(&marks.replace_all(&decomposed, ""));
    let lower = lower.replace(['\'', '’'], "");
    let lower = Regex::new(r"(\p{L})([0-9])")?.replace_all(&lower, "$1 $2");
    let lower = Regex::new(r"([0-9])(\p{L})")?.replace_all(&lower, "$1 $2");
    let clean = Regex::new(r"[^\p{L}\p{N}]+")?.replace_all(&lower, " ");
    Ok(clean
        .split_whitespace()
        .enumerate()
        .map(|(i, t)| {
            if i > 0
                && let Some(n) = ROMAN.iter().position(|r| *r == t)
                && n > 0
            {
                return n.to_string();
            }
            if numeric(t) {
                dima_text::number_to_string(dima_text::parse_number(t))
            } else {
                t.into()
            }
        })
        .collect())
}
/// At most four distinct discovery queries, retaining the original query first.
pub fn category_queries(query: &str) -> Result<Vec<String>, regex::Error> {
    let tokens = category_tokens(query)?;
    let original = Regex::new(r"[\s\u{feff}]+")?
        .replace_all(&dima_text::to_lower(dima_text::trim(query)), " ")
        .into_owned();
    let arabic = tokens.join(" ");
    let roman = tokens
        .iter()
        .map(|t| {
            t.parse::<usize>()
                .ok()
                .and_then(|i| ROMAN.get(i))
                .filter(|r| !r.is_empty())
                .map_or(t.as_str(), |r| *r)
        })
        .collect::<Vec<_>>()
        .join(" ");
    let base = if tokens.iter().any(|t| numeric(t)) {
        tokens
            .iter()
            .filter(|t| !numeric(t))
            .cloned()
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        String::new()
    };
    let mut result = Vec::new();
    for q in [original, arabic, roman, base] {
        if !q.is_empty() && !result.contains(&q) {
            result.push(q);
        }
    }
    Ok(result)
}
/// Match priority: exact title, normalized title, token equality, prefix subset.
pub fn category_match_score(query: &str, title: &str) -> Result<u8, regex::Error> {
    let requested = category_tokens(query)?;
    let mut candidate = category_tokens(title)?;
    if requested.is_empty() {
        return Ok(0);
    }
    let numbers = requested.iter().filter(|t| numeric(t)).collect::<Vec<_>>();
    if !numbers.is_empty() && numbers != candidate.iter().filter(|t| numeric(t)).collect::<Vec<_>>()
    {
        return Ok(0);
    }
    if dima_text::to_lower(dima_text::trim(query)) == dima_text::to_lower(dima_text::trim(title)) {
        return Ok(4);
    }
    if requested == candidate {
        return Ok(3);
    }
    for token in requested {
        let Some(i) = candidate
            .iter()
            .position(|w| *w == token || (!numeric(&token) && w.starts_with(&token)))
        else {
            return Ok(0);
        };
        candidate.remove(i);
    }
    Ok(if candidate.is_empty() { 2 } else { 1 })
}
/// A Twitch game/category.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Category {
    /// Twitch id.
    pub id: String,
    /// Title.
    pub name: String,
    /// Box art template URL.
    pub box_art_url: String,
    /// Optional IGDB id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub igdb_id: Option<String>,
}
async fn game(twitch: &Twitch, key: &str, value: &str) -> Envelope<Category> {
    let Some(body) = payload(
        twitch,
        HelixRequest::get(Path::fixed("/games"), Auth::App).query(key, value),
    )
    .await
    else {
        return Envelope::failure("Internal server error");
    };
    if has_error(&body) {
        let mut r = Envelope::payload_error(&body);
        r.kind = body["error"].as_str().map(str::to_owned);
        return r;
    }
    let Some(data) = body.get("data").and_then(Value::as_array) else {
        return Envelope::failure("Internal server error");
    };
    let Some(first) = data.first() else {
        return Envelope::failure("Game not found")
            .status(404)
            .kind("Game not found");
    };
    match serde_json::from_value(first.clone()) {
        Ok(data) => Envelope::success("Game found", Some(data)),
        Err(_) => Envelope::failure("Internal server error"),
    }
}
/// `searchGameById`.
pub async fn search_game_by_id(twitch: &Twitch, id: &str) -> Envelope<Category> {
    game(twitch, "id", id).await
}
/// `searchGameByName`.
pub async fn search_game_by_name(twitch: &Twitch, name: &str) -> Envelope<Category> {
    game(twitch, "name", name).await
}
/// `searchGameByIgdbId`: the reference uses `external_id`.
pub async fn search_game_by_igdb_id(twitch: &Twitch, id: &str) -> Envelope<Category> {
    game(twitch, "external_id", id).await
}
/// `searchCategories`, including bounded alternate numeral searches and ambiguity detection.
pub async fn search_categories(twitch: &Twitch, query: &str) -> Envelope<Vec<Category>> {
    match categories(twitch, query).await {
        Some(result) => result,
        None => Envelope::failure("Internal server error"),
    }
}
async fn categories(twitch: &Twitch, query: &str) -> Option<Envelope<Vec<Category>>> {
    let queries = category_queries(query).ok()?;
    if queries.is_empty() {
        return Some(Envelope::failure("Please provide a game name").status(400));
    }
    let mut categories: Vec<Category> = Vec::new();
    for q in queries {
        let response = twitch
            .helix(
                HelixRequest::get(Path::fixed("/search/categories"), Auth::App)
                    .query("query", q)
                    .query("first", "100"),
            )
            .await
            .ok()?;
        let status = response.status().as_u16();
        let body = response.into_response().json::<Value>().await.ok()?;
        if !(200..300).contains(&status) || has_error(&body) {
            let mut result = Envelope::payload_error(&body);
            result.message = Some(
                body["message"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Error searching for game")
                    .into(),
            );
            result.status = Some(result.status.filter(|n| *n != 0).unwrap_or(status));
            result.kind = Some(
                body["error"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("error")
                    .into(),
            );
            return Some(result);
        }
        let data: Vec<Category> = serde_json::from_value(body.get("data")?.clone()).ok()?;
        for category in data {
            if let Some(old) = categories.iter_mut().find(|c| c.id == category.id) {
                *old = category;
            } else {
                categories.push(category);
            }
        }
        if categories
            .iter()
            .any(|c| category_match_score(query, &c.name).is_ok_and(|n| n >= 3))
        {
            break;
        }
    }
    let collator = dima_text::Collator::new().ok()?;
    let mut ranked = Vec::new();
    for c in categories {
        let score = category_match_score(query, &c.name).ok()?;
        if score > 0 {
            ranked.push((score, c));
        }
    }
    ranked.sort_by(|(a, ca), (b, cb)| b.cmp(a).then_with(|| collator.compare(&ca.name, &cb.name)));
    if let Some((score, _)) = ranked.first() {
        let best = ranked
            .iter()
            .filter(|(s, _)| s == score)
            .collect::<Vec<_>>();
        if best.len() > 1 {
            return Some(
                Envelope::failure(&format!(
                    "Multiple games match. Please use a more specific title: {}",
                    best.iter()
                        .take(5)
                        .map(|(_, c)| c.name.as_str())
                        .collect::<Vec<_>>()
                        .join("; ")
                ))
                .status(409)
                .kind("ambiguous_game"),
            );
        }
    }
    Some(Envelope::success(
        if ranked.is_empty() {
            "No matching game found"
        } else {
            "Categories found"
        },
        Some(ranked.into_iter().map(|(_, c)| c).collect()),
    ))
}
