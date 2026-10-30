//! Settings coercion on top of the shared flat JSON document.
pub use super::lossless_json_document::{ArrayIter, JsonDocument, JsonView};
use super::{
    js_string::JsString,
    lossless_json::JsonValue,
    tts::settings::{self, SettingsError},
};

impl<'a> JsonView<'a> {
    fn shallow_coercion_value(self) -> JsonValue {
        self.scalar().unwrap_or_else(|| {
            // Plain JSON cannot supply callables or custom prototypes. Only
            // presence of own toString matters to the existing object policy;
            // neither its value nor any other descendant needs materializing.
            debug_assert_eq!(self.tag(), b'{');
            JsonValue::Object(if self.get("toString").is_some() {
                vec![(JsString::from("toString"), JsonValue::Null)]
            } else {
                Vec::new()
            })
        })
    }

    fn non_array_string(self) -> Result<JsString, SettingsError> {
        debug_assert_ne!(self.tag(), b'[');
        if let Some(value) = self.as_string() {
            // String(string) is identity. Return this owned decode directly
            // instead of cloning it again through the settings helper.
            Ok(value)
        } else {
            settings::js_string(&self.shallow_coercion_value())
        }
    }

    /// JSON-data String(value), using a heap stack for nested Array.join.
    /// Each separator belongs to its own array; null elements contribute empty
    /// text, nested empty arrays retain their parent's separators. Primitive
    /// strings retain identity; other scalar and ordinary object
    /// conversions delegate to the established settings policy.
    pub fn js_string(self) -> Result<JsString, SettingsError> {
        let Some(elements) = self.array() else {
            return self.non_array_string();
        };
        let mut stack = vec![(elements, true)];
        let mut units = Vec::new();
        while let Some((elements, first)) = stack.last_mut() {
            if let Some(value) = elements.next() {
                if !*first {
                    units.push(u16::from(b','));
                }
                *first = false;
                if let Some(nested) = value.array() {
                    stack.push((nested, true));
                } else if !value.is_null() {
                    units.extend(value.non_array_string()?.code_units());
                }
            } else {
                stack.pop();
            }
        }
        Ok(JsString::from_units(units))
    }
}

/// Missing is Number(undefined), distinct from present null. Array conversion
/// uses the iterative join, then reuses the existing whitespace/radix/rounding
/// and nonfinite policies by feeding only the resulting scalar to settings.
pub fn js_number(value: Option<JsonView<'_>>) -> Result<f64, SettingsError> {
    match value {
        None => settings::js_number(None),
        Some(value) if value.tag() == b'[' => {
            settings::js_number(Some(&JsonValue::String(value.js_string()?)))
        }
        Some(value) => settings::js_number(Some(&value.shallow_coercion_value())),
    }
}

#[cfg(test)]
mod tests {
    use super::{JsonDocument, JsonValue, js_number, settings};
    use crate::utils::lossless_json::parse_json;

    #[test]
    fn leaf_and_join_observations_match_existing_owned_settings_policy() {
        for raw in [
            r#""""#,
            r#""ascii""#,
            r#""a\u0073cii""#,
            r#""é😀é""#,
            r#""\u00e9\ud83d\ude00e\u0301""#,
            r#"" \t\n\r""#,
            r#""\u0000""#,
            r#""\"\\\/\b\f\n\r\t""#,
            r#""\ud800""#,
            r#""\udc00\ud800""#,
            r#""\ud800\ud83d\ude00\udc00""#,
            r#""\ufeff0x20000000000003\u3000""#,
            r#""-0""#,
            "null",
            "false",
            "true",
            "0",
            "-0",
            "1e-4000",
            "-1e-4000",
            "5e-324",
            "1e9999",
            "-1e9999",
            "[]",
            "[null,[]]",
            r#"["",["a",null],"\ud800","😀"]"#,
            r#"[[" -0 "]]"#,
            r#"["ok",{"toString":null},"\ud800"]"#,
            "{}",
            r#"{"toString":null}"#,
            r#"{"to\u0053tring":0,"toString":false}"#,
            r#"{"__proto__":{"toString":null},"valueOf":""}"#,
        ] {
            let owned = parse_json(raw).unwrap();
            let doc = JsonDocument::parse(raw).unwrap();
            let view = doc.root();
            assert_eq!(view.truthy(), settings::truthy(&owned), "{raw}");
            assert_eq!(view.js_string(), settings::js_string(&owned), "{raw}");
            match (js_number(Some(view)), settings::js_number(Some(&owned))) {
                (Ok(actual), Ok(expected)) if expected.is_nan() => assert!(actual.is_nan()),
                (Ok(actual), Ok(expected)) => {
                    assert_eq!(actual.to_bits(), expected.to_bits(), "{raw}")
                }
                (Err(actual), Err(expected)) => assert_eq!(actual, expected, "{raw}"),
                values => panic!("number policy mismatch {raw}: {values:?}"),
            }
            if !matches!(owned, JsonValue::Array(_) | JsonValue::Object(_)) {
                assert_eq!(view.scalar(), Some(owned), "{raw}");
            }
        }
        assert!(js_number(None).unwrap().is_nan());
        assert!(settings::js_number(None).unwrap().is_nan());
    }

    #[test]
    fn deep_singleton_arrays_match_the_existing_shallow_owned_join_policy() {
        for leaf in [
            r#""""#,
            r#"" -0 ""#,
            r#""\ud800😀\udc00""#,
            r#""\ufeff0x20000000000003\u3000""#,
            "null",
            "false",
            "-0",
            "1e9999",
            r#"[null,[],"",["a",null],"\u0000","😀"]"#,
            "{}",
            r#"{"toString":null}"#,
        ] {
            // Wrapping a value in more singleton arrays preserves the first
            // array's join result, including its null-to-empty treatment.
            let owned = parse_json(&format!("[{leaf}]")).unwrap();
            for depth in [128, 256] {
                let raw = format!("{}{leaf}{}", "[".repeat(depth), "]".repeat(depth));
                let doc = JsonDocument::parse(&raw).unwrap();
                let view = doc.root();
                assert!(view.truthy());
                assert_eq!(
                    view.js_string(),
                    settings::js_string(&owned),
                    "{depth} {leaf}"
                );
                match (js_number(Some(view)), settings::js_number(Some(&owned))) {
                    (Ok(actual), Ok(expected)) if expected.is_nan() => assert!(actual.is_nan()),
                    (Ok(actual), Ok(expected)) => {
                        assert_eq!(actual.to_bits(), expected.to_bits(), "{depth} {leaf}")
                    }
                    (Err(actual), Err(expected)) => assert_eq!(actual, expected, "{depth} {leaf}"),
                    values => panic!("deep number policy mismatch {depth} {leaf}: {values:?}"),
                }
            }
        }
    }
}
