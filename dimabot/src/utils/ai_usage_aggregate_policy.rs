//! Shared Mongo expressions only. Extracted verbatim from the receipt worker;
//! no application coercion, clock, I/O, scheduling, or worker dependencies.
use mongodb::bson::{Document, doc};

pub(crate) fn usage() -> Document {
    doc! {"$and":[{"$gt":["$credits",0]},{"$ne":["$entryKind","adjustment"]}]}
}
pub(crate) fn group_fields(id: Document, dashboard: bool) -> Document {
    let mut group = doc! {"_id":id,
    "spent":{"$sum":{"$cond":[usage(),"$credits",0]}},
    "granted":{"$sum":{"$cond":[{"$lt":["$credits",0]},{"$multiply":["$credits",-1]},0]}},
    "debited":{"$sum":{"$cond":[{"$and":[{"$gt":["$credits",0]},{"$eq":["$entryKind","adjustment"]}]},"$credits",0]}},
    "count":{"$sum":{"$cond":[usage(),1,0]}}};
    if dashboard {
        group.insert("adjustments",doc!{"$sum":{"$cond":[{"$or":[{"$eq":["$entryKind","adjustment"]},{"$lt":["$credits",0]}]},1,0]}});
    } else {
        group.insert("expiresAt", doc! {"$max":"$expiresAt"});
    }
    group
}
