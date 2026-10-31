//! Native clip function family.
//!
//! | TypeScript source                      | Native module                          |
//! |----------------------------------------|----------------------------------------|
//! | `src/functions/clips/create.clip.ts`     | `create_clip` module (`create.clip.rs`) |
//! | `src/functions/clips/get_clip.clip.ts`   | `create_clip` module (see below)        |
//!
//! `getClip` currently lives in the same file as `createClip` because
//! `createClipCommand` depends on it directly and this lane owns neither
//! `get_clip.clip.rs` nor a second `#[path]` declaration. Both are inherent
//! methods on [`crate::functions::TwitchFunctions`], so splitting the file later
//! only moves code.
//!
//! `src/functions/clips/get_clips.clip.ts`, `show_clip.clip.ts` and
//! `queue.clip.ts` are **not** ported here; the barrel `index.ts` therefore has
//! no native counterpart yet.
//!
//! Construction performs no I/O. Every network call goes through
//! [`crate::functions::TwitchFunctions::request_detailed`].

#[path = "create.clip.rs"]
pub mod create_clip;

pub use create_clip::{
    BROADCASTER_NOT_LIVE, CLIP_CREATED, CLIP_ENDPOINT, CLIP_ID_MISSING, CLIP_ID_REQUIRED,
    CLIP_NOT_FOUND, ClipCancelled, ClipFailure, CreateClipOptions, CreateClipRequest,
    CreateClipResponse, GET_CLIP_SUCCESS, GetClipRequest, GetClipResponse, INTERNAL_SERVER_ERROR,
    TwitchClip, create_clip_body, create_clip_request, get_clip_body, get_clip_request,
    js_value_is_falsy, js_value_is_truthy, js_value_text,
};
