//! Canonical expressive tags and their complete, catalog-ordered settings.

use super::{DELIVERY, EFFECTS, EMOTIONS, ExpressiveTagConfig, SOUNDS, expressive_tags};
use crate::utils::{js_string::write_json_utf8, lossless_json::JsonValue};
use std::{fmt, str::FromStr};

const TAG_COUNT: usize = EMOTIONS.len() + DELIVERY.len() + SOUNDS.len() + EFFECTS.len();

/// A canonical catalog tag. Aliases and text-filter normalization do not apply.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ExpressiveTtsTag(usize);

impl ExpressiveTtsTag {
    /// Iterate in the order used by the TypeScript catalog.
    pub fn iter() -> impl Iterator<Item = Self> {
        (0..TAG_COUNT).map(Self)
    }

    pub fn as_str(self) -> &'static str {
        expressive_tags().nth(self.0).expect("valid catalog index")
    }
}

impl FromStr for ExpressiveTtsTag {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        expressive_tags()
            .position(|tag| tag == value)
            .map(Self)
            .ok_or("unknown expressive TTS tag")
    }
}

impl fmt::Display for ExpressiveTtsTag {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One boolean for every canonical tag, stored in catalog order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExpressiveTtsTagSettings {
    values: [bool; TAG_COUNT],
}

impl ExpressiveTtsTagSettings {
    pub fn filled(value: bool) -> Self {
        Self {
            values: [value; TAG_COUNT],
        }
    }

    pub fn from_fn(mut f: impl FnMut(ExpressiveTtsTag) -> bool) -> Self {
        Self {
            values: std::array::from_fn(|index| f(ExpressiveTtsTag(index))),
        }
    }

    /// Apply the same lossless JSON and legacy-key policy as the map API.
    pub fn from_json(input: Option<&JsonValue>) -> Self {
        let config = ExpressiveTagConfig::new(input);
        Self::from_fn(|tag| config.tag(tag.as_str()))
    }

    pub fn get(&self, tag: ExpressiveTtsTag) -> bool {
        self.values[tag.0]
    }

    pub fn set(&mut self, tag: ExpressiveTtsTag, value: bool) {
        self.values[tag.0] = value;
    }

    pub fn iter(&self) -> impl Iterator<Item = (ExpressiveTtsTag, bool)> + '_ {
        ExpressiveTtsTag::iter().zip(self.values.iter().copied())
    }

    /// Append the JSON object in source catalog order.
    pub fn write_json(&self, out: &mut String) {
        out.push('{');
        for (index, (tag, value)) in self.iter().enumerate() {
            if index != 0 {
                out.push(',');
            }
            write_json_utf8(tag.as_str(), out);
            out.push(':');
            out.push_str(if value { "true" } else { "false" });
        }
        out.push('}');
    }

    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }
}

impl Default for ExpressiveTtsTagSettings {
    fn default() -> Self {
        Self::filled(true)
    }
}
