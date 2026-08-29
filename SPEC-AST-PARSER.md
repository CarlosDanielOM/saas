# DimaBot AST Parser Specification

## Overview

The DimaBot AST (Abstract Syntax Tree) Parser is a powerful template engine that processes chat commands with dynamic variable substitution, function calls, conditionals, loops, and more. It powers all custom commands in the DimaBot system.

---

## Syntax Prefixes

The parser recognizes 5 distinct prefix types that trigger different parsing behaviors:

| Prefix | Syntax | Purpose | Example |
|--------|--------|---------|---------|
| `$(` | `$(funcName arg1 arg2)` | Function call | `$(random 10)` |
| `%( | `%(name)` or `%(name value)` | Variable get/set | `%(wins)`, `%(wins 5)` |
| `*( | `*(condition ? true : false)` | Computed expression | `*(%(userLevel) >= 5 ? "VIP" : "Regular")` |
| `^( | `^(variableName)` | Existence check | `^(#wins)` |
| `#( | `%(commandName args...)` | Command reference | `#(othercmd arg1)` |

---

## Variable Storage Types

Variables support 4 storage backends with different persistence characteristics:

| Prefix | Storage | Persistence | Plan Required | Example |
|--------|---------|-------------|--------------|---------|
| none | Memory | Single execution only | Free | `%(temp)` |
| `#` | Cache (Redis) | Up to 24 hours (auto-deleted) | Free | `%(#wins)` |
| `##` | Cache + User-scoped | Up to 24 hours (auto-deleted) | Free | `%(##chips)` |
| `*` | Database (MongoDB) | Permanent | Premium/Pro | `%( *wins)` |
| `**` | Database + User-scoped | Permanent | Premium/Pro | `%( **rank)` |

### Important Behaviors

1. **Cache auto-deletion**: Cache variables (`#`, `##`) are deleted from Redis after 24 hours. If a cache key expires and you try to read it, you get an **empty/blank value** - not a default or zero.

2. **Assignment is direct**: `%(wins 1)` sets wins to 1 (overwrites). It does NOT increment. Use the `*()` operator for arithmetic:
   ```
   %(wins *(%(#wins) + 1))    // Correct increment for cache variable
   ```

3. **User-scoped variables** can target other users via selector syntax:
   ```
   %(##rank)                    // Current user's rank
   %(##rank(&p1))              // Rank of user passed as &p1
   %( **rank)                  // Current user's rank (database)
   %( **rank(&p1))             // Rank of user passed as &p1 (database)
   ```

### Storage Examples

```bash
# Memory (temporary)
%(counter)              # Read
%(counter 0)           # Set to 0
%(counter *(%(counter) + 1))  # Increment

# Cache (24h auto-delete)
%(#streak)              # Read
%(#streak 1)            # Set to 1
%(#streak *(%(#streak) + 1))  # Increment

# User-scoped Cache (24h auto-delete)
%(##balance)            # Read current user's balance
%(##balance 100)       # Set current user's balance

# Database (permanent, Premium/Pro)
%( *wins)               # Read
%( *wins 0)             # Set
%( *wins *(%(*wins) + 1))  # Increment

# User-scoped Database (permanent, Premium/Pro)
%( **rank)              # Read current user's rank
%( **rank(&p1))         # Read &p1 user's rank
```

---

## Argument Placeholders

When a command is invoked (e.g., `!greet hello world`), placeholders allow access to arguments:

| Placeholder | Meaning | Example |
|-------------|---------|---------|
| `&p1`, `&p2`, `&p3`... | Positional arguments | `&p1` = "hello", `&p2` = "world" |
| `&t` | All trailing text after last `&pN` | `&t` = "hello world" |

**Important:** `&t` must come last. Cannot create new `&pN` placeholders after `&t`.

### Examples

```
Command: !greet Hello World
Message: "Hello &p1 and &p2!"
→ "Hello Hello and World!"

Command: !echo lots of args here
Message: "&p1 &p2 &t"
→ "lots of args here"

Command: !badorder &t &p1
Message: "&t &p1"
→ Error: cannot create new &pN after &t
```

---

## Template Strings

Double-quoted strings with `${}` interpolation for embedding expressions:

```bash
"Hello ${%(user)}!"          # Embed variable
"You've won ${%(wins)} times!"  # Embed with text
```

---

## Array Syntax

### Literal Arrays

```bash
%[item1, item2, item3]
%[1, 2, 3, 4, 5]
```

### Array Accessors

| Syntax | Meaning | Example |
|--------|---------|---------|
| `%(arr[0])` | Index access | `%(items[0])` |
| `%(arr[random])` | Random element | `%(items[random])` |
| `%(arr[].length)` | Array length | `%(items[].length)` |
| `%(arr[] value)` | Append element | `%(items[] newitem)` |
| `%(arr[2] newval)` | Set by index | `%(items[2] updated)` |

### Examples

```
%(items[0])                  # First element
%(items[random])             # Random element
%(items[].length)            # Number of items
%(items[] extra)             # Append 'extra' to array
%(items[1] replacement)     # Replace index 1
%[1, 2, 3][random]          # Random from literal
```

---

## Operators and Expressions

### Comparison Operators

| Operator | Meaning | Example |
|----------|---------|---------|
| `==` / `=` | Equals (case-insensitive for strings) | `%(wins) == 5` |
| `!=` / `<>` | Not equals | `%(status) != "offline"` |
| `>` | Greater than | `%(level) > 3` |
| `<` | Less than | `%(age) < 18` |
| `>=` | Greater than or equal | `%(wins) >= 10` |
| `<=` | Less than or equal | `%(wins) <= 5` |
| `~=` | Contains (case-insensitive) | `%(tags) ~= "gaming"` |

### Arithmetic Operators

| Operator | Meaning | Example |
|----------|---------|---------|
| `+` | Addition | `*(%(#wins) + 1)` |
| `-` | Subtraction | `*(%(#wins) - 1)` |
| `*` | Multiplication | `*(%(x) * 2)` |
| `/` | Division | `*(%(total) / 2)` |
| `%` | Modulo | `*(%(count) % 10)` |

### Unary Operators

| Operator | Meaning |
|----------|---------|
| `+` | Positive (unary plus) |
| `-` | Negation (unary minus) |

### Assignment Operators (for loop variables only)

| Operator | Meaning |
|----------|---------|
| `=` | Direct assignment |
| `++` | Increment by 1 |
| `--` | Decrement by 1 |
| `+=` | Add and assign |
| `-=` | Subtract and assign |
| `*=` | Multiply and assign |
| `/=` | Divide and assign |
| `%=` | Modulo and assign |

---

## Conditionals

### Ternary Expression

```bash
*(condition ? trueValue : falseValue)
*(userLevel >= 5 ? "VIP" : "Regular")
*(islive == 1 ? "Stream is live!" : "Stream is offline")
```

### Conditional with Comparison

```bash
*(wins > 10 ? "Champion" : "Keep trying")
```

---

## Loops

### Range Loop (C-style)

```bash
*(for #i = 0; #i < 3; #i++ {
  %(out[] #i)
})
```

### Foreach Loop

```bash
*(for #item in %(#items[]) {
  %(result[] %( #item))
})
```

### Loop Control

| Function | Purpose |
|----------|---------|
| `$(break)` | Exit loop immediately |
| `$(continue)` | Skip to next iteration |

### Loop Limits by Plan

| Plan | Max Nesting Depth | Max Iterations |
|------|------------------|----------------|
| Free | 2 | 25 |
| Premium | 3 | 50 |
| Pro | 4 | 100 |

### Example: Building Output Arrays

```bash
*(for #i = 0; #i < %( #count); #i++ {
  %(output[] %( #i))
})
"Your numbers: ${%(output[])}"
```

---

## Command References

Reference and execute another command from within a command:

```bash
#(othercmd arg1 arg2)
```

**Constraints:**
- Max recursion depth: 5 levels
- Cycles are detected and prevented
- Referenced command's output is parsed and substituted

---

## Exists Check

Check if a variable or array element exists:

```bash
^(#wins)              # Returns "true" or "false"
^(#items[0])         # Check if index 0 exists
^(##balance)         # Check if user has balance set
```

---

## Function Reference

### User Functions

| Function | Description | Usage |
|----------|-------------|-------|
| `$(user)` | Current chatter's username | `$(user)` |
| `$(touser)` | Targeted user (from context or argument) | `$(touser)` |
| `$(randomuser)` | Random chatter in channel | `$(randomuser)` |

### Random Functions

| Function | Description | Usage |
|----------|-------------|-------|
| `$(random N)` | Random integer 0 to N-1 (default 100) | `$(random 10)` |

### Twitch Functions

| Function | Description | Usage |
|----------|-------------|-------|
| `$(twitch.subs)` | Subscriber count | `$(twitch.subs)` |
| `$(twitch.title)` | Stream title | `$(twitch.title)` |
| `$(twitch.game)` | Current game/category | `$(twitch.game)` |
| `$(twitch.viewers)` | Viewer count (chatters) | `$(twitch.viewers)` |
| `$(twitch.follows)` | Follower count | `$(twitch.follows)` |
| `$(twitch.channel)` | Broadcaster name | `$(twitch.channel)` |
| `$(twitch.login)` | Broadcaster login (lowercase) | `$(twitch.login)` |

### Moderation Functions

| Function | Description | Args | User Level |
|----------|-------------|------|------------|
| `$(vip)` / `$(add.vip)` | Add VIP | `username [days]` | Mod (7) |
| `$(unvip)` | Remove VIP | `username` | Mod (7) |
| `$(ban)` | Ban user | `username [duration_seconds]` | Mod (7) |
| `$(ban.mod)` | Ban + optionally restore mod | `username seconds true\|false` | Mod (7) |
| `$(mod)` / `$(add.mod)` | Add mod | `username [days]` | Owner (8) |
| `$(unmod)` | Remove mod | `username` | Owner (8) |
| `$(clear.chat)` | Clear chat | - | Mod (7) |
| `$(emoteonly)` | Toggle emote-only mode | `[duration_seconds]` | Mod (7) |

**Note:** Temporary mod/vip durations (1-365 days) require Premium or Pro plan.

### Count Functions

| Function | Description | Usage |
|----------|-------------|-------|
| `$(count N)` | Get current count; with arg, set to N+current | `$(count 5)` adds 5 |
| `$(count 0)` | Get current count (no change) | `$(count 0)` |
| `$(count -3)` | Subtract 3 from count | `$(count -3)` |
| `$(scount)` | Simple increment by 1 | `$(scount)` |
| `$(bits)` | Bits from cheer event | `$(bits)` |

### Channel Functions

| Function | Description | Usage |
|----------|-------------|-------|
| `$(raid channel)` | Raid target channel | `$(raid targetchannel)` |
| `$(unraid)` | Cancel raid | `$(unraid)` |
| `$(set.title new_title)` | Update stream title | `$(set.title Playing Valorant!)` |
| `$(set.game game_name)` | Update category | `$(set.game Valorant)` |
| `$(start.prediction title;opt1/opt2;seconds)` | Start prediction | `$(start.prediction Who wins?;TeamA/TeamB;120)` |
| `$(start.poll title;opt1/opt2;seconds)` | Start poll | `$(start.poll Favorite game?;COD/Halo;60)` |
| `$(ad)` / `$(ad.time)` | Ad duration in seconds | `$(ad)` |
| `$(ai prompt)` | AI-generated response | `$(ai tell a joke)` |

### Clip Functions

| Function | Description | Usage |
|----------|-------------|-------|
| `$(create.clip)` | Create clip, return URL | `$(create.clip)` |

### Followage Functions

| Function | Description | Usage |
|----------|-------------|-------|
| `$(followage username)` | How long user has followed | `$(followage ronni)` |

### EventSub Functions

These functions read from EventSub webhook payloads. They only return meaningful data when the command is triggered by a matching EventSub event (not from regular chat).

| Function | Event Context | Returns |
|----------|---------------|---------|
| `$(raid.channel)` | channel.raid | Raiding channel display name |
| `$(raid.login)` | channel.raid | Raiding channel login |
| `$(raid.viewers)` | channel.raid | Number of viewers in raid |
| `$(cheer.amount)` | channel.cheer | Bits cheered |
| `$(cheer.message)` | channel.cheer | Cheer message text |
| `$(sub.tier)` | channel.subscribe | Prime / Tier 1 / Tier 2 / Tier 3 |
| `$(sub.months)` | channel.subscribe | Cumulative months |
| `$(gifted.user)` | channel.gift | Gift recipient username |
| `$(hypetrain.progress)` | hypetrain.event | Progress toward goal |
| `$(hypetrain.level)` | hypetrain.event | Current level |
| `$(hypetrain.end)` | hypetrain.event | End timestamp |
| `$(shoutout.channel)` | channel.shoutout | Channel that was shouted out |
| `$(reward.input)` | channel.points_redemption | User's redemption input |
| `$(redemption.input)` | channel.points_redemption | User's redemption input |
| `$(ad)` | channel.ad_break | Ad duration in seconds |

### TTS Functions

| Function | Plan | Description | Usage |
|----------|------|-------------|-------|
| `$(tts message)` | All | Queue default TTS | `$(tts Hello world)` |
| `$(tts.speak message)` | All | Same as `$(tts ...)` | `$(tts.speak Hello)` |
| `$(tts.ai message)` | All | Same as `$(tts ...)` | `$(tts.ai Hello world)` |
| `$(tts.clone name message)` | All | Voice clone TTS | `$(tts.clone voice1 Hello)` |

### Trigger Functions

| Function | Description | Usage |
|----------|-------------|-------|
| `$(trigger.send name [queue])` | Fire a trigger | `$(trigger.send airhorn)` |

**Args:**
- `name`: Trigger name
- `queue`: Optional `true` or `false` (defaults to `false`)

### Delay/Control Functions

| Function | Description | Usage |
|----------|-------------|-------|
| `$(delay N)` | Pause N seconds (max 60) | `$(delay 5)` |
| `$(break)` | Exit loop early | `$(break)` |
| `$(continue)` | Skip to next iteration | `$(continue)` |

### Chat Functions

| Function | Description | Usage |
|----------|-------------|-------|
| `$(chat.send message)` | Send message to chat | `$(chat.send Hello everyone!)` |

---

## Special Variables

These are built-in context variables available in every command:

| Variable | Description |
|----------|-------------|
| `%(user)` | Current chatter's username |
| `$(touser)` | Targeted user |
| `%(count)` | Counter value |
| `%(userLevel)` | User's permission level (1=user, 7=mod, 8=owner) |
| `%(plan)` | Streamer's subscription plan |

---

## Execution Flow

1. **Command invoked** (e.g., `!wins` or EventSub trigger)
2. **Argument placeholders resolved** (`&p1`, `&p2`, `&t` replaced)
3. **Execution context created** with user info, channel data, event data
4. **Tokenization** - Input string split into tokens
5. **Parsing** - Tokens converted to AST (Abstract Syntax Tree)
6. **Evaluation** - AST traversed, nodes executed
7. **Variable storage** - Results saved to appropriate backend
8. **Output** - Final rendered string sent to chat

---

## Error Handling

| Error Pattern | Meaning |
|---------------|---------|
| `[Unknown function: name]` | Function not registered |
| `[Loop error: invalid loop syntax]` | Malformed loop syntax |
| `[Loop error: missing loop body]` | Missing `{ }` in loop |
| `[Parse error: expr]` | Failed to parse expression |
| `Usage: $(func ...)` | Missing or invalid arguments |

---

## Best Practices

1. **Use correct increment pattern:**
   ```bash
   # WRONG
   %(#wins 1)  # This sets to 1, doesn't add

   # CORRECT
   %(#wins *(%(#wins) + 1))
   ```

2. **Check variable existence before use:**
   ```bash
   %(#wins 0)  # Initialize first
   "You have %( #wins) wins!"
   ```

3. **Cache vs Database:**
   - Use `#` / `##` for temporary data (auto-deleted after 24h)
   - Use `*` / `**` for permanent data (Premium/Pro)

4. **Loop safety:**
   - Don't exceed iteration limits
   - Use `$(break)` to exit early when needed

5. **EventSub functions:**
   - These only work when triggered by EventSub, not from chat
   - Test with actual events or use mock data

---

## Function Examples

These examples show basic standalone usage of each function. Each example demonstrates what the function returns in a simple context.

### User Functions

| Function | Example Usage | Output |
|----------|--------------|--------|
| `$(user)` | `"Welcome $(user)!"` | "Welcome ronchi!" |
| `$(touser)` | `"Shoutout to $(touser)!"` | "Shoutout to katherine!" |
| `$(randomuser)` | `"Random viewer: $(randomuser)"` | "Random viewer: alex123" |

### Random Functions

| Function | Example Usage | Output |
|----------|--------------|--------|
| `$(random N)` | `"You rolled: $(random 20)"` | "You rolled: 7" |
| `$(random)` | `"D100 roll: $(random)"` | "D100 roll: 42" |

### Twitch Functions

| Function | Example Usage | Output |
|----------|--------------|--------|
| `$(twitch.subs)` | `"We have $(twitch.subs) subscribers!"` | "We have 1542 subscribers!" |
| `$(twitch.title)` | `"Now playing: $(twitch.title)"` | "Now playing: Valorant" |
| `$(twitch.game)` | `"Category: $(twitch.game)"` | "Category: Valorant" |
| `$(twitch.viewers)` | `"Viewers: $(twitch.viewers)"` | "Viewers: 5423" |
| `$(twitch.follows)` | `"Followers: $(twitch.follows)"` | "Followers: 25000" |
| `$(twitch.channel)` | `"Channel: $(twitch.channel)"` | "Channel: dima" |
| `$(twitch.login)` | `"Login: $(twitch.login)"` | "Login: dima" |

### Count Functions

| Function | Example Usage | Output |
|----------|--------------|--------|
| `$(count 1)` | `"Uses: $(count 1)"` | "Uses: 42" |
| `$(scount)` | `"Command used $(scount) times"` | "Command used 15 times" |
| `$(bits)` | `"Bits: $(bits)"` | "Bits: 500" |

### Channel Functions

| Function | Example Usage | Output |
|----------|--------------|--------|
| `$(followage username)` | `"$(user) has been following for $(followage ronchi)"` | "ronchi has been following for 1 years, 3 months, 15 days, 2 hours" |
| `$(create.clip)` | `"Clip: $(create.clip)"` | "Clip: https://clips.twitch.tv/..." |
| `$(ad)` | `"Ad break: $(ad) seconds"` | "Ad break: 30 seconds" |
| `$(ai tell me a joke)` | `"$(ai tell me a joke)"` | "AI response text" |

### EventSub Functions

These only return meaningful data when the command is triggered by a matching EventSub event.

| Function | Event Context | Example Usage | Output (example) |
|----------|---------------|--------------|-----------------|
| `$(raid.channel)` | channel.raid | `"Raid from: $(raid.channel)"` | "Raid from: ninja" |
| `$(raid.login)` | channel.raid | `"Login: $(raid.login)"` | "Login: ninja" |
| `$(raid.viewers)` | channel.raid | `"Raid viewers: $(raid.viewers)"` | "Raid viewers: 1500" |
| `$(cheer.amount)` | channel.cheer | `"Bits: $(cheer.amount)"` | "Bits: 500" |
| `$(cheer.message)` | channel.cheer | `"Message: $(cheer.message)"` | "Message: PogChamp" |
| `$(sub.tier)` | channel.subscribe | `"Tier: $(sub.tier)"` | "Tier: Tier 1" |
| `$(sub.months)` | channel.subscribe | `"Months: $(sub.months)"` | "Months: 24" |
| `$(gifted.user)` | channel.gift | `"Gift to: $(gifted.user)"` | "Gift to: katherine" |
| `$(hypetrain.progress)` | hypetrain.event | `"Progress: $(hypetrain.progress)"` | "Progress: 5000" |
| `$(hypetrain.level)` | hypetrain.event | `"Level: $(hypetrain.level)"` | "Level: 3" |
| `$(shoutout.channel)` | channel.shoutout | `"Shoutout to: $(shoutout.channel)"` | "Shoutout to: ninja" |
| `$(reward.input)` | channel.points_redemption | `"Input: $(reward.input)"` | "Input: my redemption text" |
| `$(redemption.input)` | channel.points_redemption | `"Input: $(redemption.input)"` | "Input: my redemption text" |

### TTS Functions

| Function | Plan | Example Usage |
|----------|------|--------------|
| `$(tts message)` | All | `"$(tts Hello world)"` |
| `$(tts.speak message)` | All | `"$(tts.speak Hello world)"` |
| `$(tts.ai message)` | All | `"$(tts.ai Hello world)"` |
| `$(tts.clone name message)` | All | `"$(tts.clone voice1 Hello world)"` |

### Trigger Functions

| Function | Example Usage |
|----------|--------------|
| `$(trigger.send name)` | `"$(trigger.send airhorn)"` |
| `$(trigger.send name true)` | `"$(trigger.send airhorn true)"` |

### Delay/Control Functions

| Function | Example Usage |
|----------|--------------|
| `$(delay N)` | `"$(delay 5)"` - pauses 5 seconds (max 60) |
| `$(break)` | Use inside loops to exit early |
| `$(continue)` | Use inside loops to skip iteration |

### Chat Functions

| Function | Example Usage |
|----------|--------------|
| `$(chat.send message)` | `"$(chat.send Hello everyone!)"` |

### Moderation Functions

| Function | Example Usage |
|----------|--------------|
| `$(vip user [days])` | `"$(vip ronchi)"` - adds VIP |
| `$(unvip user)` | `"$(unvip ronchi)"` - removes VIP |
| `$(mod user [days])` | `"$(mod ronchi 30)"` - adds mod (Premium+) |
| `$(unmod user)` | `"$(unmod ronchi)"` - removes mod |
| `$(ban user [duration])` | `"$(ban ronchi 300)"` - bans user |
| `$(ban.mod user duration restoreMod)` | `"$(ban.mod ronchi 300 true)"` - ban with mod restore |
| `$(clear.chat)` | `"$(clear.chat)"` - clears chat |
| `$(emoteonly [duration])` | `"$(emoteonly 300)"` - emote-only mode |

---

## Complex Systems

These examples demonstrate how to combine multiple AST parser features to build complex interactive systems like games and automated workflows.

### Concepts Demonstrated

| Pattern | Description |
|---------|-------------|
| **Initialize-or-Increment** | Check if variable exists, initialize if not, increment if yes |
| **User Selector Syntax** | Access other users' variables: `%(var(user))` |
| **Nested Ternaries** | Multiple `*(...? : ...)` chained for complex logic |
| **Side Effects in Ternaries** | Actions like `$(ban.mod ...)` executed as ternary results |
| **Arithmetic in Assignments** | Math operations inside variable assignments |
| **User-Scoped DB Variables** | `%( **var)` for permanent per-user data (Premium/Pro) |

---

### System 1: Shield Purchase (Initialize-or-Increment)

**Pattern:** `*( ^(**variable) ? INCREMENT : INITIALIZE )`

This command gives the user a shield every time they use it. Works for both commands and redemptions since they share the same scope.

```
*( ^(**escudos) ? %(**escudos *(%(**escudos) + 1)) : %(**escudos 1) ) $(user) ha comprado un escudo, ahora tiene %(**escudos) escudos
```

**Key patterns used:**
- `^(**escudos)` - Existence check to determine if user has shields
- `%( **escudos 1)` - Initialize to 1 if doesn't exist
- `%(**escudos *(%(**escudos) + 1))` - Read current, add 1, assign result
- `$(user)` - Function call to get current username
- `%(**escudos)` - Final read to display updated count

**Output examples:**
- First use (no shields): "User123 ha comprado un escudo, ahora tiene 1 escudos"
- Second use: "User123 ha comprado un escudo, ahora tiene 2 escudos"

---

### System 2: Simple Shield Bounce (Defense Only)

**Pattern:** `*( ^(**target) ? ATTACKER_BANNED : TARGET_BANNED )`

If the target has shields, the attacker gets bounced (timeout) and nothing happens to the target. If target has no shields, they get banned and lose their shields.

```
%(target $(reward.input))
*( ^(**escudos(%(target))) ?
    $(ban.mod $(user) 300 true) "¡%(target) tiene escudos! El ataque rebotó hacia %(user)."
: 
 
    $(ban.mod %(target) 300 true)
    %(**escudos(%(target)) 0)
    "¡%(user) atacó y baneó a %(target)! Los escudos de %(target) se han perdido."
)
```

**Key patterns used:**
- `%(target $(reward.input))` - Store redemption input in a variable
- `%( **escudos(%(target)))` - User selector: read "escudos" for the target user
- `$(ban.mod ...)` - Action function called as ternary result
- Side effect: `%(**escudos(%(target)) 0)` sets target's shields to 0 after ban

**Flow:**
1. `%(target ...)` - Execute first, sets `target` variable
2. `*( ^(...))` - Check if target has shields
3. True branch: Attacker banned (bounce)
4. False branch: Target banned, target's shields reset to 0

---

### System 3: Full Shield Battle (Mutual Combat)

**Pattern:** Nested ternaries with shield arithmetic

Shield battle where whoever has **more shields wins**. Loser gets banned. Loser loses all shields. Winner loses loser's shield count (Winner new = Winner old - Loser old).

**Example:** Attacker has 7 shields, Defender has 4 → Attacker wins, Defender banned, Attacker new shields = 7 - 4 = 3

```
%(attacker %(user))
%(defender $(reward.input))
*( ^(**escudos(%(defender))) ?
    *( ^(**escudos(%(attacker))) ?
        *( %(**escudos(%(attacker))) > %(**escudos(%(defender))) ?
            // Attacker wins: defender banned, both lose shields
            $(ban.mod %(defender) 300 true)
            %(**escudos(%(defender)) 0)
            %(**escudos(%(attacker)) *(%(**escudos(%(attacker))) - %(**escudos(%(defender)))))
            "¡%(attacker) gana! %(defender) baneado. %(attacker) ahora tiene %(**escudos(%(attacker))) escudos."
        :
            // Defender wins: attacker banned, both lose shields
            $(ban.mod %(attacker) 300 true)
            %(**escudos(%(attacker)) 0)
            %(**escudos(%(defender)) *(%(**escudos(%(defender))) - %(**escudos(%(attacker)))))
            "¡%(defender) gana! %(attacker) baneado. %(defender) ahora tiene %(**escudos(%(defender))) escudos."
        )
    : "¡%(defender) tiene escudos pero %(attacker) no tiene ninguno!")
:
    // Defender has no shields - instant ban
    $(ban.mod %(defender) 300 true)
    "¡%(defender) no tiene escudos y fue baneado por %(user)!"
)
```

**Key patterns used:**
- `%(attacker $(user))` - Store current user as attacker
- `%( **escudos(%(user)))` - User selector syntax to read another user's variable
- Nested ternaries: Three levels of `*(...? : ...)` for cascade logic
- Arithmetic in assignment: `*(oldShields - opponentShields)` to calculate new shield count
- Multiple actions as ternary results: `$(ban.mod ...)`, assignment, then string

**Flow (4 levels deep):**
1. Does defender have shields?
   - NO → Defender instantly banned (outer false branch)
   - YES → Continue to inner check
2. Does attacker have shields?
   - NO → Defender blocks (inner false branch)
   - YES → Compare counts
3. Who has more shields?
   - Attacker wins → Defender banned, attacker loses `defender_shields` amount
   - Defender wins → Attacker banned, defender loses `attacker_shields` amount

---

### Design Patterns Summary

| Pattern | Syntax | Purpose |
|---------|--------|---------|
| Initialize-or-increment | `*( ^(**x) ? %(x + 1) : %(x 1))` | Smart counter that handles first-use |
| User selector | `%( **var(%target))` | Read/write another user's variable |
| Guard check | `*( ^(**target) ? FAIL : ACT)` | Prevent action if condition not met |
| Side effect in ternary | `*(cond ? $(action) : "")` | Execute action as branch result |
| Nested comparison | `*(a > b ? A_WIN : B_WIN)` | Multi-way conditional logic |
| State arithmetic | `%(winner *(%winner - %loser))` | Calculate new state from two values |
