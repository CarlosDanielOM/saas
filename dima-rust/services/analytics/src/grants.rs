use crate::{Result, service::State};
use serde_json::{Value as V, json};
pub async fn save(s: &State, actor: &str, id: &str, body: &V, now: i64) -> Result<(u16, V)> {
    let valid_list = |key: &str| {
        body[key].as_array().is_some_and(|a| {
            a.len() <= 100
                && a.iter().all(|v| {
                    v.as_str().is_some_and(|s| {
                        !s.is_empty()
                            && s.len() <= 80
                            && s.bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
                    })
                })
        })
    };
    let expires = body["expiresAt"].as_str();
    let valid_date = body.get("expiresAt") == Some(&V::Null)
        || expires
            .and_then(dima_text::parse_date)
            .is_some_and(|at| at > now);
    if id.is_empty()
        || id.len() > 30
        || !id.bytes().all(|b| b.is_ascii_digit())
        || id == s.config.owner_id
        || !matches!(body["role"].as_str(), Some("viewer" | "investigator"))
        || !valid_list("channels")
        || !valid_list("services")
        || !valid_date
    {
        return Ok((400, json!({"message":"Invalid access grant"})));
    }
    let strings = |key: &str| {
        body[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    };
    let role = body["role"].as_str().unwrap_or("");
    s.store.execute("WITH saved AS (INSERT INTO analytics_grants(user_id,role,channels,services,expires_at,granted_by) VALUES($1,$2,$3,$4,$5::text::timestamptz,$6) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,channels=excluded.channels,services=excluded.services,expires_at=excluded.expires_at,granted_by=excluded.granted_by,updated_at=now() RETURNING user_id) INSERT INTO analytics_audit(actor,action,subject) SELECT $6,'grant',user_id FROM saved",&[&id,&role,&strings("channels"),&strings("services"),&expires,&actor]).await?;
    Ok((200, json!({"saved":true})))
}
