//! An insertion-ordered map with JavaScript `Map` semantics: setting an existing key keeps its
//! position, deleting removes it, iteration follows insertion order.

use std::borrow::Borrow;
use std::collections::HashMap;
use std::hash::Hash;

/// Insertion-ordered map (`Map` in the reference). Lookups are hashed; deletion is linear in the
/// map's size, which is fine for variables (they are rarely deleted).
#[derive(Clone, Debug, PartialEq)]
pub struct OrderedMap<K: Eq + Hash, V> {
    entries: Vec<(K, V)>,
    index: HashMap<K, usize>,
}

impl<K: Eq + Hash, V> Default for OrderedMap<K, V> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            index: HashMap::new(),
        }
    }
}

impl<K: Eq + Hash + Clone, V> OrderedMap<K, V> {
    /// An empty map.
    pub fn new() -> Self {
        Self::default()
    }

    /// The value for `key`.
    pub fn get<Q>(&self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
        let at = *self.index.get(key)?;
        self.entries.get(at).map(|(_, value)| value)
    }

    /// Whether `key` is present.
    pub fn contains_key<Q>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
        self.index.contains_key(key)
    }

    /// Sets `key` (`map.set`): an existing key keeps its position.
    pub fn insert(&mut self, key: K, value: V) {
        if let Some(at) = self.index.get(&key).copied() {
            if let Some(slot) = self.entries.get_mut(at) {
                slot.1 = value;
            }
            return;
        }
        self.index.insert(key.clone(), self.entries.len());
        self.entries.push((key, value));
    }

    /// Deletes `key` (`map.delete`), returning its value.
    pub fn remove<Q>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
        let at = self.index.remove(key)?;
        if at >= self.entries.len() {
            return None;
        }
        let (_, value) = self.entries.remove(at);
        for slot in self.index.values_mut() {
            if *slot > at {
                *slot -= 1;
            }
        }
        Some(value)
    }

    /// Entries in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    /// Number of entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the map is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl<K: Eq + Hash + Clone, V> FromIterator<(K, V)> for OrderedMap<K, V> {
    fn from_iter<I: IntoIterator<Item = (K, V)>>(iter: I) -> Self {
        let mut map = Self::new();
        for (key, value) in iter {
            map.insert(key, value);
        }
        map
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn behaves_like_a_javascript_map() {
        let mut map: OrderedMap<String, i32> = OrderedMap::new();
        map.insert("b".into(), 1);
        map.insert("a".into(), 2);
        map.insert("b".into(), 3);
        assert_eq!(
            map.iter().collect::<Vec<_>>(),
            [(&"b".into(), &3), (&"a".into(), &2)]
        );
        assert_eq!(map.remove("b"), Some(3));
        map.insert("b".into(), 4);
        assert_eq!(
            map.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(map.get("a"), Some(&2));
        assert!(!map.contains_key("c"));
        assert_eq!(map.len(), 2);
    }
}
