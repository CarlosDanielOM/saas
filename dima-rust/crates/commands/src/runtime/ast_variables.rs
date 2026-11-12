//! The plan of the one-off migration that merges per-scope command-language variables into one
//! global scope per user (reference: `utils/ast_variable_migration.ts`, used by
//! `scripts/migrate_ast_variables_global.script.ts`; the script itself is not ported, see
//! `ledger/upper-layers.md` section 7, question 8). Pure.

use std::cmp::Ordering;
use std::collections::HashMap;

/// One stored `astvariables` row as the plan reads it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LegacyAstVariables {
    /// `channelID`.
    pub channel_id: String,
    /// `scopeType`.
    pub scope_type: String,
    /// `scopeName`.
    pub scope_name: String,
    /// `userId`.
    pub user_id: String,
    /// `userLogin`.
    pub user_login: String,
    /// `variables`, in stored order.
    pub variables: Vec<(String, String)>,
    /// `updatedAt` in epoch milliseconds, when present.
    pub updated_at_ms: Option<i64>,
    /// `String(_id)`, when present.
    pub id: Option<String>,
}

/// One global row the migration writes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GlobalAstVariables {
    /// `channelID`.
    pub channel_id: String,
    /// `userId` (`''` when the rows had none).
    pub user_id: String,
    /// `userLogin`, lowercased.
    pub user_login: String,
    /// The merged variables, in JavaScript property order (integer-like names first).
    pub variables: Vec<(String, String)>,
}

impl GlobalAstVariables {
    /// `scopeType` and `scopeName` of every planned row.
    pub const SCOPE: &'static str = "global";
}

/// `planGlobalAstVariables(rows)`: the non-global rows, newest first (`updatedAt`, then
/// `String(_id)` descending with `localeCompare`, ICU collation), grouped by channel and user
/// id (or lowercased login when the id is empty); for each variable name the newest row's value
/// wins. Groups in first-seen order.
pub fn plan_global_ast_variables(
    rows: &[LegacyAstVariables],
    collator: &dima_text::Collator,
) -> Vec<GlobalAstVariables> {
    let mut sorted: Vec<&LegacyAstVariables> =
        rows.iter().filter(|row| row.scope_type != "global").collect();
    sorted.sort_by(|a, b| {
        let by_time = b.updated_at_ms.unwrap_or(0).cmp(&a.updated_at_ms.unwrap_or(0));
        if by_time != Ordering::Equal {
            return by_time;
        }
        collator.compare(
            b.id.as_deref().unwrap_or_default(),
            a.id.as_deref().unwrap_or_default(),
        )
    });
    let mut groups: Vec<(GlobalAstVariables, Vec<(String, String)>)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for row in sorted {
        let user_login = dima_text::to_lower(&row.user_login);
        let identity = if row.user_id.is_empty() {
            format!("login:{user_login}")
        } else {
            row.user_id.clone()
        };
        let key = format!("{}\0{identity}", row.channel_id);
        let slot = *index.entry(key).or_insert_with(|| {
            groups.push((
                GlobalAstVariables {
                    channel_id: row.channel_id.clone(),
                    user_id: row.user_id.clone(),
                    user_login: user_login.clone(),
                    variables: Vec::new(),
                },
                Vec::new(),
            ));
            groups.len() - 1
        });
        let Some((_, variables)) = groups.get_mut(slot) else {
            continue;
        };
        let names: Vec<&str> = row.variables.iter().map(|(name, _)| name.as_str()).collect();
        for name in dima_text::js_property_order(names) {
            if variables.iter().any(|(known, _)| known == name) {
                continue;
            }
            if let Some((_, value)) = row.variables.iter().find(|(known, _)| known == name) {
                variables.push((name.to_owned(), value.clone()));
            }
        }
    }
    groups
        .into_iter()
        .map(|(mut group, variables)| {
            let order = dima_text::js_property_order(
                variables.iter().map(|(name, _)| name.as_str()).collect(),
            )
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
            group.variables = order
                .into_iter()
                .filter_map(|name| {
                    variables
                        .iter()
                        .find(|(known, _)| *known == name)
                        .map(|(_, value)| (name, value.clone()))
                })
                .collect();
            group
        })
        .collect()
}
