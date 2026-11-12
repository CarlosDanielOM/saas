//! Bounded cursor walks; pagination boundaries are deliberately not compared.
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scan {
    pub cursor: String,
    pub items: String,
    pub identity: String,
    pub query: String,
    pub max_pages: usize,
    #[serde(default)]
    pub ttl: Option<String>,
}
impl Scan {
    pub fn validate(&self) -> Result<(), String> {
        if [self.cursor.as_str(), self.items.as_str()]
            .iter()
            .any(|p| !p.starts_with('/'))
            || (!self.identity.is_empty() && !self.identity.starts_with('/'))
            || self.ttl.as_ref().is_some_and(|p| !p.starts_with('/'))
            || self.cursor == self.items
            || self.query.is_empty()
            || !(1..=1000).contains(&self.max_pages)
        {
            return Err("scan requires distinct cursor/items JSON pointers, an identity pointer, a query parameter and max_pages in 1..=1000".into());
        }
        Ok(())
    }
    pub fn page(
        &self,
        body: &Value,
        union: &mut BTreeMap<String, Value>,
    ) -> Result<String, String> {
        let cursor = body
            .pointer(&self.cursor)
            .and_then(|v| {
                v.as_str()
                    .map(str::to_string)
                    .or_else(|| v.as_u64().map(|n| n.to_string()))
            })
            .ok_or_else(|| {
                format!(
                    "scan: {} must hold a string or unsigned cursor",
                    self.cursor
                )
            })?;
        let items = body
            .pointer(&self.items)
            .and_then(Value::as_array)
            .ok_or_else(|| format!("scan: {} must hold an array", self.items))?;
        for item in items {
            let id = item
                .pointer(&self.identity)
                .filter(|v| v.is_string() || v.is_number())
                .ok_or_else(|| {
                    format!("scan: an item has no scalar identity at {}", self.identity)
                })?;
            union.insert(id.to_string(), item.clone());
            if union.len() > 20_000 {
                return Err("scan union exceeds 20000 items".into());
            }
        }
        Ok(cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn spec() -> Scan {
        Scan {
            cursor: "/cursor".into(),
            items: "/keys".into(),
            identity: "".into(),
            query: "cursor".into(),
            max_pages: 10,
            ttl: None,
        }
    }
    #[test]
    fn union_deduplicates_and_orders_primitive_keys() {
        let scan = spec();
        assert!(scan.validate().is_ok());
        let mut union = BTreeMap::new();
        assert_eq!(
            scan.page(&json!({"cursor": "next", "keys": ["b", "a"]}), &mut union)
                .unwrap(),
            "next"
        );
        assert_eq!(
            scan.page(&json!({"cursor": 0, "keys": ["b", "c"]}), &mut union)
                .unwrap(),
            "0"
        );
        assert_eq!(
            union.into_values().collect::<Vec<_>>(),
            vec![json!("a"), json!("b"), json!("c")]
        );
    }
    #[test]
    fn malformed_pages_and_unbounded_walks_fail() {
        let mut scan = spec();
        let mut union = BTreeMap::new();
        assert!(
            scan.page(&json!({"keys": []}), &mut union)
                .unwrap_err()
                .contains("cursor")
        );
        assert!(
            scan.page(&json!({"cursor": "0", "keys": [null]}), &mut union)
                .unwrap_err()
                .contains("identity")
        );
        scan.max_pages = 0;
        assert!(scan.validate().is_err());
    }
}
