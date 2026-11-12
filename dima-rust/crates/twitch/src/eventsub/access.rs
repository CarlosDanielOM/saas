//! `getEventsubAccess` (`utils/eventsub_access.ts`): who may see or change a channel's chat
//! events. The channel's owner and the global owners (`hasGlobalChannelOwnerAccess` of
//! `middleware/admin.middleware.ts`, which belongs to the API's admin package and comes in as
//! [`GlobalOwnerAccess`]) are owners; an active channel admin whose permissions hold `*` or the
//! permission asked for is an admin.

use crate::Twitch;
use crate::error::TwitchError;
use bson::doc;
use futures_util::future::BoxFuture;

/// The permission asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum EventsubPermission {
    /// `eventsubs:view` (the default).
    #[default]
    View,
    /// `eventsubs:manage`.
    Manage,
}

impl EventsubPermission {
    /// The stored permission name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::View => "eventsubs:view",
            Self::Manage => "eventsubs:manage",
        }
    }
}

/// The answer (`'owner' | 'admin' | 'none'`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventsubAccess {
    /// The channel itself, or a global owner.
    Owner,
    /// An active channel admin with the permission.
    Admin,
    /// Neither.
    None,
}

impl EventsubAccess {
    /// `owner`, `admin` or `none`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::None => "none",
        }
    }
}

/// `hasGlobalChannelOwnerAccess(requesterID, channelID)`, supplied by the admin package.
pub trait GlobalOwnerAccess: Send + Sync {
    /// Whether `requester` acts as the owner of `channel` everywhere (the creator, or a super
    /// admin outside the creator's channel). An error is a failed read.
    fn has_global_channel_owner_access<'a>(
        &'a self,
        requester: &'a str,
        channel: &'a str,
    ) -> BoxFuture<'a, Result<bool, TwitchError>>;
}

/// `getEventsubAccess(requesterID, channelID, permission)`.
pub async fn eventsub_access(
    twitch: &Twitch,
    global: &dyn GlobalOwnerAccess,
    requester: &str,
    channel: &str,
    permission: EventsubPermission,
) -> Result<EventsubAccess, TwitchError> {
    if requester == channel {
        return Ok(EventsubAccess::Owner);
    }
    if global
        .has_global_channel_owner_access(requester, channel)
        .await?
    {
        return Ok(EventsubAccess::Owner);
    }
    let filter = doc! {
        "channelID": channel,
        "adminID": requester,
        "actived": true,
        "permissions": { "$in": ["*", permission.as_str()] },
    };
    let inner = &twitch.inner;
    let admins = inner.mongo.documents(dima_model::admins::COLLECTION);
    let admin = inner
        .mongo_op("admins.findOne", admins.find_one(filter))
        .await?;
    Ok(if admin.is_some() {
        EventsubAccess::Admin
    } else {
        EventsubAccess::None
    })
}
