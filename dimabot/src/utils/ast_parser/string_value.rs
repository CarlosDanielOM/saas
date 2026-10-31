//! Shared JavaScript UTF-16 string and its explicit UTF-8 boundary error.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvalError {
    pub name: String,
    pub message: String,
}
impl EvalError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            name: "Error".into(),
            message: message.into(),
        }
    }
}
impl std::fmt::Display for EvalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for EvalError {}
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct JsString(pub(crate) Vec<u16>);
impl JsString {
    pub fn from_units(units: Vec<u16>) -> Self {
        Self(units)
    }
    pub fn units(&self) -> &[u16] {
        &self.0
    }
    pub fn to_utf8(&self) -> Result<String, EvalError> {
        String::from_utf16(&self.0)
            .map_err(|_| EvalError::new("Unpaired UTF16 surrogate at UTF8 boundary"))
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn push(&mut self, other: &Self) {
        self.0.extend_from_slice(&other.0);
    }
    pub fn trim(&self) -> Self {
        let start = self
            .0
            .iter()
            .position(|c| !whitespace(*c))
            .unwrap_or(self.0.len());
        let end = self
            .0
            .iter()
            .rposition(|c| !whitespace(*c))
            .map_or(start, |i| i + 1);
        Self(self.0[start..end].to_vec())
    }
    pub fn lower(&self) -> Self {
        // Preserve lone surrogates, while applying contextual Unicode casing to
        // each well-formed run (not to individual code points: final sigma).
        let mut out = Vec::new();
        let mut run = String::new();
        for c in char::decode_utf16(self.0.iter().copied()) {
            match c {
                Ok(c) => run.push(c),
                Err(e) => {
                    out.extend(run.to_lowercase().encode_utf16());
                    run.clear();
                    out.push(e.unpaired_surrogate());
                }
            }
        }
        out.extend(run.to_lowercase().encode_utf16());
        Self(out)
    }
}
impl From<&str> for JsString {
    fn from(s: &str) -> Self {
        Self(s.encode_utf16().collect())
    }
}
impl From<String> for JsString {
    fn from(s: String) -> Self {
        Self::from(s.as_str())
    }
}
impl From<&String> for JsString {
    fn from(s: &String) -> Self {
        Self::from(s.as_str())
    }
}
fn whitespace(c: u16) -> bool {
    char::from_u32(u32::from(c)).is_some_and(crate::utils::js_compat::is_whitespace)
}


#[cfg(test)]
mod tests {
    use super::{EvalError, JsString};

    #[test]
    fn code_units_and_utf8_error_are_preserved() {
        let value = JsString::from_units(vec![0x41, 0xd83d, 0xde00, 0xd800, 0x5a]);
        assert_eq!(value.units(), &[0x41, 0xd83d, 0xde00, 0xd800, 0x5a]);
        let error: EvalError = value.to_utf8().unwrap_err();
        assert_eq!(error.name, "Error");
        assert_eq!(error.message, "Unpaired UTF16 surrogate at UTF8 boundary");
        assert_eq!(JsString::from(" A ").trim().lower().to_utf8().unwrap(), "a");
    }
}

#[cfg(all(test, feature = "ast-evaluator"))]
mod evaluator_compatibility_tests {
    #[test]
    fn evaluator_paths_reexport_the_same_type_and_error() {
        let syntax = crate::utils::ast_syntax::JsString::from_units(vec![0xd800]);
        let legacy: crate::utils::ast_evaluator::JsString = syntax;
        let nested: crate::utils::ast_evaluator::value::JsString = legacy;
        let error: crate::utils::ast_evaluator::EvalError = nested.to_utf8().unwrap_err();
        assert_eq!(error.message, "Unpaired UTF16 surrogate at UTF8 boundary");
    }
}

#[cfg(test)]
mod persistence_tests {
    #[test]
    fn syntax_only_adapter_round_trips_unpaired_units() {
        let original = super::super::PersistedJsString(super::JsString::from_units(vec![
            0x41, 0xd800, 0x42, 0xdc00, 0x43,
        ]));
        let json = serde_json::to_value(&original).unwrap();
        assert_eq!(json, serde_json::json!([65, 55296, 66, 56320, 67]));
        let restored: super::super::PersistedJsString = serde_json::from_value(json).unwrap();
        assert_eq!(restored, original);
    }
}
