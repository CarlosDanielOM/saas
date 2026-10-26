use super::{Context, EffectToken, EvalError, JsString, JsValue};
use crate::utils::ast_syntax::AstNode;
use std::{future::Future, pin::Pin};

pub type HostFuture<'a> = Pin<Box<dyn Future<Output = Result<JsValue, EvalError>> + 'a>>;
#[derive(Clone, Debug)]
pub enum HostRequest {
    Function {
        name: String,
        args: Vec<JsValue>,
    },
    CacheGet {
        key: JsString,
    },
    CacheExists {
        key: JsString,
    },
    CacheSet {
        key: JsString,
        value: JsString,
    },
    CacheExpire {
        key: JsString,
        seconds: u64,
    },
    CacheDelete {
        key: JsString,
    },
    LoadChannelVariable {
        name: String,
    },
    SaveChannelVariable {
        name: String,
        value: JsString,
    },
    DeleteChannelVariable {
        name: String,
    },
    LoadUserVariable {
        name: String,
        target_user_login: Option<JsString>,
    },
    SaveUserVariable {
        name: String,
        value: JsString,
        target_user_login: Option<JsString>,
    },
    DeleteUserVariable {
        name: String,
        target_user_login: Option<JsString>,
    },
    SaveResponses,
    ScheduleTimer {
        seconds: f64,
        body: AstNode,
    },
}
/// Each operation is sequential. A host rejection is thrown; a handler's error
/// text is a successful JsValue. No production singleton or implicit adapter.
pub trait Host {
    fn execute<'a>(&'a mut self, request: HostRequest, context: Context) -> HostFuture<'a>;
    fn random(&mut self) -> Result<f64, EvalError>;
    fn fork_effect(&mut self, _effect: &EffectToken) -> Option<EffectToken> {
        None
    }
}
