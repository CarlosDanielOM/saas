use crate::{
    functions::{
        CacheCommand, CacheValue, FunctionFailure, TwitchFunctions, prefix_utf16, query, truthy,
    },
    utils::twitch::{TWITCH_BOT_ACCOUNT_ID, TwitchAuth},
};
use mongodb::{
    IndexModel,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
    options::IndexOptions,
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;

pub const MODERATION_ACTION_LOG_COLLECTION: &str = "moderation_action_logs";
pub const MODERATION_DECISION_COLLECTION: &str = "moderation_decisions";
pub const NOTICE_COOLDOWN_SECONDS: u64 = 60;

/// The action executor only reads this projection of an authored rule. Other
/// settings belong to matching/decision construction and are not reinterpreted.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModerationRule {
    pub id: String,
    #[serde(rename = "type")]
    pub rule_type: String,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModerationOffenseStep {
    pub action: String,
    pub timeout_seconds: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModerationExecutionInput {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(rename = "userID")]
    pub user_id: String,
    pub username: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    pub message_text: String,
    pub rule: ModerationRule,
    pub step: ModerationOffenseStep,
    pub offense_number: f64,
    #[serde(rename = "decisionID", default)]
    pub decision_id: Option<String>,
}

impl TwitchFunctions {
    /// Explicit source-model index setup; call only during authorized
    /// application initialization or against task-owned fixture databases.
    pub async fn install_moderation_action_indexes(&self) -> Result<(), FunctionFailure> {
        let db = self.database.as_ref().ok_or(FunctionFailure::Internal)?;
        let indexes = [
            IndexModel::builder().keys(doc! {"channelID":1}).build(),
            IndexModel::builder()
                .keys(doc! {"createdAt":1})
                .options(
                    IndexOptions::builder()
                        .expire_after(Duration::from_secs(30 * 24 * 60 * 60))
                        .build(),
                )
                .build(),
        ];
        db.collection::<Document>(MODERATION_ACTION_LOG_COLLECTION)
            .create_indexes(indexes)
            .await
            .map_err(|_| FunctionFailure::Internal)?;
        Ok(())
    }
    async fn write_action_log(
        &self,
        input: &ModerationExecutionInput,
        success: bool,
        error_message: Option<&str>,
    ) {
        let result=async {
            let db=self.database.as_ref().ok_or(FunctionFailure::Internal)?;
            if let Some(id)=input.decision_id.as_deref().filter(|id|!id.is_empty()){
                let consequence=doc!{"status":"executed","action":&input.step.action,"offenseNumber":input.offense_number,"success":success,"errorMessage":error_message.map_or(Bson::Null,|message|Bson::String(message.into()))};
                db.collection::<Document>(MODERATION_DECISION_COLLECTION).update_one(doc!{"_id":id},doc!{"$set":{"consequence":consequence}}).await.map_err(|_|FunctionFailure::Internal)?;
            }
            // These are the source model's required fields and enum. Decision
            // write ordering is retained even when action-log validation fails.
            if input.channel_id.is_empty()||input.user_id.is_empty()||input.rule.id.is_empty()||input.rule.rule_type.is_empty()||!matches!(input.step.action.as_str(),"off"|"warn"|"delete"|"timeout"|"ban") {return Err(FunctionFailure::Internal);}
            let record=doc!{"_id":ObjectId::new(),"channelID":&input.channel_id,"userID":&input.user_id,"username":&input.username,"ruleID":&input.rule.id,"ruleType":&input.rule.rule_type,"action":&input.step.action,"offenseNumber":input.offense_number,"reason":&input.rule.reason,"messageID":&input.message_id,"messageExcerpt":prefix_utf16(&input.message_text,200),"success":success,"errorMessage":error_message.map_or(Bson::Null,|message|Bson::String(message.into())),"createdAt":DateTime::now(),"__v":0};
            db.collection::<Document>(MODERATION_ACTION_LOG_COLLECTION).insert_one(record).await.map_err(|_|FunctionFailure::Internal)?;Ok(())
        }.await;
        if result.is_err() {
            self.diagnose("moderation.writeActionLog", &input.channel_id)
                .await;
        }
    }
    async fn send_notice_throttled(&self, input: &ModerationExecutionInput) {
        let result: Result<(), FunctionFailure>=async {
            let acquired=self.cache.execute(CacheCommand::SetIfAbsent{key:format!("moderation:{}:notice:{}",input.channel_id,input.user_id),value:"1".into(),seconds:NOTICE_COOLDOWN_SECONDS}).await?;
            if acquired!=CacheValue::Flag(true){return Ok(());}
            let message=prefix_utf16(&format!("@{} {}",input.username,input.rule.reason),490);
            // This caller supplies no AST context/references. The source's
            // post-send deliverAstMessage('', undefined) has no effects.
            if crate::utils::js_compat::trim(&message).is_empty(){return Ok(());}
            let body=json!({"broadcaster_id":input.channel_id,"sender_id":TWITCH_BOT_ACCOUNT_ID,"message":message,"for_source_only":true});
            let response=self.request(TwitchAuth::App,Method::POST,"chat/messages",None,Some(&body),None).await?;
            let status=response.status();
            let data:Value=response.json().await.map_err(|_|FunctionFailure::Internal)?;
            if !status.is_success()||data.get("data").and_then(Value::as_array).and_then(|items|items.first()).and_then(|item|item.get("is_sent"))==Some(&Value::Bool(false)) {
                self.diagnose("sendTwitchChatMessage.twitchRejected",&input.channel_id).await;
            }
            // Source sendNoticeThrottled deliberately ignores send return
            // errors: no retry and no failure of the moderation action.
            Ok(())
        }.await;
        if result.is_err() {
            self.diagnose("moderation.sendNoticeThrottled", &input.channel_id)
                .await;
        }
    }
    pub async fn execute_moderation_action(&self, input: &ModerationExecutionInput) -> Value {
        let action = input.step.action.as_str();
        if action == "off" {
            self.write_action_log(input, true, None).await;
            return json!({"error":false,"message":"No action configured for this offense","action":action});
        }
        let result = match action {
            "warn" => {
                self.warn_user(&input.channel_id, &input.user_id, &input.rule.reason)
                    .await
            }
            "delete" => {
                self.delete_moderation_message(&input.message_id, &input.channel_id)
                    .await
            }
            "timeout" => {
                self.ban(
                    &input.channel_id,
                    &input.user_id,
                    TWITCH_BOT_ACCOUNT_ID,
                    Some(input.step.timeout_seconds),
                    Some(&input.rule.reason),
                    None,
                )
                .await
            }
            "ban" => {
                self.ban(
                    &input.channel_id,
                    &input.user_id,
                    TWITCH_BOT_ACCOUNT_ID,
                    None,
                    Some(&input.rule.reason),
                    None,
                )
                .await
            }
            _ => json!({"error":true,"message":format!("Unknown moderation action: {action}")}),
        };
        let failed = result.get("error").is_some_and(truthy);
        if !failed {
            self.send_notice_throttled(input).await;
        } else {
            self.diagnose("executeModerationAction", &input.channel_id)
                .await;
        }
        let message = result
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        self.write_action_log(input, !failed, failed.then_some(message))
            .await;
        json!({"error":failed,"message":message,"action":action})
    }
    async fn delete_moderation_message(&self, message: &str, channel: &str) -> Value {
        let result = async {
            let params = query([
                ("broadcaster_id".into(), channel.into()),
                ("message_id".into(), message.into()),
                ("moderator_id".into(), TWITCH_BOT_ACCOUNT_ID.into()),
            ]);
            let response = self
                .request(
                    TwitchAuth::Bot,
                    Method::DELETE,
                    "moderation/chat",
                    Some(&params),
                    None,
                    None,
                )
                .await?;
            let status = response.status().as_u16();
            if status == 204 {
                return Ok(json!({"error":false,"message":"Message deleted"}));
            }
            let data: Value = response
                .json()
                .await
                .map_err(|_| FunctionFailure::Internal)?;
            if let Some(error) = data.get("error").filter(|value| truthy(value)) {
                return Ok(json!({"error":true,"message":error,"status":status}));
            }
            Ok(json!({"error":false,"message":"Message deleted"}))
        }
        .await;
        self.finish(
            "deleteMessage",
            channel,
            result,
            json!({"error":true,"message":"Internal server error","status":500,"type":"error"}),
            Some("error"),
        )
        .await
    }
}
