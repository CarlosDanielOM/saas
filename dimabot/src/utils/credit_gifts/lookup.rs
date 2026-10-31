pub fn normalize_recipient(input: &str) -> String {
    input.trim().strip_prefix('@').unwrap_or(input.trim()).to_ascii_lowercase()
}

pub fn valid_recipient(input: &str, search: bool) -> bool {
    let min = if search { 3 } else { 1 };
    (min..=25).contains(&input.len())
        && input.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}


use mongodb::{bson::{doc, Document, oid::ObjectId}, Collection};
use futures_util::TryStreamExt;
use super::CreditGiftRequestError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GiftRecipient {
    pub id: String,
    pub login: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

fn error(message: &str, status_code: u16) -> CreditGiftRequestError {
    CreditGiftRequestError { message: message.into(), status_code }
}

fn recipient(user: &Document) -> Result<GiftRecipient, CreditGiftRequestError> {
    let account = user.get_array("accounts").ok().into_iter().flatten().filter_map(|v| v.as_document()).find(|a|
        a.get_str("type").ok() == Some("twitch") && a.get_str("id").is_ok_and(|s| !s.is_empty()) && a.get_str("name").is_ok_and(|s| !s.is_empty()))
        .ok_or_else(|| error("This account has no Twitch channel", 404))?;
    let name = account.get_str("name").unwrap_or_default();
    let id = user.get_object_id("_id").map_err(|_| error("Recipient account has invalid id", 500))?;
    Ok(GiftRecipient { id: id.to_hex(), login: name.to_lowercase(), display_name: name.to_owned(), avatar_url: None })
}

pub async fn find_gift_recipient(users: &Collection<Document>, login: &str) -> Result<GiftRecipient, CreditGiftRequestError> {
    let name = normalize_recipient(login);
    if !valid_recipient(&name, false) { return Err(error("Enter an exact Twitch channel name", 400)); }
    let user = users.find_one(doc! { "accounts": {"$elemMatch": {"type": "twitch", "name": {"$regex": format!("^{name}$"), "$options": "i"}}}}).await
        .map_err(|e| error(&e.to_string(), 500))?.ok_or_else(|| error("This channel does not have a bot account", 404))?;
    recipient(&user)
}

pub async fn search_gift_recipients(users: &Collection<Document>, query: &str, buyer: ObjectId) -> Result<Vec<GiftRecipient>, CreditGiftRequestError> {
    let name = normalize_recipient(query);
    if !valid_recipient(&name, true) { return Err(error("Enter at least 3 characters of a Twitch channel name", 400)); }
    let cursor = users.find(doc! {"_id": {"$ne": buyer}, "accounts": {"$elemMatch": {"type": "twitch", "id": {"$nin": [null, ""]}, "name": {"$regex": name, "$options": "i"}}}})
        .sort(doc! {"accounts.name": 1}).limit(15).await.map_err(|e| error(&e.to_string(), 500))?;
    let users: Vec<Document> = cursor.try_collect().await.map_err(|e| error(&e.to_string(), 500))?;
    users.iter().map(recipient).collect()
}
