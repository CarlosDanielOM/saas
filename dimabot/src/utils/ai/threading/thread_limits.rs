//! Ports `thread_limits.ts`: thread storage and prompt limits by tier.
//! This domain tier is distinct from billing's nullable credit tier; it does
//! not duplicate the billing limit table or perform plan lookup.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadPlanTier { Pro, Premium, Free }
impl ThreadPlanTier {
    pub fn from_value(value: &str) -> Self { match value { "pro" => Self::Pro, "premium" => Self::Premium, _ => Self::Free } }
    pub fn as_str(self) -> &'static str { match self { Self::Pro => "pro", Self::Premium => "premium", Self::Free => "free" } }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ThreadLimits { pub max_channel_threads: i64, pub max_user_threads: i64, pub max_turns_stored: i64, pub prompt_turns: i64 }
pub fn get_thread_limits_for_tier(tier: ThreadPlanTier) -> ThreadLimits {
    let (max_channel_threads, max_user_threads, max_turns_stored, prompt_turns) = match tier { ThreadPlanTier::Pro => (250,12,120,100), ThreadPlanTier::Premium => (100,6,60,40), ThreadPlanTier::Free => (40,3,20,10) };
    ThreadLimits { max_channel_threads, max_user_threads, max_turns_stored, prompt_turns }
}
