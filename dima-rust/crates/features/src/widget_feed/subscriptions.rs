//! Twitch moderation readiness and small lease inputs for later custom-widget sessions.
//! No sockets or event handlers are implemented here. A session renews its 60s lease,
//! removes it on disconnect, and routes the bounded `uses` list itself.
use super::model::{FeedError, bound, bound_bytes, id, string};
use dima_core::Clock;
use dima_http::guard::BoxFuture;
use dima_store::dragonfly::{Dragonfly, Script};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::Mutex as AsyncMutex;
/// On-demand only; never part of automatic startup subscription repair.
pub const MODERATION_TYPES: [&str; 3] = [
    "channel.chat.message_delete",
    "channel.chat.clear_user_messages",
    "channel.chat.clear",
];
const CALLBACK: &str = "https://subscriptions.domdimabot.com/eventsub";
/// The later Twitch/account layer supplies these operations. `inspect` must mark pagination
/// complete; adoption owns the merged Eventsub model, so this crate never writes that schema.
pub trait ModerationSource: Send + Sync {
    /// Account name, or no Twitch account.
    fn account<'a>(&'a self, channel: &'a str) -> BoxFuture<'a, Result<Option<String>, String>>;
    /// `{data: Remote[], complete: true}`; incomplete results must never cause destructive repair.
    fn inspect<'a>(&'a self, channel: &'a str) -> BoxFuture<'a, Result<Value, String>>;
    /// Unsubscribe a stale remote belonging to this bot and callback only.
    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), String>>;
    /// Subscribe version `1`, condition `{broadcaster_user_id: channel, user_id: bot}`,
    /// no extra config and `ignoreExisting: true`. Use the fixed webhook callback above.
    /// Return the new remote, or an HTTP status (409 causes reinspection/adoption).
    fn subscribe<'a>(
        &'a self,
        channel: &'a str,
        kind: &'a str,
        bot: &'a str,
    ) -> BoxFuture<'a, Result<Value, u16>>;
    /// Persist/adopt the exact remote through the eventsub model in the Twitch owner.
    fn adopt<'a>(
        &'a self,
        remote: &'a Value,
        channel: &'a str,
        name: &'a str,
    ) -> BoxFuture<'a, Result<(), String>>;
}
/// Coalesces overlapping activations per channel. At most 500 in-flight channels.
pub struct ModerationEnsurer {
    source: Arc<dyn ModerationSource>,
    bot: String,
    active: Mutex<BTreeMap<String, Weak<AsyncMutex<Option<Value>>>>>,
}
impl ModerationEnsurer {
    /// The bot reader ID is explicit startup configuration.
    pub fn new(source: Arc<dyn ModerationSource>, bot: String) -> Self {
        Self {
            source,
            bot,
            active: Mutex::new(BTreeMap::new()),
        }
    }
    fn matches(&self, r: &Value, c: &str, k: &str) -> bool {
        r["type"] == k
            && r["version"] == "1"
            && r["condition"]["broadcaster_user_id"] == c
            && r["condition"]["user_id"] == self.bot
            && r["transport"]["method"] == "webhook"
            && r["transport"]["callback"] == CALLBACK
    }
    fn find<'a>(&self, remote: &'a [Value], c: &str, k: &str) -> Option<&'a Value> {
        remote
            .iter()
            .find(|r| self.matches(r, c, k) && r["status"] == "enabled")
            .or_else(|| {
                remote.iter().find(|r| {
                    self.matches(r, c, k) && r["status"] == "webhook_callback_verification_pending"
                })
            })
    }
    async fn within<T, E>(&self, f: BoxFuture<'_, Result<T, E>>) -> Result<T, ()> {
        tokio::time::timeout(Duration::from_secs(10), f)
            .await
            .map_err(|_| ())?
            .map_err(|_| ())
    }
    async fn inspect(&self, c: &str) -> Result<Vec<Value>, &'static str> {
        let response = self
            .within(self.source.inspect(c))
            .await
            .map_err(|_| "Unable to check Twitch chat events. Try again.")?;
        if response["complete"] != true
            || dima_events::value::Value::from_json(&response["error"]).truthy()
            || bound_bytes(&response, 1024 * 1024).is_err()
        {
            return Err("Unable to check Twitch chat events. Try again.");
        }
        response["data"]
            .as_array()
            .cloned()
            .ok_or("Unable to check Twitch chat events. Try again.")
    }
    async fn run(&self, c: &str) -> Value {
        let mut remote = Vec::new();
        let result:Result<(),&str>=async{
   if c.is_empty(){return Err("Twitch channel is required.");}id(c).map_err(|_|"Twitch channel is required.")?;
   let name=self.within(self.source.account(c)).await.map_err(|_|"Twitch account unavailable.")?.ok_or("Twitch account unavailable.")?;if name.chars().count()>128{return Err("Twitch account unavailable.");}
   remote=self.inspect(c).await?;
   for kind in MODERATION_TYPES{
    if self.find(&remote,c,kind).is_none(){
     for stale in remote.iter().filter(|r|self.matches(r,c,kind)){let key=string(&stale["id"]);if key.len()>128{return Err("Unable to repair Twitch chat events. Try again.");}self.within(self.source.remove(key)).await.map_err(|_|"Unable to repair Twitch chat events. Try again.")?;}
     match tokio::time::timeout(Duration::from_secs(10),self.source.subscribe(c,kind,&self.bot)).await{
      Ok(Ok(r))=>{bound(&r).map_err(|_|"Unable to activate Twitch chat events. Try again.")?;if remote.len()>=1024{return Err("Unable to activate Twitch chat events. Try again.");}remote.push(r);},
      Ok(Err(409))=>remote=self.inspect(c).await?,
      Ok(Err(403))=>return Err("Twitch chat authorization is missing. Reauthorize the bot with user:read:chat and user:bot, and grant channel:bot or make the bot a moderator."),
      _=>return Err("Unable to activate Twitch chat events. Try again."),
     }
    }
    let existing=self.find(&remote,c,kind).ok_or("Unable to activate Twitch chat events. Try again.")?;
    self.within(self.source.adopt(existing,c,&name)).await.map_err(|_|"Unable to activate Twitch chat events. Try again.")?;
   }Ok(())
  }.await;
        let events:Vec<Value>=MODERATION_TYPES.into_iter().map(|k|json!({"type":k,"status":self.find(&remote,c,k).map(|r|r["status"].clone()).unwrap_or(json!("missing"))})).collect();
        match result {
            Ok(()) => json!({"ok":true,"events":events}),
            Err(e) => json!({"ok":false,"events":events,"message":e}),
        }
    }
    /// Readiness, including the reference's actionable error messages. Never panics or starts
    /// background repair. Simultaneous calls share one activation; later calls inspect again.
    pub async fn ensure(&self, c: &str) -> Value {
        if c.len() > 128 {
            return json!({"ok":false,"events":MODERATION_TYPES.map(|kind|json!({"type":kind,"status":"missing"})),"message":"Twitch channel is required."});
        }
        let gate = {
            let Ok(mut map) = self.active.lock() else {
                return json!({"ok":false,"events":[],"message":"Widget subscription unavailable"});
            };
            if let Some(g) = map.get(c).and_then(Weak::upgrade) {
                g
            } else {
                map.retain(|_, v| v.strong_count() > 0);
                if map.len() >= 500 {
                    return json!({"ok":false,"events":[],"message":"Widget subscription capacity exceeded"});
                }
                let g = Arc::new(AsyncMutex::new(None));
                map.insert(c.into(), Arc::downgrade(&g));
                g
            }
        };
        let result = async {
            let mut last = gate.lock().await;
            if let Some(v) = last.as_ref() {
                return v.clone();
            }
            let value = self.run(c).await;
            *last = Some(value.clone());
            value
        };
        tokio::time::timeout(Duration::from_secs(120), result)
            .await
            .unwrap_or(
                json!({"ok":false,"events":[],"message":"Widget subscription deadline exceeded"}),
            )
    }
}
static LEASES: Script = Script::new("WIDGET_FEED_LEASES", include_str!("lua/leases.lua"));
/// One widget in one realtime session. Published widget routing remains in P4-RT-OVERLAY-LIVE.
#[derive(Clone, Debug)]
pub struct WidgetSubscription {
    /// Published widget ID, ASCII identity at most 128 bytes.
    pub widget: String,
    /// Session identity, ASCII at most 128 bytes.
    pub session: String,
    /// At most 16 declared uses; each from the fixed list accepted by `register`.
    pub uses: Vec<String>,
}
/// Cross-process bounded leases. At most 128/channel and 16 sessions/widget; TTL 60s.
/// The registry reuses `widget-feed:demand:{channel}`, which the publisher checks atomically.
pub struct FeedSubscriptions {
    store: Dragonfly,
    clock: Arc<dyn Clock>,
    prefix: String,
    deadline: Duration,
}
impl FeedSubscriptions {
    /// Prefix must match every publisher and realtime session on this deployment.
    pub fn new(
        store: Dragonfly,
        clock: Arc<dyn Clock>,
        prefix: String,
        deadline: Duration,
    ) -> Self {
        Self {
            store,
            clock,
            prefix,
            deadline,
        }
    }
    fn keys(&self, c: &str) -> [String; 3] {
        [
            format!("{}widget-feed:leases:{c}", self.prefix),
            format!("{}widget-feed:uses:{c}", self.prefix),
            format!("{}widget-feed:demand:{c}", self.prefix),
        ]
    }
    async fn change(
        &self,
        c: &str,
        member: &str,
        uses: &str,
        op: &str,
    ) -> Result<Vec<(String, String)>, FeedError> {
        id(c)?;
        let keys = self.keys(c);
        let args = [
            self.clock.now_ms().to_string(),
            member.into(),
            uses.into(),
            op.into(),
        ];
        let result = tokio::time::timeout(
            self.deadline,
            LEASES.run::<Vec<String>, _, _>(&self.store, &keys, &args),
        )
        .await
        .map_err(|_| FeedError("widget_subscription_deadline"))?
        .map_err(|_| FeedError("widget_subscription_store_failed"))?;
        if result.first().is_none_or(|s| s != "1") {
            return Err(FeedError("widget_subscription_limit"));
        }
        Ok(result
            .into_iter()
            .skip(1)
            .collect::<Vec<_>>()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|a| (a[0].clone(), a[1].clone()))
            .collect())
    }
    /// Register/renew atomically. `uses` are declarations, not callbacks or unbounded user data.
    pub async fn register(&self, c: &str, s: &WidgetSubscription) -> Result<(), FeedError> {
        id(&s.widget)?;
        id(&s.session)?;
        if s.uses.len() > 16
            || s.uses.iter().any(|u| {
                ![
                    "chat",
                    "signals",
                    "session",
                    "alerts",
                    "pets",
                    "duels",
                    "rewards",
                    "tts",
                    "triggers",
                    "goals",
                    "polls",
                    "predictions",
                    "roulette",
                    "dimafx",
                ]
                .contains(&u.as_str())
            })
        {
            return Err(FeedError("invalid_widget_subscription_uses"));
        }
        self.change(
            c,
            &format!("{}:{}", s.widget, s.session),
            &s.uses.join(","),
            "add",
        )
        .await
        .map(|_| ())
    }
    /// Remove only the named widget/session entry; other sessions keep their demand.
    pub async fn remove(&self, c: &str, widget: &str, session: &str) -> Result<(), FeedError> {
        id(widget)?;
        id(session)?;
        self.change(c, &format!("{widget}:{session}"), "", "remove")
            .await
            .map(|_| ())
    }
    /// Sweep expiry and return live member/use pairs (bounded at 128). No global scans.
    pub async fn active(&self, c: &str) -> Result<Vec<(String, String)>, FeedError> {
        self.change(c, "", "", "list").await
    }
}
