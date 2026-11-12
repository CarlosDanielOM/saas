//! Argument substitution as `resolveArgumentPlaceholders` does it
//! (`dimabot/src/handlers/special_parser.handler.ts`), for tests: the text the parser gets.
//! The real port lives with the special parser; this copy only has to produce the same text.

/// Each `&pN` (N ≥ 1) becomes word N of the argument and each `&t` the words after the highest
/// position used so far, joined by a space; `&p0` becomes nothing. With `literal`, each
/// placeholder becomes a variable read `%(cmd_arg_<32 hex digits>_<k>)` instead (`bind`).
/// Returns `None` where the reference reports `cannot create new &pN after &t`.
pub fn resolve(template: &str, argument: &str, literal: bool) -> Option<String> {
    if !template.contains("&p") && !template.contains("&t") {
        return Some(template.to_owned());
    }
    let words: Vec<&str> = dima_text::trim(argument)
        .split(dima_text::is_js_whitespace)
        .filter(|word| !word.is_empty())
        .collect();
    let mut bound = 0usize;
    let mut bind = |value: &str| {
        if literal {
            bound += 1;
            format!("%(cmd_arg_{}_{})", "0".repeat(32), bound - 1)
        } else {
            value.to_owned()
        }
    };
    let (mut created, mut highest, mut tail) = (Vec::<usize>::new(), 0usize, None::<String>);
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(at) = rest.find('&') {
        // `find` and ASCII digit counts land on character boundaries.
        let (before, from) = rest.split_at(at);
        out.push_str(before);
        let after = from.get(1..).unwrap_or_default();
        if let Some(digits) = after.strip_prefix('p') {
            let count = digits.bytes().take_while(u8::is_ascii_digit).count();
            if count > 0 {
                // `Number.parseInt` of a digit run; positions past any word give "".
                let (number, _) = digits.split_at(count);
                let position: usize = number.parse().unwrap_or(usize::MAX);
                if position >= 1 {
                    let known = created.contains(&position);
                    if tail.is_some() && !known {
                        return None;
                    }
                    if !known {
                        created.push(position);
                        highest = highest.max(position);
                    }
                    let word = words.get(position - 1).copied().unwrap_or("");
                    out.push_str(&bind(word));
                }
                rest = digits.split_at(count).1;
                continue;
            }
        }
        if let Some(next) = after.strip_prefix('t') {
            // `&t\b`: the next character is not a word character (or there is none).
            if !next
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                let text = tail
                    .get_or_insert_with(|| words.get(highest..).unwrap_or(&[]).join(" "))
                    .clone();
                out.push_str(&bind(&text));
                rest = next;
                continue;
            }
        }
        out.push('&');
        rest = after;
    }
    out.push_str(rest);
    Some(out)
}

/// Every placeholder (`&pN`, `&t`) replaced by `argument` as a whole: an upper bound of what a
/// viewer can make the parser read, with no literal binding.
pub fn worst_case(template: &str, argument: &str) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(at) = rest.find('&') {
        // `find` and ASCII digit counts land on character boundaries.
        let (before, from) = rest.split_at(at);
        out.push_str(before);
        let after = from.get(1..).unwrap_or_default();
        if let Some(digits) = after.strip_prefix('p') {
            let count = digits.bytes().take_while(u8::is_ascii_digit).count();
            if count > 0 {
                out.push_str(argument);
                rest = digits.split_at(count).1;
                continue;
            }
        }
        if let Some(next) = after.strip_prefix('t')
            && !next
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            out.push_str(argument);
            rest = next;
            continue;
        }
        out.push('&');
        rest = after;
    }
    out.push_str(rest);
    out
}
