//! Application persistence schemas, using the existing native MongoDB driver.
//! No import-time connection, index creation, environment read or application
//! startup occurs. Call install_indexes explicitly on an isolated or approved
//! application database; constructors are pure except fresh ObjectId entropy.
#[cfg(feature = "channel-tts-settings")]
#[path = "channel_tts_settings.schema.rs"]
pub mod channel_tts_settings;
mod schema;
pub use schema::*;
#[path = "accounts.schema.rs"]
pub mod accounts;
#[path = "admin.schema.rs"]
pub mod admin;
#[path = "app_config.schema.rs"]
pub mod app_config;
#[path = "channel_config.schema.rs"]
pub mod channel_config;
#[path = "credit_gift.schema.rs"]
pub mod credit_gift;
#[path = "credit_transaction.schema.rs"]
pub mod credit_transaction;
#[path = "oauth_client.schema.rs"]
pub mod oauth_client;
#[path = "oauth_grant.schema.rs"]
pub mod oauth_grant;
#[path = "oauth_refresh_token.schema.rs"]
pub mod oauth_refresh_token;
#[path = "oauth_session.schema.rs"]
pub mod oauth_session;
#[path = "users.schema.rs"]
pub mod users;

#[path = "ai_usage_daily.schema.rs"]
pub mod ai_usage_daily;
#[path = "ai_usage_dashboard.schema.rs"]
pub mod ai_usage_dashboard;
#[path = "ai_usage_ledger_state.schema.rs"]
pub mod ai_usage_ledger_state;
#[path = "ai_usage_receipt.schema.rs"]
pub mod ai_usage_receipt;
#[path = "ast_variables.schema.rs"]
pub mod ast_variables;
#[path = "chat_logs.schema.rs"]
pub mod chat_logs;
#[path = "command_timer.schema.rs"]
pub mod command_timer;
#[path = "command_user_variables.schema.rs"]
pub mod command_user_variables;
#[path = "countdown_timer.schema.rs"]
pub mod countdown_timer;
#[path = "countdown_timer_config.schema.rs"]
pub mod countdown_timer_config;
#[path = "custom_timer.schema.rs"]
pub mod custom_timer;
#[path = "dashboard_activity.schema.rs"]
pub mod dashboard_activity;
#[path = "dashboard_insights.schema.rs"]
pub mod dashboard_insights;
#[path = "domain_event.schema.rs"]
pub mod domain_event;
#[path = "domain_event_checkpoint.schema.rs"]
pub mod domain_event_checkpoint;
#[path = "domain_event_delivery.schema.rs"]
pub mod domain_event_delivery;
#[path = "raid_analytics.schema.rs"]
pub mod raid_analytics;
#[path = "raid_session.schema.rs"]
pub mod raid_session;
#[path = "raid_subscription_preference.schema.rs"]
pub mod raid_subscription_preference;
#[path = "stream_activity.schema.rs"]
pub mod stream_activity;
#[path = "stream_session.schema.rs"]
pub mod stream_session;
#[path = "stream_subscription_ledger.schema.rs"]
pub mod stream_subscription_ledger;
#[path = "stream_timeline.schema.rs"]
pub mod stream_timeline;
#[path = "stream_viewer_snapshot.schema.rs"]
pub mod stream_viewer_snapshot;

pub fn definitions() -> [&'static SchemaDefinition; 42] {
    [
        users::schema(),
        accounts::schema(),
        admin::schema(),
        app_config::schema(),
        channel_config::schema(),
        oauth_client::schema(),
        oauth_grant::schema(),
        oauth_refresh_token::schema(),
        oauth_session::schema(),
        credit_gift::schema(),
        credit_transaction::schema(),
        ai_usage_daily::schema(),
        ai_usage_dashboard::schema(),
        ai_usage_ledger_state::schema(),
        ai_usage_receipt::schema(),
        ast_variables::schema(),
        chat_logs::schema(),
        command_timer::schema(),
        command_user_variables::schema(),
        countdown_timer::schema(),
        countdown_timer_config::schema(),
        custom_timer::schema(),
        dashboard_activity::schema(),
        dashboard_activity::summary_schema(),
        dashboard_insights::schema(),
        domain_event::schema(),
        domain_event_checkpoint::schema(),
        domain_event_delivery::schema(),
        raid_analytics::schema(),
        raid_analytics::summary_schema(),
        raid_session::schema(),
        raid_session::follower_schema(),
        raid_session::request_schema(),
        raid_subscription_preference::schema(),
        stream_activity::schema(),
        stream_activity::aggregate_schema(),
        stream_activity::state_schema(),
        stream_session::schema(),
        stream_subscription_ledger::schema(),
        stream_timeline::schema(),
        stream_timeline::marker_schema(),
        stream_viewer_snapshot::schema(),
    ]
}
pub fn by_model(model: &str) -> Option<&'static SchemaDefinition> {
    definitions()
        .into_iter()
        .find(|schema| schema.model == model)
}
