//! Pure planning and a lossless ordered JSON view for moderation seeding.
use crate::schemas::channel_moderation_settings::{IModerationRule, MODERATION_SETTINGS_DEFAULTS};
use crate::utils::{js_string::JsString, json_number::number_string};

/// `None` represents a missing or null rules value; only its length is read.
#[derive(Clone, Copy, Debug)]
pub struct Candidate {
    pub enabled: Option<bool>,
    pub rules_len: Option<usize>,
    pub settings_version: Option<f64>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModerationSeedPlan {
    Create,
    ReplaceStub,
    Keep,
}
impl ModerationSeedPlan {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::ReplaceStub => "replace-stub",
            Self::Keep => "keep",
        }
    }
}
pub fn is_untouched_lazy_stub(doc: Option<&Candidate>) -> bool {
    doc.is_some_and(|doc| {
        doc.enabled == Some(false)
            && doc.rules_len.unwrap_or(0) == 0
            && doc.settings_version.unwrap_or(1.0) == 1.0
    })
}
pub fn plan_moderation_seed(existing: Option<&Candidate>) -> ModerationSeedPlan {
    match existing {
        None => ModerationSeedPlan::Create,
        Some(_) if is_untouched_lazy_stub(existing) => ModerationSeedPlan::ReplaceStub,
        Some(_) => ModerationSeedPlan::Keep,
    }
}
pub struct ExistingChannelModerationView<'a> {
    pub channel_id: &'a JsString,
    pub channel: &'a JsString,
    pub enabled: bool,
    pub offense_window_seconds: f64,
    pub rules: Vec<IModerationRule>,
    pub settings_version: f64,
}
pub fn existing_channel_moderation_view<'a>(
    channel_id: &'a JsString,
    channel_name: &'a JsString,
) -> ExistingChannelModerationView<'a> {
    ExistingChannelModerationView {
        channel_id,
        channel: channel_name,
        enabled: false,
        offense_window_seconds: MODERATION_SETTINGS_DEFAULTS.offense_window_seconds,
        rules: Vec::new(),
        settings_version: MODERATION_SETTINGS_DEFAULTS.settings_version,
    }
}
/// Encode only a freshly constructed view; mutated views require an application serializer.
pub fn existing_channel_moderation_view_json(
    channel_id: &JsString,
    channel_name: &JsString,
) -> String {
    let view = existing_channel_moderation_view(channel_id, channel_name);
    let mut out = String::from("{\"channelID\":");
    view.channel_id.write_json_string(&mut out);
    out.push_str(",\"channel\":");
    view.channel.write_json_string(&mut out);
    out.push_str(if view.enabled {
        ",\"enabled\":true,\"offenseWindowSeconds\":"
    } else {
        ",\"enabled\":false,\"offenseWindowSeconds\":"
    });
    out.push_str(&number_string(view.offense_window_seconds));
    out.push_str(",\"rules\":[],\"settingsVersion\":");
    out.push_str(&number_string(view.settings_version));
    out.push('}');
    out
}
