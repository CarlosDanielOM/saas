//! Concrete MongoDB account ownership resolution. Provider IDs are paired in
//! one account element; a conflicting explicit Polar owner never falls back.

use crate::domain_event_contracts::{DomainEventSubject, DomainEventSubjectKind};
use mongodb::{
    Database,
    bson::{Bson, Document, doc, oid::ObjectId},
};

pub async fn resolve_domain_event_owner(
    database: &Database,
    subject: &DomainEventSubject,
    external_owner_id: Option<&str>,
    legacy_twitch_channel_id: Option<&str>,
) -> mongodb::error::Result<Option<String>> {
    let users = database.collection::<Document>("users");
    if subject.kind == DomainEventSubjectKind::StreamingAccount {
        return Ok(users
            .find_one(doc! {"accounts":{"$elemMatch":{"type":&subject.provider,"id":&subject.id}}})
            .projection(doc! {"_id":1})
            .await?
            .and_then(|user| user.get_object_id("_id").ok().map(|id| id.to_hex())));
    }
    if subject.kind != DomainEventSubjectKind::Customer || subject.provider != "polar" {
        return Ok(None);
    };
    if let Some(user) = users
        .find_one(doc! {"polar_sh_customer_id":&subject.id})
        .projection(doc! {"_id":1})
        .await?
    {
        return Ok(user.get_object_id("_id").ok().map(|id| id.to_hex()));
    }
    if let Some(external) =
        external_owner_id.filter(|id| id.len() == 24 && id.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        let Ok(id) = ObjectId::parse_str(external) else {
            return Ok(None);
        };
        let user = users
            .find_one(doc! {"_id":id})
            .projection(doc! {"_id":1,"polar_sh_customer_id":1})
            .await?;
        return Ok(user.and_then(|user| {
            let allowed = match user.get("polar_sh_customer_id") {
                None | Some(Bson::Null) | Some(Bson::Undefined) => true,
                Some(Bson::String(link)) => link.is_empty() || link == &subject.id,
                Some(Bson::Boolean(false)) => true,
                Some(Bson::Int32(0)) | Some(Bson::Int64(0)) => true,
                Some(Bson::Double(n)) if *n == 0.0 || n.is_nan() => true,
                _ => false,
            };
            allowed
                .then(|| user.get_object_id("_id").ok().map(|id| id.to_hex()))
                .flatten()
        }));
    }
    if let Some(channel) = legacy_twitch_channel_id.filter(|id| !id.is_empty()) {
        return Ok(users.find_one(doc!{"accounts":{"$elemMatch":{"type":"twitch","id":channel}},
            "$or":[{"polar_sh_customer_id":Bson::Null},{"polar_sh_customer_id":""},{"polar_sh_customer_id":&subject.id}]})
            .projection(doc!{"_id":1}).await?.and_then(|user|user.get_object_id("_id").ok().map(|id|id.to_hex())));
    }
    Ok(None)
}
