//! Import plans retain source boundaries until root-context eligibility is
//! settled. Whole-tree cloning and repeated prefix parsing are unnecessary.
use super::{
    from_ast::{count_nodes, eligible},
    validate::Ids,
    *,
};

struct Plan<'a> {
    source: &'a str,
    origin: Origin,
    nodes: Vec<BlockNode>,
    editable: bool,
    raw: bool,
}
impl Plan<'_> {
    fn fallback(&mut self, next: &mut dyn FnMut() -> String) -> bool {
        if !self.editable {
            return false;
        }
        self.nodes = vec![BlockNode {
            id: next(),
            kind: BlockKind::Raw {
                source: self.source.to_owned(),
            },
            origin: self.origin.clone(),
            diagnostic_id: None,
            text_pieces: Vec::new(),
        }];
        self.editable = false;
        self.raw = true;
        true
    }
}

// A two-state transducer records whether a literal run ends in an odd number
// of backslashes, and which source expression supplied the last odd part.
// Combining summaries is constant work. A point update after raw fallback is
// logarithmic; each source expression falls back at most once.
const EXTERNAL: usize = usize::MAX;
#[derive(Clone, Copy)]
struct Step {
    trailing: Option<usize>,
    bad: Option<usize>,
}
#[derive(Clone, Copy)]
struct Summary([Step; 2]);
impl Summary {
    fn identity() -> Self {
        Self([
            Step {
                trailing: None,
                bad: None,
            },
            Step {
                trailing: Some(EXTERNAL),
                bad: None,
            },
        ])
    }
    fn plan(plan: &Plan<'_>, owner: usize) -> Self {
        let mut summary = Self::identity();
        for step in &mut summary.0 {
            for node in &plan.nodes {
                if let BlockKind::Literal { value } = &node.kind {
                    let odd = value.bytes().rev().take_while(|b| *b == b'\\').count() % 2 == 1;
                    if value.bytes().all(|b| b == b'\\') {
                        if odd {
                            step.trailing = if step.trailing.is_some() {
                                None
                            } else {
                                Some(owner)
                            };
                        }
                    } else {
                        step.trailing = if odd { Some(owner) } else { None };
                    }
                } else {
                    step.bad = step.bad.or(step.trailing);
                    step.trailing = None;
                }
            }
        }
        summary
    }
    fn combine(left: Self, right: Self) -> Self {
        let mut result = Self::identity();
        for (incoming, step) in result.0.iter_mut().enumerate() {
            let a = left.0[incoming];
            let b = right.0[usize::from(a.trailing.is_some())];
            let resolve = |owner| {
                if owner == Some(EXTERNAL) {
                    a.trailing
                } else {
                    owner
                }
            };
            *step = Step {
                trailing: resolve(b.trailing),
                bad: a.bad.or(resolve(b.bad)),
            };
        }
        result
    }
}
struct Boundaries {
    base: usize,
    tree: Vec<Summary>,
}
impl Boundaries {
    fn new(plans: &[Plan<'_>]) -> Self {
        let base = plans.len().max(1).next_power_of_two();
        let mut tree = vec![Summary::identity(); 2 * base];
        for (owner, plan) in plans.iter().enumerate() {
            tree[base + owner] = Summary::plan(plan, owner);
        }
        for at in (1..base).rev() {
            tree[at] = Summary::combine(tree[2 * at], tree[2 * at + 1]);
        }
        Self { base, tree }
    }
    fn update(&mut self, owner: usize, plan: &Plan<'_>) {
        let mut at = self.base + owner;
        self.tree[at] = Summary::plan(plan, owner);
        while at > 1 {
            at /= 2;
            self.tree[at] = Summary::combine(self.tree[2 * at], self.tree[2 * at + 1]);
        }
    }
    fn repair(&mut self, plans: &mut [Plan<'_>], next: &mut dyn FnMut() -> String) {
        while let Some(owner) = self.tree[1].0[0].bad {
            // Plain source text may have an unavoidable rendering quirk; leave
            // its diagnostic to the final check rather than rewriting text.
            if !plans[owner].fallback(next) {
                break;
            }
            self.update(owner, &plans[owner]);
        }
    }
}
fn references<'a>(plans: &'a [Plan<'_>]) -> Vec<&'a BlockNode> {
    plans.iter().flat_map(|plan| plan.nodes.iter()).collect()
}
/// Backslash/sigil pairs in a joined literal run cannot be rendered literally.
/// Mark expression-derived contributors for raw fallback; replacement only
/// breaks literal runs, so it cannot introduce another such pair.
fn literal_fallbacks(plans: &[Plan<'_>]) -> Vec<usize> {
    let mut affected = vec![false; plans.len()];
    let mut previous: Option<(char, usize)> = None;
    for (owner, plan) in plans.iter().enumerate() {
        for node in &plan.nodes {
            if let BlockKind::Literal { value } = &node.kind {
                for ch in value.chars() {
                    if let Some((previous_char, previous_owner)) = previous
                        && previous_char == '\\'
                        && matches!(ch, '$' | '%' | '*' | '#' | '^')
                    {
                        if plans[previous_owner].editable {
                            affected[previous_owner] = true;
                        } else if plan.editable {
                            affected[owner] = true;
                        }
                    }
                    previous = Some((ch, owner));
                }
            } else {
                previous = None;
            }
        }
    }
    affected
        .into_iter()
        .enumerate()
        .filter_map(|(i, yes)| yes.then_some(i))
        .collect()
}

pub(super) fn import(
    engine: &BlocksEngine,
    text: &str,
    factory: &mut dyn FnMut() -> String,
) -> Result<ImportedText, BlocksError> {
    let length = units(text);
    if length > MAX_COMMAND_TEXT {
        return Err(BlocksError::at(
            BlocksErrorCode::TextLimit,
            format!("This text is too long ({length} of {MAX_COMMAND_TEXT} characters)."),
            None,
            &Origin::default(),
        ));
    }
    let mut op = Operation::new(&engine.syntax);
    let segments = engine.syntax.scan_template(text).map_err(syntax_error)?;
    let mut ids = Ids::default();
    let mut next = || ids.fresh(Some(factory()));
    let mut plans = Vec::with_capacity(segments.len());
    let mut used_nodes: usize = 0;
    let mut used_output: usize = 0;
    let mut remaining_source = length;
    for (i, segment) in segments.iter().enumerate() {
        let source = segment.raw_text();
        remaining_source = remaining_source.saturating_sub(units(source));
        let origin = Origin::default().child("children").child(i.to_string());
        let mut plan = Plan {
            source,
            origin: origin.clone(),
            nodes: Vec::new(),
            editable: false,
            raw: false,
        };
        if let SourceSegment::Text { text, .. } = segment {
            plan.nodes.push(BlockNode {
                id: next(),
                kind: BlockKind::Literal {
                    value: unescape_rendered_text(text),
                },
                origin,
                diagnostic_id: None,
                text_pieces: Vec::new(),
            });
            let mut writer = Writer::new(rules());
            writer.root_nodes(&plan.nodes.iter().collect::<Vec<_>>())?;
            used_output += writer.units;
            writer.finish(&mut op.stats)?;
        } else {
            if matches!(segment, SourceSegment::Expr { .. })
                && let Some(block) = op.expression(source, Some(&mut next), origin.clone())?
            {
                let mut writer = Writer::new(rules());
                if writer.top(&block).is_ok()
                    && let Ok(generated) = writer.finish(&mut op.stats)
                    && engine.round_trip(&block, source, &generated, &mut op)?
                {
                    // Root grammar dequotes literals and spreads templates.
                    // Eligibility/output must use that actual context as well
                    // as the whole-expression structural round-trip guard.
                    let root = normalize_root(BlockRoot {
                        id: String::new(),
                        kind: RootTag::Root,
                        children: vec![block],
                    });
                    plan.nodes = root.children;
                    // Only final root fragments consume block depth/node
                    // quotas; the spread template is a transient wrapper.
                    plan.editable = plan.nodes.iter().all(eligible);
                }
            }
            let mut accepted = false;
            if plan.editable {
                let count = plan.nodes.iter().map(count_nodes).sum::<usize>();
                let mut writer = Writer::new(rules());
                writer.root_nodes(&plan.nodes.iter().collect::<Vec<_>>())?;
                let output = writer.units;
                if writer.finish(&mut op.stats).is_ok()
                    && used_nodes
                        .saturating_add(count)
                        .saturating_add(segments.len() - i - 1)
                        <= MAX_BLOCK_NODES
                    && used_output
                        .saturating_add(output)
                        .saturating_add(remaining_source)
                        <= MAX_COMMAND_TEXT
                {
                    used_output += output;
                    accepted = true;
                }
            }
            if !accepted {
                // Also initializes the raw plan for unclosed/unsupported pieces.
                plan.editable = true;
                plan.fallback(&mut next);
                used_output += units(source);
            }
        }
        used_nodes += plan.nodes.iter().map(count_nodes).sum::<usize>();
        if used_nodes > MAX_BLOCK_NODES {
            return Err(BlocksError::at(
                BlocksErrorCode::NodeLimit,
                format!("Too many blocks (limit {MAX_BLOCK_NODES})."),
                None,
                &plan.origin,
            ));
        }
        plans.push(plan);
    }
    let mut boundaries = Boundaries::new(&plans);
    for owner in literal_fallbacks(&plans) {
        plans[owner].fallback(&mut next);
        boundaries.update(owner, &plans[owner]);
    }
    boundaries.repair(&mut plans, &mut next);

    let mut writer = Writer::with_contributions(rules(), plans.len());
    writer.root_nodes(&references(&plans))?;
    let contributions = writer
        .contributions
        .take()
        .expect("import accounting enabled");
    let rendered = writer.finish(&mut op.stats);
    let generated = match rendered {
        Ok(text) => text,
        Err(error) => {
            // Context joins can add an escape, or an earlier boundary repair
            // can restore an expression's original wrapper. Fall back the
            // expressions whose actual output exceeds their original source.
            // All other contributions can only stay equal or shrink when raw
            // separators break literal runs. This requires one bounded second
            // output pass, not repeated prefix rescans or tree reconstruction.
            let mut changed = false;
            for (owner, contribution) in contributions.into_iter().enumerate() {
                if contribution > units(plans[owner].source) && plans[owner].fallback(&mut next) {
                    boundaries.update(owner, &plans[owner]);
                    changed = true;
                }
            }
            if !changed {
                return Err(error);
            }
            boundaries.repair(&mut plans, &mut next);
            let mut writer = Writer::new(rules());
            writer.root_nodes(&references(&plans))?;
            writer.finish(&mut op.stats)?
        }
    };
    let advanced_count = plans.iter().filter(|plan| plan.raw).count();
    let children = plans.into_iter().flat_map(|plan| plan.nodes).collect();
    // Every plan is already normalized. Only the final adjacent-text merge
    // remains; move those nodes and their provenance rather than clone/reparse.
    let root = BlockRoot {
        id: next(),
        kind: RootTag::Root,
        children: normalize::merge(children),
    };
    let mut diagnostics = Vec::new();
    if root.children.is_empty() {
        diagnostics.push(BlocksError::at(
            BlocksErrorCode::EmptyRoot,
            "Add at least one block.",
            None,
            &Origin::default().child("children"),
        ));
    } else if let Err(error) = engine.check_root(&root, &generated, &mut op, false) {
        if error.code == BlocksErrorCode::LiteralEscape {
            diagnostics.push(error);
        } else {
            return Err(error);
        }
    }
    Ok(ImportedText {
        root,
        advanced_count,
        stats: op.stats,
        diagnostics,
    })
}
