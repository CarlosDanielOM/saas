# Tag Permission System — File Plan

Status: **planning only — not implemented.**
Audience: the implementing agent and human reviewers.
Scope: add a boolean **role-tag expression** permission layer **on top of** the existing numeric user-level system, for (a) chat commands and (b) chat-moderation rule exemptions.

This document is the source of truth for the implementation. Read the root `AGENTS.md` and each project's `AGENTS.md` before editing.

---

## 1. Locked decisions (from planning Q&A)

| # | Decision | Value |
|---|----------|-------|
| 1 | Multi-role matching | Resolve the chatter's **full role set**; "any held role matches". A mod who is also subscribed holds both `mod` and `sub`. |
| 2 | Combination | **Full boolean expression tree** — nested `and` / `or` / `not`. |
| 3 | Deny | Optional, expressed via `not` inside the tree. |
| 4 | Permission modes | Level mode and tag mode are exclusive per command/rule. `null` or a missing expression means level mode; a valid expression means tag mode. The numeric fields remain stored while tag mode is active but are inert. |
| 5 | Invalid stored expression | A present, non-`null` expression that fails validation is a configuration error and **fails closed**. A command is denied; a moderation rule grants no exemption. It never falls back to the stored numeric level. No configurable runtime fallback is added this phase; the streamer repairs the expression or explicitly switches to level mode. |
| 6 | Tag vocabulary | Flat: `everyone`, `sub`, `vip`, `founder`, `mod`, `editor`, `admin`, `broadcaster`. |
| 7 | Role inheritance | `founder` also implies `sub`. Within a valid expression, `broadcaster` **always matches everything** (global override). Invalid stored configuration still fails closed so it can be repaired rather than silently executed. |
| 8 | Empty expression | There is no valid empty tag expression. Missing/`null` selects level mode; `{}`, empty `and`, and empty `or` are invalid and fail closed if found in storage. |
| 9 | `everyone` tag | Exists and must be selected explicitly for tag-mode access by everyone. `{role:'everyone'}` is true for every user; `not(everyone)` is true for nobody (except the broadcaster override in a valid expression). |
| 10 | Command management auth | Level-mode commands: unchanged (`callerLevel >= command.userLevel`). **Tag-mode commands: manage (create/edit/delete) requires `callerLevel >= 7`** (mod/editor/admin/broadcaster). |
| 11 | Reserved commands | Keep numeric seeding; no change. |
| 12 | AI/AST `minUserLevel` | Stays numeric this phase. Out of scope. |
| 13 | AST execution identity | LLM-generated AST uses the real identity of the user talking to the AI. Streamer-authored command/event/timer/redemption AST is trusted and executes with an explicit broadcaster identity, after its outer command/event gate. Never infer authorization from a synthetic event with empty badges. |
| 14 | Chat `-ul=` | Allowed for level-mode commands only. `!ec ... -ul=` against a tag-mode command is rejected with instructions to switch modes in the dashboard. It does not silently alter the inactive fallback fields or clear the expression. |
| 15 | Permission display | The API returns the expression tree, not localized prose. Dimasite produces permission descriptions with `LanguageService` and the current locale. |
| 16 | CDOM Labs admin site | The separate `admin/` application is internal tooling for CDOM Labs workers and is deferred. DomDimaBot channel admins configure permissions in `dimasite`; do not mix the two admin concepts. |

### Semantics of important expressions

- `{role:'everyone'}` → always true.
- `not({role:'everyone'})` → true for nobody (no non-broadcaster user satisfies it).
- `or(not(everyone), {role:'mod'})` → equivalent to "only mods".
- `{role:'sub'}` → strict: only users holding the `sub` tag (founders qualify; mods qualify only if they are also subscribed).
- `{level:7}` → legacy `identity.level >= 7`; editors/admins/broadcasters qualify. **Use this to preserve old behavior.** Converting a "mod" level command to `{role:'mod'}` *removes* editor/admin access — this must be documented in the editor UI.

---

## 2. Concepts

### 2.1 Identity resolution

A message author resolves to **both** a legacy numeric `level` and a full `tags` set. The numeric level logic must remain byte-for-byte equivalent to today's `giveUserLevel` (`dimabot/src/handlers/message.handler.ts:778-814`).

```ts
// dimabot/src/utils/permissions/roles.ts
export const ROLE_TAGS = [
  'everyone', 'sub', 'vip', 'founder', 'mod', 'editor', 'admin', 'broadcaster'
] as const;
export type RoleTag = (typeof ROLE_TAGS)[number];

export interface UserIdentity {
  level: number;            // legacy 1..10 max-level
  tags: Set<RoleTag>;       // full role set
}

export function isRoleTag(value: unknown): value is RoleTag;

export async function resolveUserIdentity(
  channelID: string,
  messageEventData: IChatMessage
): Promise<UserIdentity>;
```

Derivation (same role meaning and level math as today, with the cache namespace repaired):

| Source | level | tag(s) |
|--------|------:|--------|
| default | 1 | `everyone` |
| `subscriber` badge | 2 | `sub` |
| `founder` badge | 6 | `founder`, `sub` (implication) |
| `vip` badge | 5 | `vip` |
| moderator badges (`MODERATOR_BADGE_IDS`) | 7 | `mod` |
| Dragonfly `twitch:${channelID}:editors` | 8 | `editor` |
| Dragonfly `twitch:${channelID}:admins` | 9 | `admin` |
| `chatter_user_id === channelID` | 10 | `broadcaster` |

- `everyone` is always in the set.
- Apply all matching identities (do **not** collapse tags to the max role).
- `level` is still computed by sequential override (max), exactly as now.

`giveUserLevel` becomes a thin wrapper that calls `resolveUserIdentity` and returns `.level`, so all existing numeric call sites keep working during rollout.

#### Canonical Twitch role cache keys

All Twitch editor/admin producers and consumers use the `twitch:` namespace:

```text
twitch:${channelID}:editors       # normalized lowercase logins
twitch:${channelID}:editors:ids   # stable Twitch user IDs
twitch:${channelID}:admins        # normalized lowercase logins
twitch:${channelID}:admins:ids    # stable Twitch user IDs
twitch:${channelID}:admins:${id}  # admin detail hash
```

- `resolveUserIdentity` prefers the ID set and may use the normalized-login set as a compatibility fallback while caches repopulate.
- `getChannelEditors`, `loadChannelAdminsIntoCache`, admin add/remove routes, validation routes, stream lifecycle cleanup, and direct editor checks (`duel`, `vanish`, `ruletarusa`) must use these exact keys.
- Editor loading populates both login and ID sets. Admin mutations update/remove the canonical sets and detail hash immediately so revoked admins cannot retain a stale `admin` tag.
- Cache refresh/mutation paths delete their corresponding legacy non-`twitch:` keys. Do not keep dual writers.
- Tests cover add, remove, refresh, normalized-login fallback, and ID-first matching.

### 2.2 Expression grammar

```ts
// dimabot/src/utils/permissions/expression.ts
export type PermissionExpression =
  | { role: RoleTag }
  | { level: number }                      // legacy threshold leaf, 1..10
  | { not: PermissionExpression }
  | { and: PermissionExpression[] }
  | { or: PermissionExpression[] };
```

Evaluation rules (`evaluateExpression(expr, identity): boolean`):

1. **Broadcaster override:** if `identity.tags.has('broadcaster')` return `true` (documented global safety; also matches "broadcaster always matches everything").
2. `{role:'everyone'}` → `true`.
3. `{role: r}` (r ≠ everyone) → `identity.tags.has(r)`.
4. `{level: n}` → `identity.level >= n`.
5. `{not: e}` → `!evaluate(e, identity)`.
6. `{and: [...]}` → every child true. Empty arrays are invalid and never evaluated.
7. `{or: [...]}` → any child true. Empty arrays are invalid and never evaluated.

Validation (`validateExpression(input): { ok: true; value } | { ok: false; error }`):

- Exactly one discriminator key per node; reject mixed/unknown shapes and unknown fields.
- `role` must be in `ROLE_TAGS`; `level` must be an integer 1..10.
- `and`/`or` must be arrays with ≥ 1 child (editor always starts with 2).
- Bounds: `MAX_DEPTH = 4`, `MAX_NODES = 25`.
- Define depth consistently with the root at depth `1`; reject a child that would exceed `MAX_DEPTH`.
- Validation is also the sanitizer for all API ingress (expressions are user-supplied and evaluated server-side).
- `{role:'everyone'}` is the only tag-mode representation for universal access. The editor cannot save tag mode without at least one valid node.
- Backend code never generates localized descriptions. Dimasite describes a validated tree using i18n role/operator labels.

### 2.3 Gate helpers

```ts
// dimabot/src/utils/permissions/index.ts
export function isExpressionAllowed(expr: PermissionExpression, identity: UserIdentity): boolean;

export type ExpressionState =
  | { mode: 'level' }
  | { mode: 'tags'; expression: PermissionExpression }
  | { mode: 'invalid'; error: string };

export function inspectExpression(input: unknown): ExpressionState;

// null/missing => legacy numeric; valid => expression; present-invalid => denied
export function commandAllowed(command: { permissionExpression?: unknown; userLevel?: number }, identity: UserIdentity): boolean;

// null/missing => legacy numeric; valid => expression; present-invalid => no exemption
export function ruleExempt(rule: { exemptExpression?: unknown; exemptUserLevel?: number }, identity: UserIdentity): boolean;
```

`commandAllowed` / `ruleExempt` are the **only** approved way to authorize; no ad-hoc numeric comparisons should remain after the refactor (exception: timer management, see §4). Callers inspect/log the `invalid` state with channel, command/rule ID, and validation error, without logging the whole untrusted object.

Missing/`null` and invalid are deliberately different. An invalid tag tree never inherits a permissive legacy `userLevel`, even though the numeric fields remain stored for a future explicit mode switch.

### 2.4 AST authorization context

Every command execution path carries an explicit authorization identity and origin:

| Origin | Authorization identity | Reason |
|--------|------------------------|--------|
| Direct chat command | The chatter's resolved `UserIdentity` | The command policy governs the chatter. |
| LLM-generated AST while answering chat | The same real chatter identity passed into the AI context | AI actions must retain the requesting user's authority. Existing numeric function `minUserLevel` checks remain in force. |
| Streamer-authored command body / nested command reference | Explicit broadcaster identity (`level:10`, `everyone+broadcaster`) after the outer command passed | The streamer authored and trusted the command program. |
| Streamer-authored event/timer/redemption AST | Explicit broadcaster identity | These programs are streamer-authored and already use the trusted authored-AST model. |

`commandHandler` must receive this context explicitly. For an LLM command reference, it evaluates the referenced command's policy against the real chatter first; after that outer gate passes, the referenced streamer-authored body runs with the trusted broadcaster identity. The AST evaluator must not fabricate authorization from `fakeEventData.badges = []`. Tests must distinguish LLM AST from trusted authored AST so tightening nested-command enforcement does not accidentally remove the existing trusted automation behavior.

---

## 3. New backend files

| File | Purpose |
|------|---------|
| `dimabot/src/utils/permissions/roles.ts` | `ROLE_TAGS`, `RoleTag`, `UserIdentity`, `resolveUserIdentity`, `isRoleTag`. Reuses `MODERATOR_BADGE_IDS` and Dragonfly editor/admin sets. |
| `dimabot/src/utils/permissions/expression.ts` | `PermissionExpression` type, `validateExpression`, `inspectExpression`, `evaluateExpression`, depth/node bounds. |
| `dimabot/src/utils/permissions/index.ts` | `commandAllowed`, `ruleExempt`, `isExpressionAllowed`; re-exports. |
| `dimabot/src/utils/permissions/roles.test.ts` | Identity derivation tests. |
| `dimabot/src/utils/permissions/expression.test.ts` | Evaluation, validation, absent/invalid-state, and bounds matrix tests. |
| `dimabot/src/commands/command_list.command.test.ts` | `!commands` visibility with expressions + legacy + equality fix. |
| `dimabot/src/handlers/moderation.handler.test.ts` | Rule exemption via expression + legacy fallback (new file; no current handler test exists). |
| `dimabot/src/handlers/commands.handler.test.ts` | Direct/LLM/authored-AST identity behavior and nested command references. |
| `dimabot/src/utils/permissions/role_cache.test.ts` | Canonical editor/admin key population, removal, and ID/login resolution. |
| `ops/fixtures/permission-expressions.json` | Shared valid/invalid/evaluation fixtures consumed by backend and frontend checks. |

---

## 4. Backend modifications

### 4.1 Schemas

| File | Change |
|------|--------|
| `dimabot/src/schemas/commands.schema.ts` | Add `permissionExpression?: PermissionExpression \| null` to `ICommands` and `permissionExpression: { type: Schema.Types.Mixed, default: null }` to the schema. Keep `userLevel`/`userLevelName` untouched. |
| `dimabot/src/schemas/channel_moderation_settings.schema.ts` | Add `exemptExpression?: PermissionExpression \| null` to `IModerationRule` and `exemptExpression: { type: Schema.Types.Mixed, default: null }` to `moderationRuleSchema`. Keep `exemptUserLevel` and its 1..10 validation. |

Note: `Mixed` is untyped in Mongoose, so **all** reads must pass through `inspectExpression`. Only missing/`null` is level mode. A present invalid value fails closed and is surfaced as a configuration error; never evaluate it or treat it as absent.

### 4.2 Enforcement

| File:line | Current | Change |
|-----------|---------|--------|
| `dimabot/src/handlers/message.handler.ts:53,778-814` | `giveUserLevel` inline | Resolve `identity`; keep `giveUserLevel` wrapper for other callers. Pass `identity` where tags are needed. |
| `dimabot/src/handlers/message.handler.ts:356` | `if (userLevel < parseInt(commandLevel,10)) return;` | `if (!commandAllowed(commandDBData.command, identity)) return;` |
| `dimabot/src/handlers/message.handler.ts:225` | `runChatModeration(channelID, messageEventData, userLevel)` | Pass `identity` to moderation handler. |
| `dimabot/src/handlers/message.handler.ts:474,486` | delete/edit receive `userLevel` | Keep `userLevel` param; management rule handled inside command_manager (§4.3). |
| `dimabot/src/handlers/message.handler.ts:502` | `indexCommands.commandList(channelID, userLevel)` | Pass `identity` (or `userLevel` + `tags`). |
| `dimabot/src/handlers/message.handler.ts:518,526` | title/game receive `userLevel`/`commandLevel` | Tag-mode commands: write requires `userLevel >= 7`; level-mode unchanged. |
| `dimabot/src/handlers/message.handler.ts:133` | `if (userLevel < 7)` timer gate | **Unchanged** (numeric stays, per decision 4). Document. |
| `dimabot/src/handlers/moderation.handler.ts:100` | `runChatModeration(..., userLevel: number)` | Accept `identity: UserIdentity`; keep numeric path internally. |
| `dimabot/src/handlers/moderation.handler.ts:130-133` | `if (userLevel >= rule.exemptUserLevel) continue;` | `if (ruleExempt(rule, identity)) continue;` |
| `dimabot/src/commands/command_list.command.ts:19-23` | `command.userLevel >= userLevel` hides equal-level commands | Use `commandAllowed`; also fix the equality bug so equal level is visible. |
| `dimabot/src/commands/title.command.ts:11-20` | `userLevel < commandLevel` | Keep numeric; tag-mode → require level ≥ 7. |
| `dimabot/src/commands/game.command.ts:12-20` | same | same. |
| `dimabot/src/handlers/commands.handler.ts` | Common custom-command execution has no authorization context | Require an explicit execution identity/origin; direct chat and LLM calls use the real chatter, while trusted authored AST uses broadcaster identity (§2.4). |
| `dimabot/src/utils/ast_parser/evaluator.ts:1241-1254` | Nested command references fabricate an event with empty badges | Pass the explicit AST authorization context into `commandHandler`; retain numeric `minUserLevel` behavior for LLM function calls. |
| `dimabot/src/utils/ast_parser/evaluator.ts:650-657` | level-name map mislabels 8/9 | Fix labels (8=editor, 9=admin, 10=broadcaster). Low-risk bug fix. |

### 4.2.1 Twitch role cache repair

- Change the identity resolver and all direct editor checks to `twitch:${channelID}:editors` / `:editors:ids`.
- Extend `getChannelEditors(..., true)` to atomically refresh both editor sets and their TTLs.
- Change admin add/delete and validation routes from `${channelID}:admins...` to `twitch:${channelID}:admins...`.
- On admin deletion, remove the login, ID, and detail hash from the same canonical namespace before returning success.
- Keep `loadChannelAdminsIntoCache` and stream lifecycle cleanup as the canonical bulk refresh/cleanup paths; verify they cover every key above.
- `dimabot/src/server/routes/admin.route.ts` is the DomDimaBot channel-admin API used by dimasite, so its cache-key repair belongs here. This is unrelated to the deferred CDOM Labs `admin/` frontend and `admin_site.route.ts`.

### 4.3 Command management (`dimabot/src/commands/command_manager.command.ts`)

- Keep the legacy numeric maps (`:15-39`) for `-ul=`.
- `deleteCommand` (`:266`) and `editCommand` (`:350`):
  - If `command.permissionExpression` is set → require `userLevel >= 7`; message "You need moderator permissions to manage a tag-restricted command".
  - Else → existing `userLevel < command.userLevel` behavior.
- A non-`null` invalid stored value is managed like tag mode so a level ≥ 7 caller can edit content or delete it; changing its permission mode still requires the dashboard repair flow.
- `createCommand` chat syntax: **no expression parsing this phase.** `-ul=` creates a level-mode command.
- `editCommand`: if the target is tag mode and the parsed options contain `-ul=`, reject the entire edit before applying any changes. Content/cooldown edits remain allowed for callers at level ≥ 7. Switching from tags to level mode is a dashboard operation that sends `permissionExpression: null` together with the selected level.
- Tag expressions are configured through the dashboard/HTTP API. A later `-perm=` syntax is out of scope.

### 4.4 Reserved commands

`dimabot/src/config/commands/reservedcommands.json` and `dimabot/src/server/services/command_defaults.service.ts` — **no change** (numeric seeding preserved). With `permissionExpression: null`, they continue through the legacy numeric branch exactly as today.

---

## 5. API contracts

| File | Change |
|------|--------|
| `dimabot/src/server/routes/command.route.ts:155-170` (create) | Missing/`null` expression creates level mode. A non-`null` expression must validate or return 400; tag mode cannot be empty, so universal access is `{role:'everyone'}`. Also validate `userLevel` as an integer 1..10 and derive/validate its canonical name. |
| `dimabot/src/server/routes/command.route.ts:233-238` (update) | Add `permissionExpression` to `updatableFields`. Missing leaves the mode unchanged; explicit `null` switches to level mode; a valid tree switches to tag mode; invalid returns 400. A level-mode switch must include a valid level/name pair. |
| `dimabot/src/server/routes/command.route.ts` (list/get) | Include `permissionExpression` plus a computed nonlocalized state (`level`, `tags`, or `invalid`). Do not return `permissionSummary`; dimasite localizes and describes the tree. Invalid stored values remain visible to authorized dashboard callers for repair but never authorize execution. |
| `dimabot/src/server/routes/command.route.ts:249-264` (update/cache) | Capture the old `cmd` before updating and invalidate both `${channelID}:commands:${oldCmd}` and `${channelID}:commands:${newCmd}`. Do this even when the names are equal; never leave a renamed command executable under a stale one-hour cache entry. |
| `dimabot/src/server/routes/moderation.route.ts:113-148` (`sanitizeRule`) | Parse `input.exemptExpression` with `validateExpression`; invalid → return `{ error: 'Rule N: invalid permission expression' }` (do not silently drop). Persist alongside `exemptUserLevel`. |

Response envelope stays `{ error, message, status, data }`.

The numeric fields are retained while tags are active only to make an explicit future switch back to level mode convenient. They are not an automatic recovery policy. If a stored tag tree becomes invalid, runtime authorization fails closed until the streamer repairs it or deliberately switches modes in the dashboard.

---

## 6. Frontend — dimasite

### 6.1 New files

| File | Purpose |
|------|---------|
| `dimasite/src/app/models/permission.model.ts` | `RoleTag`, `PermissionExpression`, `ROLE_TAGS`, label keys, `validateExpression`, `evaluateExpression` (client-side preview only), localized description helpers, node factories, depth/node bounds mirroring the backend. Description helpers accept translated role/operator labels; they do not embed English prose. |
| `dimasite/src/app/features/permissions/permission-expression-editor.component.ts` | Recursive tree editor. Model as an exclusive toggle: **Level (legacy)** vs **Tags (advanced)**. Tags mode renders the tree via a recursive `ng-template` + `ngTemplateOutlet`. Node types: role chip, level, NOT, AND group, OR group. Add/remove child, require at least one valid root node, and show a live localized preview. Standalone, OnPush, signals, Reactive Forms/`ControlValueAccessor`. |
| `dimasite/src/app/features/permissions/permission-expression-editor.component.html` | Template. |
| `dimasite/src/app/features/permissions/permission-expression-editor.component.css` | Live First styling (tokens, mobile-first, touch targets ≥ 44px). |
| `dimasite/src/app/features/permissions/permission-summary.component.ts` (`+ .css`) | Renders a validated expression using `LanguageService` and the active locale for dashboard/public lists; optional if the localized helper is used inline. |

### 6.2 Modified files

| File | Change |
|------|--------|
| `dimasite/src/app/models/command.model.ts:26-53` | Add `permissionExpression?: PermissionExpression \| null` and `permissionMode?: 'level' \| 'tags' \| 'invalid'` to `Command`; add the expression to `Create/UpdateCommandRequest`. Do not add a server summary field. |
| `dimasite/src/app/models/command.model.ts:55-79` | **Bug fix:** level 5 = `vip`, 6 = `founder`, 10 = `broadcaster`; singular `founder`. Keep `USER_LEVEL_NAMES` in sync. |
| `dimasite/src/app/features/commands/command-modal.component.ts:63-73,168-235` | Embed `permission-expression-editor`. Level mode sends `permissionExpression: null` + numeric level; tags mode requires and sends a valid tree. Selecting Everyone in tag mode creates `{role:'everyone'}`. Preselect existing expression on edit and surface invalid stored configuration for repair. |
| `dimasite/src/app/features/commands/command-modal.component.html:63-70` | Replace/augment the level `<select>` with the editor (level option retained). |
| `dimasite/src/app/features/commands/commands-page.component.ts:500-522,663-666,951-953` | Create/update/inline payloads carry `permissionExpression`; derive display text locally with i18n (fallback to the localized level label). Include the localized expression description in search/filter text. |
| `dimasite/src/app/features/commands/commands-page.component.html:151-152,258-274` | Summary column + inline editor. |
| `dimasite/src/app/features/commands/public-commands-page.component.ts:104,165-168` | Render a locally translated description instead of raw level when a valid expression exists; show a neutral configuration-error label for invalid stored data. |
| `dimasite/src/app/features/commands/public-commands-page.component.html:127-155,188-190` | Same. |
| `dimasite/src/app/features/moderation/moderation-page.component.ts:329-355,403-407` | Per-rule exclusive Level/Tags exemption editor; send `exemptExpression`. Numeric data may remain stored while Tags is active but is not labeled or used as a fallback. |
| `dimasite/src/app/features/moderation/moderation-page.component.html:198-209` | Replace the standalone `exemptUserLevel` input with the mode editor. Tags mode requires an explicit valid node; Level mode sends `exemptExpression: null`. |
| `dimasite/src/app/models/moderation.model.ts:11-27,73-104,123` | Add `exemptExpression` to `ModerationRule` and defaults. |
| `dimasite/src/app/services/commands-api.service.ts` | Materially unchanged; types flow from the model. Verify payload shape only. |
| `dimasite/src/app/services/moderation-api.service.ts:29-37` | Same. |
| `dimasite/src/assets/i18n/en.json` + `es.json:1704-1715` | Fix `commands.userLevels.*` (5/6/10, founder singular) and add a `permissions.*` section: role labels, operator labels, node actions, mode labels, summaries. Both languages required. |

No new route → no `MODULE_CHILDREN` change needed in `dimasite/src/app/guards/streamer-route.guard.ts`.

---

## 7. CDOM Labs admin site — deferred

The separate `admin/` application is internal tooling for CDOM Labs workers. It is not the DomDimaBot channel-admin experience; channel owners and their admins use `dimasite`.

No `admin/` or `admin_site.route.ts` changes are part of this phase. A later internal-tooling task may add a read-only structured-expression view if CDOM Labs workers need it. Do not make the current release depend on or deploy the admin bundle.

---

## 8. Documentation — dimadocs

| File | Change |
|------|--------|
| `dimadocs/src/content/docs/commands/overview.mdx:238,313` | Document the exclusive level/tag modes, explicit Everyone tag, dashboard configuration, and that `-ul=` is rejected when editing a tag-mode command. |
| `dimadocs/src/content/docs/es/commands/overview.mdx:238` | Spanish mirror. |
| `dimadocs/src/content/docs/commands/permissions.mdx` (**new**) | New page: exclusive modes, explicit Everyone tag, invalid-policy fail-closed behavior, tag vocabulary, boolean expressions, examples (`sub` only, `sub or vip`, `everyone except mod`, `not(everyone) or mod`), management rule (level ≥ 7), and the level-vs-role caveat. |
| `dimadocs/src/content/docs/es/commands/permissions.mdx` (**new**) | Spanish mirror. |
| `dimadocs/astro.config.mjs:66-70` | Add the `commands/permissions` sidebar item with `translations: { es: … }`. |
| `dimadocs/src/content/docs/dashboard.mdx:23` + `es/dashboard.mdx` | Mention permission expressions. |
| `dimadocs/src/content/docs/ai-assistants.mdx:40` + `es/ai-assistants.mdx` | Note tags are dashboard-configured, not `!cc` in this phase. |

Run `npm test --prefix dimadocs` (export fidelity) and the `ops/checks/docs_llms.py` check at deploy.

---

## 9. Migration & compatibility

- **No destructive data migration.** New fields are additive and default `null`; only absent/`null` selects the legacy numeric gate.
- A present invalid expression is never compatibility-fallback data. Commands deny execution and moderation rules grant no exemption until repaired or explicitly switched to level mode.
- Command cache (`dimabot/src/classes/command.class.ts`, key `${channelID}:commands:${cmd}`, TTL 3600s) stores whole JSON docs. Old cached docs simply lack `permissionExpression` and remain level mode. Every update invalidates the current key; renames invalidate both old and new keys.
- Moderation settings cache (`moderation.handler.ts`, TTL 300s) likewise treats old cached rules without `exemptExpression` as level mode. Invalid non-`null` values fail closed.
- Twitch role cache keys are normalized to the canonical `twitch:${channelID}:...` namespace. Refresh/mutation code removes the old non-`twitch:` variants after populating the canonical keys; there is no permanent dual-key mode.
- `settingsVersion` bump/recompile path is unaffected.
- Level→tag conversion is **opt-in per command/rule** via the dashboard. Reserved commands and all existing data keep numeric behavior.
- `!cc -ul=` continues to create level-mode commands. `!ec -ul=` works only for an existing level-mode command and is rejected for tag mode.
- The API derives localized permission display nowhere. Dimasite receives the expression tree and renders it with the active language.

---

## 10. Verification & deployment

Backend changes span the bot and API services; the customer frontend is `dimasite`. The separate CDOM Labs `admin` target is not part of this rollout. Use `scripts/saas-ops` (`ops/README.md`). Do **not** use `scripts/dima-update`.

1. **Unit tests** (node:test via tsx, matching existing `*.test.ts` style):
   - `roles.test.ts`: every badge→tag/level mapping; founder→sub; multi-role sets; broadcaster; editor/admin ID-first resolution and normalized-login compatibility.
   - `role_cache.test.ts`: canonical `twitch:` keys for editor/admin load, add, remove, refresh, and legacy-key cleanup.
   - `expression.test.ts`: nested and/or/not; explicit `everyone`; `not(everyone)`; broadcaster override for valid trees; `{level:N}` equivalence with legacy; root-at-depth-1 boundary; validation rejects `{}`, empty groups, unknown role, bad level, mixed keys, over-depth, and over-node.
   - Gate tests: absent/`null` uses numeric mode; valid uses tag mode; present-invalid denies commands and grants no moderation exemption even when the stored numeric field would allow it.
   - `command_list.command.test.ts`: expression allow/deny, legacy fallback, equal-level visibility fix.
   - `moderation.handler.test.ts`: `ruleExempt` expression + legacy fallback.
   - `commands.handler.test.ts`: direct chat and LLM AST preserve the real chatter identity; trusted authored command/event contexts use explicit broadcaster identity; nested command references cannot accidentally derive authority from empty fake badges.
   - Command-manager tests: `-ul=` succeeds in level mode and rejects the entire edit in tag mode.
2. **API/cache behavior**: round-trip create/update with a valid expression; `{role:'everyone'}` is required for universal tag access; 400 on empty/invalid; explicit `null` switches to level mode; moderation PUT rejects invalid expression; renaming an already-cached command invalidates both names.
3. **Build/verify/deploy:**
   - `scripts/saas-ops plan bot` → build → verify (message/moderation handlers, command_manager) → deploy.
   - `scripts/saas-ops plan api` → build → verify (routes) → deploy.
   - `scripts/saas-ops plan site` → build → verify → deploy.
   - Extend existing checks: `ops/checks/public-commands-web.mjs`, `ops/checks/moderation.mjs` (and fixtures) to assert expression-driven behavior; consume `ops/fixtures/permission-expressions.json` from backend/frontend checks.
   - Docs: `scripts/saas-ops plan docs` + `ops/checks/docs_llms.py`.
4. **Frontend behavior**: validate mobile/desktop editor use, keyboard/focus behavior, explicit Everyone selection, invalid stored-policy repair, and English/Spanish descriptions generated entirely in dimasite.
5. **Production smoke**: public command list shows the correct localized description; a tag-restricted command denies/passes the right roles; an AI request retains the chatter's authority; trusted authored automation retains broadcaster authority; a moderation rule exempts exactly the configured tags; legacy level commands behave identically; renamed commands do not execute through stale cache keys.
6. Preserve rollback via the run IDs; `rollback <run-id>` on regression.

---

## 11. Out of scope (this phase)

- AI/AST `minUserLevel`, catalog filtering, and LLM tool clamps (stay numeric).
- Changing the trust model for streamer-authored AST (`enforceFunctionPermissions:false`). This plan only makes its broadcaster authorization identity explicit and keeps LLM AST tied to the real chatter.
- Tags for triggers, redemptions, or events.
- Chat-side expression editing (`!cc -perm=`).
- Converting existing numerical levels to role expressions (optional future migration).
- Global (non-command) role management.
- CDOM Labs internal `admin/` display and tooling.

## 12. Known risks / notes for the implementer

- **Strict tags vs hierarchical levels** is the top source of surprises: `{role:'mod'}` excludes editors/admins. The editor UI must warn and offer level-preserving conversion.
- `Mixed` schema values are untrusted; inspect on every read. Only missing/`null` falls back to a level. Present-invalid fails closed and emits a configuration error.
- “Everyone in tag mode” always means the explicit `{role:'everyone'}` node. Empty UI state cannot be saved.
- Server and client each validate/evaluate expressions; keep them in lockstep with shared fixtures. Human-readable summaries exist only in dimasite and use i18n.
- AST execution must carry an explicit origin and identity. LLM AST uses the requesting chatter; trusted authored AST uses broadcaster identity. Never authorize from synthetic badge data.
- Role cache authorization depends on one canonical `twitch:` namespace. Admin/editor mutation and removal paths must update the same keys the resolver reads.
- The 5/6 vip/founder swap (`dimasite/src/app/models/command.model.ts`) is a live bug; fixing it changes displayed labels for existing commands. Coordinate with the i18n fix.
- Broadcaster override is global and intentional; document that `not(everyone)` cannot lock out the broadcaster.
- Bounded trees (depth ≤ 4, nodes ≤ 25) are required both for evaluation cost and to keep the recursive Angular editor usable.

---

## 13. File checklist

**New:**
- `dimabot/src/utils/permissions/roles.ts`
- `dimabot/src/utils/permissions/expression.ts`
- `dimabot/src/utils/permissions/index.ts`
- `dimabot/src/utils/permissions/roles.test.ts`
- `dimabot/src/utils/permissions/expression.test.ts`
- `dimabot/src/commands/command_list.command.test.ts`
- `dimabot/src/handlers/moderation.handler.test.ts`
- `dimabot/src/handlers/commands.handler.test.ts`
- `dimabot/src/utils/permissions/role_cache.test.ts`
- `dimasite/src/app/models/permission.model.ts`
- `dimasite/src/app/features/permissions/permission-expression-editor.component.ts`
- `dimasite/src/app/features/permissions/permission-expression-editor.component.html`
- `dimasite/src/app/features/permissions/permission-expression-editor.component.css`
- `ops/fixtures/permission-expressions.json`
- `dimadocs/src/content/docs/commands/permissions.mdx` (+ `es/…/permissions.mdx`)

**Modify (backend):** `commands.schema.ts`, `channel_moderation_settings.schema.ts`, `message.handler.ts`, `commands.handler.ts`, `moderation.handler.ts`, `command_list.command.ts`, `title.command.ts`, `game.command.ts`, `command_manager.command.ts`, `command.route.ts`, `moderation.route.ts`, `ast_parser/evaluator.ts`, AST execution-context types/callers, `functions/channels/get_editors.channel.ts`, `utils/cache.ts`, `server/routes/admin.route.ts`, `server/routes/validation.route.ts`, `domain_events/stream_operations_events.ts`, and direct editor-key consumers (`duel.command.ts`, `vanish.command.ts`, `ruletarusa.command.ts`).

**Modify (frontend):** `command.model.ts`, `moderation.model.ts`, `command-modal.component.{ts,html}`, `commands-page.component.{ts,html}`, `public-commands-page.component.{ts,html}`, `moderation-page.component.{ts,html}`, `assets/i18n/{en,es}.json`, `services/commands-api.service.ts` (verify), `services/moderation-api.service.ts` (verify).

**Modify (docs):** `astro.config.mjs`, `commands/overview.mdx` (+ es), `dashboard.mdx` (+ es), `ai-assistants.mdx` (+ es).

---

## 14. Suggested implementation order

1. Repair and test canonical Twitch editor/admin cache keys across every producer, remover, cleanup path, and consumer.
2. `roles.ts` + identity/cache tests.
3. `expression.ts` + `index.ts` + shared fixtures/tests, including absent versus invalid state.
4. Schemas + API validation + old/new command-name cache invalidation (`command.route.ts`, `moderation.route.ts`).
5. Enforcement wiring (`message.handler.ts`, `commands.handler.ts`, AST context/evaluator, `moderation.handler.ts`, `command_list.command.ts`, `title/game`, `command_manager.command.ts`) + direct/LLM/authored-context tests.
6. Dimasite editor + page wiring + frontend-only localized descriptions + i18n (including the 5/6 bug fix).
7. Docs (EN + ES) + sidebar.
8. Verify/deploy `bot`, `api`, `site`, `docs`; production smoke; commit. Do not build/deploy the CDOM Labs admin site for this phase.
