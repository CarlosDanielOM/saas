//! `resolveArgumentPlaceholders(template, argument, literal)`
//! (`handlers/special_parser.handler.ts:108-169`): `&pN` becomes word N of the argument and `&t`
//! the words after the highest position used so far.
//!
//! With `literal` (every command, and the editor's simulation), each placeholder becomes a read
//! of a run variable, `%(cmd_arg_<32 hex digits>_<k>)`, bound to the word, so the viewer's text
//! is never parsed as command language. The 32 digits are a `randomUUID()` without its dashes,
//! drawn from the injected randomness only when the template has a placeholder.
//!
//! Classifications (charter section 4): words are split on JavaScript whitespace and the text is
//! never cut; `&p` digits are ASCII (`\d`); `&t` ends at a word boundary (`\b` with JavaScript's
//! ASCII `\w`).

use dima_core::Random;
use dima_core::RandomError;

/// What [`resolve`] answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolution {
    /// The template with every placeholder replaced.
    pub text: String,
    /// The bound run variables, in order (`literal` only).
    pub variables: Vec<(String, String)>,
    /// `cannot create new &pN after &t`: a `&pN` of a new position after a `&t`.
    pub error: Option<&'static str>,
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `resolveArgumentPlaceholders`. Fails only when `random` does.
pub fn resolve(
    template: &str,
    argument: &str,
    literal: bool,
    random: &dyn Random,
) -> Result<Resolution, RandomError> {
    if !template.contains("&p") && !template.contains("&t") {
        return Ok(Resolution {
            text: template.to_owned(),
            variables: Vec::new(),
            error: None,
        });
    }
    let prefix = format!("cmd_arg_{}", random.uuid_v4()?.replace('-', ""));
    let words: Vec<&str> = dima_text::trim(argument)
        .split(dima_text::is_js_whitespace)
        .filter(|word| !word.is_empty())
        .collect();
    let mut variables: Vec<(String, String)> = Vec::new();
    let mut bind = |value: &str| -> String {
        if !literal {
            return value.to_owned();
        }
        let name = format!("{prefix}_{}", variables.len());
        variables.push((name.clone(), value.to_owned()));
        format!("%({name})")
    };
    let mut created: Vec<u128> = Vec::new();
    let mut highest: u128 = 0;
    let mut tail: Option<String> = None;
    let mut invalid = false;
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        if bytes.get(at) != Some(&b'&') {
            at += 1;
            continue;
        }
        let digits = bytes
            .get(at + 2..)
            .unwrap_or_default()
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        let end;
        let replacement = if bytes.get(at + 1) == Some(&b'p') && digits > 0 {
            end = at + 2 + digits;
            // `Number.parseInt` of the digits: a huge position is past every word.
            let position = template
                .get(at + 2..end)
                .and_then(|text| text.parse::<u128>().ok())
                .unwrap_or(u128::MAX);
            if position < 1 {
                String::new()
            } else {
                let known = created.contains(&position);
                if tail.is_some() && !known {
                    invalid = true;
                    String::new()
                } else {
                    if !known {
                        created.push(position);
                        highest = highest.max(position);
                    }
                    let word = usize::try_from(position - 1)
                        .ok()
                        .and_then(|index| words.get(index))
                        .copied()
                        .unwrap_or("");
                    bind(word)
                }
            }
        } else if bytes.get(at + 1) == Some(&b't')
            && !bytes.get(at + 2).copied().is_some_and(is_word_byte)
        {
            end = at + 2;
            let text = tail.get_or_insert_with(|| {
                let skip = usize::try_from(highest).unwrap_or(usize::MAX);
                words
                    .iter()
                    .skip(skip)
                    .copied()
                    .collect::<Vec<_>>()
                    .join(" ")
            });
            let text = text.clone();
            bind(&text)
        } else {
            at += 1;
            continue;
        };
        out.push_str(template.get(copied..at).unwrap_or_default());
        out.push_str(&replacement);
        copied = end;
        at = end;
    }
    out.push_str(template.get(copied..).unwrap_or_default());
    Ok(Resolution {
        text: out,
        variables: if invalid { Vec::new() } else { variables },
        error: invalid.then_some("cannot create new &pN after &t"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dima_core::SeededRandom;

    fn plain(template: &str, argument: &str) -> Resolution {
        resolve(template, argument, false, &SeededRandom::new(1)).unwrap()
    }

    #[test]
    fn positions_and_the_tail() {
        assert_eq!(
            plain("hi &p1 and &p2", "  ana  bob carl").text,
            "hi ana and bob"
        );
        assert_eq!(plain("&p2 rest: &t", "a b c d").text, "b rest: c d");
        assert_eq!(plain("&t|&t", "a b").text, "a b|a b");
        assert_eq!(plain("&p0x&p9", "a").text, "x");
        assert_eq!(plain("&p99999999999999999999999 ok", "a").text, " ok");
        // `&t` must end at a word boundary; `&p` needs a digit.
        assert_eq!(plain("&tx &p &t", "a").text, "&tx &p a");
        assert_eq!(plain("no placeholders", "a").text, "no placeholders");
        assert_eq!(plain("👋 &p1 مرحبا", "é\u{3000}z").text, "👋 é مرحبا");
    }

    #[test]
    fn a_new_position_after_the_tail_is_an_error() {
        let resolved = plain("&t &p1", "a b");
        assert_eq!(resolved.error, Some("cannot create new &pN after &t"));
        // A position created before the tail may be used again.
        assert_eq!(plain("&p1 &t &p1", "a b").text, "a b a");
    }

    #[test]
    fn literal_binds_run_variables() {
        let random = SeededRandom::new(7);
        let expected_uuid = SeededRandom::new(7).uuid_v4().unwrap().replace('-', "");
        let resolved = resolve("x &p1 &t", "$(ban me) now", true, &random).unwrap();
        assert_eq!(
            resolved.text,
            format!("x %(cmd_arg_{expected_uuid}_0) %(cmd_arg_{expected_uuid}_1)")
        );
        assert_eq!(
            resolved.variables,
            [
                (format!("cmd_arg_{expected_uuid}_0"), "$(ban".to_owned()),
                (format!("cmd_arg_{expected_uuid}_1"), "me) now".to_owned()),
            ]
        );
        // No placeholder: nothing is drawn.
        let untouched = SeededRandom::new(9);
        resolve("plain", "a", true, &untouched).unwrap();
        assert_eq!(
            untouched.uuid_v4().unwrap(),
            SeededRandom::new(9).uuid_v4().unwrap()
        );
    }
}
