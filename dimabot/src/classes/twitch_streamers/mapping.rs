use super::{DirectoryError, StreamerAccount, StreamerMetadata, check_id};
use crate::utils::plan_cache_fence::{PLAN_CACHE_VERSION_FIELD, plan_cache_version};
use mongodb::bson::{Bson, Document};

/// Source host uses UTC. This is Date#toDateString's English spelling, including
/// pre-epoch dates and expanded years; no locale/environment lookup occurs.
pub fn format_plan_date(millis: Option<i64>) -> String {
    let Some(millis) = millis else {
        return String::new();
    };
    if !(-8_640_000_000_000_000..=8_640_000_000_000_000).contains(&millis) {
        return "Invalid Date".into();
    }
    let days = millis.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let year = if year < 0 {
        format!("-{:04}", -year)
    } else {
        format!("{year:04}")
    };
    format!(
        "{} {} {day:02} {year}",
        weekdays[(days + 4).rem_euclid(7) as usize],
        months[(month - 1) as usize]
    )
}
fn string(document: &Document, key: &str) -> Result<String, DirectoryError> {
    match document.get(key) {
        None | Some(Bson::Null) => Ok(String::new()),
        Some(Bson::String(value)) if value.len() <= 16 * 1024 => Ok(value.clone()),
        _ => Err(DirectoryError::InvalidData),
    }
}
fn date(document: &Document, key: &str) -> Result<Option<i64>, DirectoryError> {
    match document.get(key) {
        None | Some(Bson::Null) => Ok(None),
        Some(Bson::DateTime(value)) => Ok(Some(value.timestamp_millis())),
        _ => Err(DirectoryError::InvalidData),
    }
}
fn flag(document: &Document, key: &str) -> Result<String, DirectoryError> {
    match document.get(key) {
        None | Some(Bson::Null) | Some(Bson::Boolean(false)) => Ok("false".into()),
        Some(Bson::Boolean(true)) => Ok("true".into()),
        _ => Err(DirectoryError::InvalidData),
    }
}
/// Maps only projected metadata and selects Twitch AND id from the same account.
/// Missing/null lean values follow the class defaults, not Mongoose insert defaults.
pub fn metadata_from_document(
    user: &Document,
    id: &str,
) -> Result<Option<StreamerMetadata>, DirectoryError> {
    check_id(id)?;
    let accounts = user
        .get_array("accounts")
        .map_err(|_| DirectoryError::InvalidData)?;
    if accounts.len() > 64 {
        return Err(DirectoryError::TooLarge);
    }
    let mut matches = accounts
        .iter()
        .filter_map(Bson::as_document)
        .filter(|a| a.get_str("type").ok() == Some("twitch") && a.get_str("id").ok() == Some(id));
    let Some(account) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Err(DirectoryError::InvalidData);
    }
    let tier = match user.get("plan_tier") {
        None | Some(Bson::Null) => "free".to_owned(),
        _ => string(user, "plan_tier")?,
    };
    if !matches!(tier.as_str(), "free" | "premium" | "pro") {
        return Err(DirectoryError::InvalidData);
    }
    let event_key = string(user, "polar_plan_event_key")?;
    Ok(Some(StreamerMetadata {
        id: id.to_owned(),
        name: string(account, "name")?,
        email: string(account, "email")?,
        plan_tier: tier,
        plan_tier_until: format_plan_date(date(user, "plan_tier_until")?),
        polar_sh_customer_id: string(user, "polar_sh_customer_id")?,
        actived: flag(account, "actived")?,
        chat_enabled: flag(account, "chat_enabled")?,
        plan_version: plan_cache_version(date(user, "polar_plan_event_at")?, Some(&event_key))
            .map_err(|_| DirectoryError::InvalidData)?,
    }))
}
pub(super) fn account_from_fields(
    id: &str,
    fields: Vec<(String, String)>,
) -> Result<StreamerAccount, DirectoryError> {
    let get = |key: &str| {
        fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    if get("id") != id {
        return Err(DirectoryError::InvalidData);
    }
    let tier = get("plan_tier");
    if !matches!(tier.as_str(), "free" | "premium" | "pro") {
        return Err(DirectoryError::InvalidData);
    }
    for flag in [
        "actived",
        "chat_enabled",
        "has_permissions",
        "up_to_date_permissions",
    ] {
        if !matches!(get(flag).as_str(), "true" | "false") {
            return Err(DirectoryError::InvalidData);
        }
    }
    Ok(StreamerAccount {
        metadata: StreamerMetadata {
            id: id.into(),
            name: get("name"),
            email: get("email"),
            plan_tier: tier,
            plan_tier_until: get("plan_tier_until"),
            polar_sh_customer_id: get("polar_sh_customer_id"),
            actived: get("actived"),
            chat_enabled: get("chat_enabled"),
            plan_version: get(PLAN_CACHE_VERSION_FIELD),
        },
        access_token: get("access_token"),
        refresh_token: get("refresh_token"),
        expires_at: get("expires_at"),
        has_permissions: get("has_permissions"),
        up_to_date_permissions: get("up_to_date_permissions"),
    })
}
