//! VOD clip recommendations: the OpenRouter client and prompts, claims, previews, notifications,
//! recovery, reconciliation and the failure policy. Package **P4-RECAP-C** fills this module; it is
//! empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/ai/clip_recommendations/openrouter_clip_recommendations.client.ts` (467 lines):
//!   `analyzeVodAudioForClipMoments`, `verifyCandidateVideosBatch`
//! - `utils/ai/clip_recommendations/clip_recommendations_prompts.ts` (89 lines):
//!   `CLIP_RECOMMENDATION_MODEL_ID`, `normalizeClipRecommendationLanguage`
//! - `utils/ai/clip_recommendations/clip_recommendation_claims.ts` (29 lines): `CLIP_CLAIM_SCRIPTS`
//! - `utils/ai/clip_recommendations/clip_recommendation_previews.ts` (50 lines):
//!   `deleteClipRecommendationPreviews`
//! - `utils/ai/clip_recommendations/clip_recommendation_notifications.ts` (58 lines):
//!   `sendClipCompletionNotification`
//! - `utils/ai/clip_recommendations/clip_recommendation_recovery.ts` (35 lines):
//!   `decideClipRecommendationRecovery`
//! - `utils/ai/clip_recommendations/clip_recommendation_reconciliation.ts` (76 lines):
//!   `reconcileClipRecommendations`
//! - `utils/ai/clip_recommendations/vod_clip_recommender_policy.ts` (43 lines):
//!   `getClipJobFailureDisposition`, `getClipWorkflowFailureDisposition`,
//!   `shouldStopAfterHeartbeatFailure`
//!
//! The API's clip recommendation routes read through this module (`dima-routes::data`).

pub mod runner;
