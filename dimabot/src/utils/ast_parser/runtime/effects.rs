//! Opaque, host-minted Twitch effect authority.
use std::cell::Cell;
use sha2::{Digest, Sha256};
use crate::utils::ast_evaluator::EffectToken;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectOrigin { pub id: String, pub kind: String, pub occurred_at: String }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectActor { pub user_id: String, pub display_name: String }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PetAction { pub origin: EffectOrigin, pub actor: EffectActor, pub action_key: String }
struct State { channel_id: String, origin: EffectOrigin, actor: EffectActor, path: Vec<String>, next: Cell<u64> }
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// Creates authority only from a verified Twitch ingress.
pub fn create_twitch_effect_context(channel_id: &str, origin: EffectOrigin, actor: EffectActor) -> Option<EffectToken> {
    if channel_id.is_empty() || channel_id.len() > 30 || !channel_id.bytes().all(|b| b.is_ascii_digit()) || origin.id.trim().is_empty() || origin.id.encode_utf16().count() > 200 || !matches!(origin.kind.as_str(), "chat-command" | "twitch-event") || crate::utils::js_date::parse_date(&origin.occurred_at).is_none() || actor.user_id.trim().is_empty() || actor.user_id.encode_utf16().count() > 100 || actor.display_name.encode_utf16().count() > 100 { return None; }
    Some(EffectToken::from_host(State { channel_id: channel_id.into(), origin, actor, path: vec![], next: Cell::new(0) }))
}
pub fn scope_ast_effect_context(effect: Option<&EffectToken>, channel_id: &str, config_id: &str) -> Option<EffectToken> {
    let state = effect?.downcast_ref::<State>()?;
    if state.channel_id != channel_id || config_id.is_empty() { return None; }
    let mut path = state.path.clone(); path.push(config_id.into());
    Some(EffectToken::from_host(State { channel_id: state.channel_id.clone(), origin: state.origin.clone(), actor: state.actor.clone(), path, next: Cell::new(0) }))
}
pub fn fork_ast_effect_context(effect: Option<&EffectToken>) -> Option<EffectToken> {
    let state = effect?.downcast_ref::<State>()?;
    if state.path.is_empty() { return None; }
    let next = state.next.get(); state.next.set(next.checked_add(1)?);
    let mut path = state.path.clone(); path.push(format!("reference:{next}"));
    Some(EffectToken::from_host(State { channel_id: state.channel_id.clone(), origin: state.origin.clone(), actor: state.actor.clone(), path, next: Cell::new(0) }))
}
pub fn next_pet_action(effect: Option<&EffectToken>, channel_id: &str) -> Option<PetAction> {
    let state = effect?.downcast_ref::<State>()?;
    let next = state.next.get();
    if state.channel_id != channel_id || state.path.is_empty() || next > MAX_SAFE_INTEGER { return None; }
    let input = serde_json::to_vec(&(state.path.as_slice(), next)).ok()?;
    state.next.set(next + 1);
    let digest = Sha256::digest(input);
    Some(PetAction { origin: state.origin.clone(), actor: state.actor.clone(), action_key: format!("pet:v1:{digest:x}") })
}
