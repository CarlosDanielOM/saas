//! Public authorize redirect; construction performs no I/O.
use axum::{extract::{RawQuery, State}, http::{header, HeaderMap, StatusCode}, response::{IntoResponse, Response}, routing::get, Router};

#[derive(Clone)]
pub struct AuthorizeRoute { client_id: Option<String> }
impl AuthorizeRoute {
    pub fn new(client_id: Option<String>) -> Self { Self { client_id } }
    /// Nest at `/auth`, outside authentication middleware.
    pub fn router(&self) -> Router { Router::new().route("/authorize", get(authorize)).with_state(self.clone()) }
    pub fn location(&self, query: Option<&str>, host: Option<&str>) -> Result<Option<String>, CoercionError> {
        let (state, action) = query_values(query);
        let Some(state) = state else { return Ok(None) };
        if matches!(&state, Q::Text(text) if text.is_empty()) { return Ok(None) }
        let state = state.js_string()?;
        let host = host.filter(|h| !h.is_empty()).unwrap_or("api.domdimabot.com");
        let protocol = if host.contains("localhost") { "http" } else { "https" };
        let endpoint = if matches!(action, Some(Q::Text(ref value)) if value == "activate") { "register" } else { "reauthenticate" };
        let redirect = format!("{protocol}://{host}/auth/{endpoint}");
        let mut url = reqwest::Url::parse("https://id.twitch.tv/oauth2/authorize").expect("constant URL");
        url.query_pairs_mut().append_pair("response_type", "code").append_pair("force_verify", "false")
            .append_pair("client_id", self.client_id.as_deref().unwrap_or("undefined"))
            .append_pair("redirect_uri", &redirect).append_pair("scope", &TWITCH_AUTH_SCOPES.join(" ")).append_pair("state", &state);
        Ok(Some(encode_url(url.as_str())))
    }
}
// Only the two source-observable query properties are retained. The representation
// and merges follow installed qs parse.js/utils.js with Express's options.
#[derive(Clone, Debug)]
enum Q { Text(String), Array(Vec<Option<Q>>), Object(Vec<(String, Q)>, Option<f64>) }
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CoercionError;
impl Q {
    fn js_string(&self) -> Result<String, CoercionError> {
        match self {
            Q::Text(s) => Ok(s.clone()),
            Q::Array(items) => items.iter().map(|v| match v { Some(v) => v.js_string(), None => Ok(String::new()) }).collect::<Result<Vec<_>,_>>().map(|v| v.join(",")),
            Q::Object(fields, _) => if fields.iter().any(|(key,_)| key == "toString") { Err(CoercionError) } else { Ok("[object Object]".into()) },
        }
    }
    fn truthy(&self) -> bool { !matches!(self, Q::Text(s) if s.is_empty()) }
}
fn entries(items: Vec<Option<Q>>) -> Vec<(String, Q)> {
    items.into_iter().enumerate().filter_map(|(i,v)| v.map(|v| (i.to_string(),v))).collect()
}
// qs uses parseInt followed by String(number) equality. Its overflow side
// channel stores a JavaScript binary64, not a Rust address-sized integer.
fn parse_int10(s: &str) -> f64 {
    let s = s.trim_start_matches(crate::utils::js_compat::is_whitespace);
    let (sign, digits) = match s.as_bytes().first() {
        Some(b'-') => (-1.0, &s[1..]), Some(b'+') => (1.0, &s[1..]), _ => (1.0,s),
    };
    let length = digits.bytes().take_while(u8::is_ascii_digit).count();
    if length == 0 { return f64::NAN; }
    sign * digits[..length].parse::<f64>().unwrap_or(f64::INFINITY)
}
fn number_string(n: f64) -> String { crate::utils::json_number::number_string(n) }
fn index_key(s: &str) -> Option<f64> {
    let n = parse_int10(s);
    if n >= 0.0 && number_string(n) == s { Some(n) } else { None }
}
fn property_index(s: &str) -> Option<u32> {
    let n = s.parse::<u32>().ok()?;
    if n < u32::MAX && n.to_string() == s { Some(n) } else { None }
}
fn object_set(fields: &mut Vec<(String,Q)>, key: String, value: Q) {
    if let Some((_, old)) = fields.iter_mut().find(|(k,_)| *k == key) { *old = value; } else { fields.push((key,value)); }
}
fn js_keys(fields: &mut [(String,Q)]) {
    // Object.keys orders integer-index properties before other properties.
    fields.sort_by(|(a,_),(b,_)| {
        let numeric = |s: &str| property_index(s);
        match (numeric(a),numeric(b)) { (Some(a),Some(b)) => a.cmp(&b), (Some(_),None) => std::cmp::Ordering::Less, (None,Some(_)) => std::cmp::Ordering::Greater, _ => std::cmp::Ordering::Equal }
    });
}
fn combine(a: Q, b: Q) -> Q {
    if let Q::Object(mut fields, Some(max)) = a {
        let next = max + 1.0; object_set(&mut fields, number_string(next), b); return Q::Object(fields,Some(next));
    }
    let mut values = match a { Q::Array(v) => v, v => vec![Some(v)] };
    match b { Q::Array(v) => values.extend(v), v => values.push(Some(v)) }
    if values.len() > 1000 { let max = values.len()-1; Q::Object(entries(values),Some(max as f64)) } else { Q::Array(values) }
}
fn merge(target: Q, source: Q) -> Q {
    if !source.truthy() { return target; }
    if let Q::Text(_) = &source {
        return match target {
            Q::Array(mut a) => { a.push(Some(source)); if a.len()>1000 { let max=a.len()-1; Q::Object(entries(a),Some(max as f64)) } else { Q::Array(a) } },
            Q::Object(mut o,Some(max)) => { let next = max + 1.0; object_set(&mut o,number_string(next),source); Q::Object(o,Some(next)) },
            other => Q::Array(vec![Some(other),Some(source)]),
        };
    }
    if let Q::Text(_) = &target {
        if let Q::Object(mut fields,Some(max)) = source {
            let mut shifted = vec![("0".into(), target)];
            for (key,value) in fields.drain(..) { object_set(&mut shifted,number_string(parse_int10(&key) + 1.0),value); }
            return Q::Object(shifted,Some(max + 1.0));
        }
        return combine(target,source);
    }
    match (target,source) {
        (Q::Array(mut a),Q::Array(b)) => {
            for (i,item) in b.into_iter().enumerate() { if let Some(item)=item {
                if i < a.len() && a[i].is_some() {
                    let old=a[i].take().unwrap();
                    if !matches!(&old,Q::Text(_)) && !matches!(&item,Q::Text(_)) { a[i]=Some(merge(old,item)); }
                    else { a[i]=Some(old); a.push(Some(item)); }
                } else { if i>=a.len() { a.resize(i+1,None); } a[i]=Some(item); }
            } }
            if a.len()>1000 { let max=a.len()-1; Q::Object(entries(a),Some(max as f64)) } else { Q::Array(a) }
        },
        (a,b) => {
            let (mut target,mut overflow) = match a { Q::Array(v)=>(entries(v),None), Q::Object(v,o)=>(v,o), _=>unreachable!() };
            let (mut source,source_overflow) = match b { Q::Array(v)=>(entries(v),None), Q::Object(v,o)=>(v,o), _=>unreachable!() };
            js_keys(&mut source);
            for (key,value) in source {
                if let Some(pos)=target.iter().position(|(k,_)| *k==key) { let old=target.remove(pos).1; target.insert(pos,(key.clone(),merge(old,value))); }
                else { object_set(&mut target,key.clone(),value); }
                if overflow.is_none() { overflow=source_overflow; }
                if let (Some(max),Some(i))=(overflow,index_key(&key)) { if i>max { overflow=Some(i); } }
            }
            Q::Object(target,overflow)
        }
    }
}
fn decode(input: &str) -> String {
    let plus = input.replace('+'," "); let bytes=plus.as_bytes(); let mut out=Vec::with_capacity(bytes.len()); let mut i=0;
    while i<bytes.len() { if bytes[i]==b'%' {
        if i+2>=bytes.len() { return plus; }
        let hex = |c: u8| match c { b'0'..=b'9'=>Some(c-b'0'), b'a'..=b'f'=>Some(c-b'a'+10), b'A'..=b'F'=>Some(c-b'A'+10), _=>None };
        let (Some(a),Some(b))=(hex(bytes[i+1]),hex(bytes[i+2])) else { return plus; }; out.push(a*16+b); i+=3;
    } else { out.push(bytes[i]); i+=1; } }
    String::from_utf8(out).unwrap_or(plus)
}
fn segments(key: &str) -> Vec<String> {
    let mut result=Vec::new(); let first=key.find('[').unwrap_or(key.len());
    if first>0 { result.push(key[..first].to_owned()); }
    let mut open=if first<key.len() { Some(first) } else { None }; let mut count=0;
    while let Some(pos)=open {
        if count==5 { result.push(format!("[{}]", &key[pos..])); break; }
        let mut depth=1; let mut close=None;
        for (offset,ch) in key[pos+1..].char_indices() { if ch=='[' { depth+=1; } else if ch==']' { depth-=1; if depth==0 { close=Some(pos+1+offset); break; } } }
        let Some(end)=close else { result.push(format!("[{}]", &key[pos..])); break; };
        result.push(key[pos..=end].to_owned()); count+=1;
        open=key[end+1..].find('[').map(|i| end+1+i);
    }
    result
}
fn wrap(segment: &str, value: Q) -> Q {
    if segment=="[]" { return if matches!(&value,Q::Object(_,Some(_))) { value } else { combine(Q::Array(Vec::new()),value) }; }
    let bracket=segment.starts_with('[') && segment.ends_with(']');
    let key=if bracket { &segment[1..segment.len()-1] } else { segment };
    if bracket { if let Some(index)=index_key(key) {
        if index<1000.0 { let index=index as usize; let mut a=vec![None;index+1]; a[index]=Some(value); return Q::Array(a); }
        return Q::Object(vec![(key.into(),value)],Some(index));
    } }
    if key=="__proto__" { Q::Object(Vec::new(),None) } else { Q::Object(vec![(key.into(),value)],None) }
}
fn compact(value: Q) -> Q {
    match value { Q::Array(a)=>Q::Array(a.into_iter().flatten().map(|v| Some(compact(v))).collect()), Q::Object(o,n)=>Q::Object(o.into_iter().map(|(k,v)|(k,compact(v))).collect(),n), v=>v }
}
fn query_values(raw: Option<&str>) -> (Option<Q>,Option<Q>) {
    // qs replaces encoded brackets before finding ]=, then groups duplicate keys
    // before parsing/merging. Parameter limit includes unrelated keys.
    let raw=raw.unwrap_or(""); let mut normalized=String::with_capacity(raw.len()); let b=raw.as_bytes(); let mut i=0;
    while i<b.len() { if i+2<b.len() && b[i]==b'%' && b[i+1]==b'5' && (b[i+2]==b'B'||b[i+2]==b'b'||b[i+2]==b'D'||b[i+2]==b'd') { normalized.push(if b[i+2].eq_ignore_ascii_case(&b'b') {'['} else {']'}); i+=3; } else { let ch=raw[i..].chars().next().unwrap(); normalized.push(ch); i+=ch.len_utf8(); } }
    let mut grouped: Vec<(String,Q)>=Vec::new();
    for part in normalized.split('&').take(1000) {
        let split=part.find("]=").map(|i|i+1).or_else(||part.find('='));
        let (key,val)=match split { Some(i)=>(&part[..i],&part[i+1..]), None=>(part,"") };
        let key=decode(key); if key.is_empty() { continue; }
        let value=Q::Text(decode(val));
        if let Some((_,old))=grouped.iter_mut().find(|(k,_)| *k==key) { *old=combine(old.clone(),value); } else { grouped.push((key,value)); }
    }
    let mut state=None; let mut action=None;
    for (key,value) in grouped {
        let mut chain=segments(&key); if chain.is_empty() { continue; }
        let root=chain.remove(0); if root!="state" && root!="action" { continue; }
        let mut value=value; for segment in chain.into_iter().rev() { value=wrap(&segment,value); }
        let slot=if root=="state" { &mut state } else { &mut action };
        *slot=Some(match slot.take() { Some(old)=>merge(old,value),None=>value });
    }
    (state.map(compact),action.map(compact))
}

pub const TWITCH_AUTH_SCOPES: &[&str] = &[
    "analytics:read:extensions", "analytics:read:games", "bits:read", "channel:manage:ads", "channel:read:ads", "channel:manage:broadcast", "channel:read:charity", "channel:edit:commercial", "channel:read:editors", "channel:manage:extensions", "channel:read:goals", "channel:read:guest_star", "channel:manage:guest_star", "channel:read:hype_train", "channel:manage:moderators", "channel:read:polls", "channel:manage:polls", "channel:read:predictions", "channel:manage:predictions", "channel:manage:raids", "channel:read:redemptions", "channel:manage:redemptions", "channel:manage:schedule", "channel:read:subscriptions", "channel:manage:videos", "channel:read:vips", "channel:manage:vips", "clips:edit", "moderation:read", "moderator:manage:announcements", "moderator:manage:automod", "moderator:read:automod_settings", "moderator:manage:automod_settings", "moderator:manage:banned_users", "moderator:read:blocked_terms", "moderator:manage:blocked_terms", "moderator:read:chat_messages", "moderator:manage:chat_messages", "moderator:read:chat_settings", "moderator:manage:chat_settings", "moderator:read:chatters", "moderator:read:followers", "moderator:read:guest_star", "moderator:manage:guest_star", "moderator:read:shield_mode", "moderator:manage:shield_mode", "moderator:read:shoutouts", "moderator:manage:shoutouts", "user:edit", "user:edit:follows", "user:read:blocked_users", "user:manage:blocked_users", "user:read:broadcast", "user:manage:chat_color", "user:read:email", "user:read:follows", "user:read:subscriptions", "user:manage:whispers", "channel:bot", "channel:moderate", "chat:edit", "chat:read", "user:bot", "user:read:chat", "whispers:read", "whispers:edit", "user:write:chat", "channel:manage:clips", "moderator:read:suspicious_users", "moderator:read:unban_requests", "moderator:manage:unban_requests", "moderator:read:warnings", "moderator:manage:warnings"
];

// Existing email route helpers are private; consolidate at integration.
fn encode_url(s: &str) -> String {
    let bytes = s.as_bytes(); let mut out = String::new();
    for (i, &b) in bytes.iter().enumerate() {
        let valid_percent = b == b'%' && i + 1 < bytes.len() && bytes[i+1].is_ascii_hexdigit() && (i + 2 == bytes.len() || bytes[i+2].is_ascii_hexdigit());
        let safe = matches!(b, 0x21 | 0x23..=0x3b | 0x3d | 0x3f..=0x5f | 0x61..=0x7a | 0x7c | 0x7e) && (b != b'%' || valid_percent);
        if safe { out.push(b as char) } else { out.push_str(&format!("%{b:02X}")) }
    } out
}
#[derive(Clone, Copy)]
struct Priority { q: f64, specificity: u8, order: usize, provided: usize }
fn split_quoted(input: &str, delimiter: char) -> Vec<&str> {
    let mut result = Vec::new(); let mut start = 0; let mut quoted = false;
    for (index, ch) in input.char_indices() { if ch == '"' { quoted = !quoted } else if ch == delimiter && !quoted { result.push(&input[start..index]); start = index + ch.len_utf8(); } }
    result.push(&input[start..]); result
}
fn parse_float_prefix(s: &str) -> f64 {
    let s = s.trim_start(); for end in (1..=s.len()).rev() { if s.is_char_boundary(end) { if let Ok(v) = s[..end].parse::<f64>() { return v } } } f64::NAN
}
fn negotiate(accept: Option<&str>) -> Option<&'static str> {
    let accept = accept.filter(|s| !s.is_empty()).unwrap_or("*/*"); let mut best: [Option<Priority>; 2] = [None, None];
    for (order, raw) in split_quoted(accept, ',').into_iter().enumerate() {
        let mut parts = split_quoted(raw.trim(), ';').into_iter(); let Some(media) = parts.next() else { continue }; let Some((ty, sub)) = media.trim().split_once('/') else { continue };
        if ty.is_empty() || sub.is_empty() || ty.chars().any(char::is_whitespace) || sub.chars().any(char::is_whitespace) { continue }
        let mut q = 1.0; let mut params = Vec::new();
        for part in parts { let (key, val) = part.trim().split_once('=').unwrap_or((part.trim(), "")); let val = val.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(val); if key.eq_ignore_ascii_case("q") { q = parse_float_prefix(val); break } params.push(val); }
        for (provided, subtype) in ["plain", "html"].into_iter().enumerate() {
            if !ty.eq_ignore_ascii_case("text") && ty != "*" { continue } if !sub.eq_ignore_ascii_case(subtype) && sub != "*" { continue }
            if params.iter().any(|value| !value.is_empty() && *value != "*") { continue }
            let specificity = (if ty.eq_ignore_ascii_case("text") {4} else {0}) | (if sub.eq_ignore_ascii_case(subtype) {2} else {0}) | (if params.is_empty() {0} else {1});
            let p = Priority { q, specificity, order, provided };
            if best[provided].is_none_or(|old| specificity > old.specificity || (specificity == old.specificity && (q > old.q || ((q == old.q || q.is_nan() || old.q.is_nan()) && order > old.order)))) { best[provided] = Some(p); }
        }
    }
    let mut choices: Vec<_> = best.into_iter().flatten().filter(|p| p.q > 0.0).collect();
    choices.sort_by(|a,b| b.q.total_cmp(&a.q).then(b.specificity.cmp(&a.specificity)).then(a.order.cmp(&b.order)).then(a.provided.cmp(&b.provided)));
    choices.first().map(|p| if p.provided == 0 { "text/plain; charset=utf-8" } else { "text/html; charset=utf-8" })
}
async fn authorize(State(service): State<AuthorizeRoute>, RawQuery(query): RawQuery, headers: HeaderMap) -> Response {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let location = match service.location(query.as_deref(), host) {
        Ok(Some(location)) => location,
        Ok(None) => return (StatusCode::BAD_REQUEST, [(header::CONTENT_TYPE, "application/json; charset=utf-8")], r#"{"error":true,"message":"Missing state","status":400}"#).into_response(),
        // Express 4 leaves this rejected async handler without a response. A native
        // HTTP server must choose a bounded outcome; surface a 500 instead of hanging.
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let accept = headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()); let content_type = negotiate(accept);
    let body = match content_type { Some("text/plain; charset=utf-8") => format!("Found. Redirecting to {location}"), Some(_) => { let escaped = location.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;"); format!("<p>Found. Redirecting to {escaped}</p>") }, None => String::new() };
    let mut response = (StatusCode::FOUND, body.clone()).into_response();
    if let Ok(value) = location.parse() { response.headers_mut().insert(header::LOCATION, value); }
    response.headers_mut().insert(header::VARY, "Accept".parse().unwrap());
    response.headers_mut().insert(header::CONTENT_LENGTH, body.len().to_string().parse().unwrap());
    if let Some(value) = content_type { response.headers_mut().insert(header::CONTENT_TYPE, value.parse().unwrap()); } else { response.headers_mut().remove(header::CONTENT_TYPE); }
    response
}

#[cfg(test)]
mod index_tests {
    use super::*;
    #[test]
    fn binary64_indices_and_overflow_merges_are_bounded() {
        assert_eq!(index_key("9007199254740991"), Some(9_007_199_254_740_991.0));
        assert_eq!(index_key("9007199254740992"), Some(9_007_199_254_740_992.0));
        assert_eq!(index_key("9007199254740993"), None);
        assert_eq!(index_key("18446744073709551615"), None);
        assert_eq!(index_key("18446744073709552000"), Some(18_446_744_073_709_552_000.0));
        assert_eq!(index_key("100000000000000000000"), Some(100_000_000_000_000_000_000.0));
        assert_eq!(index_key("1e+21"), None);
        assert_eq!(index_key("1000.0"), None);
        assert!(parse_int10(&"9".repeat(400)).is_infinite());
        let merged = merge(Q::Text("a".into()), Q::Object(vec![("9007199254740992".into(),Q::Text("b".into()))], Some(9_007_199_254_740_992.0)));
        let Q::Object(fields,Some(max)) = merged else { panic!("overflow object") };
        assert_eq!(max,9_007_199_254_740_992.0);
        assert!(fields.iter().any(|(k,_)| k == "9007199254740992"));
        let merged = merge(Q::Object(vec![],Some(f64::MAX)), Q::Text("v".into()));
        let Q::Object(fields,Some(max)) = merged else { panic!("overflow object") };
        assert_eq!(max,f64::MAX);
        assert_eq!(fields[0].0,number_string(f64::MAX));
        for value in ["18446744073709551615", "18446744073709552000", "100000000000000000000", "1e%2B100"] {
            let query = format!("state=a&state[{value}]=b&state=c");
            let _ = AuthorizeRoute::new(None).location(Some(&query),None);
        }
    }
}
