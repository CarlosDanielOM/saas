# AST Loop Implementation Plan

## Overview

Add C-style `for` loop support to the existing `*()` compute syntax in the dimabot AST parser.

---

## Syntax

### For-Each Loop
```javascript
*(for #varname in %(array) { body })
```

### Range-Based For Loop
```javascript
*(for #varname = init; condition; update { body })
```

### Nested Loops (Tier-Limited)
```javascript
*(for #i in %(arr1) {
  *(for #j in %(arr2) { $(chat.send #i-#j) })
})
```

### Control Flow
```javascript
*(for #i = 0; #i < 10; #i++ {
  *(if $(myvar) == "skip" { $(continue) })
  $(chat.send #i)
  *(if #i == 5 { $(break) })
})
```

---

## Tier Limits

| Plan | Max Loop Nesting Depth |
|------|------------------------|
| free | 0 (no nested loops) |
| premium | 1 (1 level of nesting) |
| pro | 2 (2 levels of nesting) |

- Free users can use loops but NOT nest them
- Exceeding limit silently truncates (behaves like `$(break)` after N iterations)
- Limit is checked upfront when loop starts

---

## Loop Variable Syntax

### Declaration (in loop header)
| Syntax | Meaning |
|--------|---------|
| `for #i in` | For-each loop variable |
| `for #i =` | Range-based loop variable |

### Access (inside loop body)
| Syntax | Meaning |
|--------|---------|
| `#varname` | Loop variable (lexically scoped) |
| `%(#varname)` | Cache variable (explicit, forces cache lookup) |

Loop variables are lexically scoped to their loop body and shadow any cache vars with the same name. After the loop ends, the loop variable ceases to exist unless the user saved its value to a `%(...)` variable.

---

## Body Parsing Strategy

The loop body `{ ... }` is parsed **once** at parse-time into a deferred AST subtree. At evaluation time:

1. Clone the deferred AST for each iteration
2. Inject/override the loop variable binding into context
3. Evaluate the cloned AST
4. Check for `$(break)` / `$(continue)` sentinel after each iteration

This approach is more flexible than re-parsing each iteration, allowing dynamic array changes between iterations while avoiding full parse cost.

---

## Break/Continue Implementation

### Sentinel-Based Approach

`$(break)` and `$(continue)` are registered as function handlers that set a `loopExit` flag on the context:

```typescript
const breakHandler: FunctionHandler = async (_args, ctx) => {
  ctx.loopExit = 'break';
  return '';
};

const continueHandler: FunctionHandler = async (_args, ctx) => {
  ctx.loopExit = 'continue';
  return '';
};
```

The evaluator's forLoop handler checks `ctx.loopExit` after each body evaluation:
- `break` → exit loop, return `''`
- `continue` → skip to next iteration
- Neither → continue normal iteration

---

## Files to Modify

### 1. `src/utils/ast_parser/types.ts`

Add new node types:

```typescript
export type LoopExitType = 'break' | 'continue';

export interface ForLoopNode extends BaseNode {
  type: 'forLoop';
  loopVar: string;           // e.g., "i" (without # prefix)
  mode: 'range' | 'foreach';
  
  // For range mode
  init?: AstNode[];          // e.g., [SetVarNode for #i = 0]
  condition?: AstNode[];      // e.g., [BinaryNode for #i < 10]
  update?: AstNode[];         // e.g., [UnaryNode for #i++]
  
  // For foreach mode
  iterable?: AstNode;         // The array expression
  
  // Body (deferred AST nodes)
  body: AstNode[];
}

export interface BreakNode extends BaseNode { 
  type: 'break'; 
}

export interface ContinueNode extends BaseNode { 
  type: 'continue'; 
}
```

Update `AstNode` union and `ExecutionContext`:

```typescript
export interface ExecutionContext {
  // ... existing fields ...
  loopExit?: LoopExitType;
  loopVars?: Map<string, string>;  // Lexical loop variables
  loopDepth?: number;             // Current nesting depth
}
```

### 2. `src/utils/ast_parser/registry.ts`

Modify `parseCompute` handler to detect `for` keyword:

```typescript
const parseCompute: ParserHandler = (tokens, currentIndex, registry) => {
  // Look ahead for 'for' keyword
  if (tokens[currentIndex + 1] === 'for') {
    return parseForLoop(tokens, currentIndex, registry);
  }
  // ... existing compute logic ...
};
```

Add `parseForLoop` function with:
- Detect `for` keyword
- Parse loop variable (must start with `#`)
- Detect mode: `in` → foreach, `=` → range
- Parse loop header expressions (special handling for `#var =`, `#var++`, etc.)
- Parse body with `{ }` delimiters (track brace depth)
- Return `ForLoopNode`

Register new syntax via `createSyntaxRegistry` (no new start token needed - reusing `*(`).

### 3. `src/utils/ast_parser/evaluator.ts`

#### A. Update `ExecutionContext` initialization:

```typescript
export function createExecutionContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    // ... existing fields ...
    loopExit: undefined,
    loopVars: new Map<string, string>(),
    loopDepth: 0,
    ...overrides
  };
}
```

#### B. Add `evaluate` cases for `forLoop`, `break`, `continue`:

```typescript
case 'forLoop': {
  const forNode = node as ForLoopNode;
  
  // Check tier-based nesting limit
  const maxDepth = getMaxLoopDepth(context.userPlan);
  if ((context.loopDepth ?? 0) >= maxDepth) {
    return { value: '', context }; // Silent truncation
  }
  
  // Set up loop context
  const loopContext = { ...context, loopDepth: (context.loopDepth ?? 0) + 1 };
  const loopVars = new Map(loopContext.loopVars || []);
  
  let result = '';
  
  if (forNode.mode === 'foreach') {
    // Evaluate iterable
    const iterResult = await evaluate(forNode.iterable!, loopContext);
    const array = parseArrayResult(iterResult.value);
    
    for (const item of array) {
      loopVars.set(forNode.loopVar, item);
      const bodyContext = { ...loopContext, loopVars, loopExit: undefined };
      
      for (const bodyNode of forNode.body) {
        const bodyResult = await evaluate(bodyNode, bodyContext);
        if (bodyContext.loopExit === 'break') {
          return { value: '', context };
        }
        if (bodyContext.loopExit === 'continue') {
          break;
        }
        if (bodyResult.value) result = String(bodyResult.value);
      }
    }
  } else {
    // Range mode: init once, loop while condition true
    // Evaluate init
    for (const initNode of forNode.init!) {
      await evaluate(initNode, { ...loopContext, loopVars });
    }
    
    while (true) {
      // Check condition
      let conditionMet = true;
      for (const condNode of forNode.condition!) {
        const condResult = await evaluate(condNode, { ...loopContext, loopVars });
        if (!isTruthy(condResult.value)) {
          conditionMet = false;
          break;
        }
      }
      if (!conditionMet) break;
      
      // Execute body
      const bodyContext = { ...loopContext, loopVars, loopExit: undefined };
      for (const bodyNode of forNode.body) {
        const bodyResult = await evaluate(bodyNode, bodyContext);
        if (bodyContext.loopExit === 'break') {
          return { value: '', context };
        }
        if (bodyContext.loopExit === 'continue') {
          break;
        }
        if (bodyResult.value) result = String(bodyResult.value);
      }
      
      // Execute update
      for (const updateNode of forNode.update!) {
        await evaluate(updateNode, { ...loopContext, loopVars });
      }
    }
  }
  
  return { value: result, context };
}

case 'break':
  context.loopExit = 'break';
  return { value: '', context };

case 'continue':
  context.loopExit = 'continue';
  return { value: '', context };
```

#### C. Handle loop variable access:

In the `getVar` case, check `loopVars` before cache:

```typescript
case 'getVar': {
  // If in loop body and variable is in loopVars, use it
  if (context.loopVars?.has(node.name)) {
    return { value: context.loopVars.get(node.name), context };
  }
  // ... existing cache/db logic ...
}
```

#### D. Helper functions:

```typescript
function getMaxLoopDepth(plan: 'free' | 'premium' | 'pro'): number {
  switch (plan) {
    case 'free': return 0;    // No nesting
    case 'premium': return 1; // 1 level
    case 'pro': return 2;     // 2 levels
    default: return 0;
  }
}

function parseArrayResult(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return [value]; }
  }
  return [];
}

function isTruthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value === null || value === undefined) return false;
  return true;
}
```

### 4. `src/utils/ast_parser/functions/delay.functions.ts` (or create new)

Add break/continue function handlers:

```typescript
import type { ExecutionContext } from '../types.js';
import { registerFunction, type FunctionHandler } from '../evaluator.js';

const breakHandler: FunctionHandler = async (_args, ctx) => {
  ctx.loopExit = 'break';
  return '';
};

const continueHandler: FunctionHandler = async (_args, ctx) => {
  ctx.loopExit = 'continue';
  return '';
};

export function registerLoopControlFunctions(): void {
  registerFunction('break', breakHandler);
  registerFunction('continue', continueHandler);
}
```

Register in `src/utils/ast_parser/functions/index.ts`:

```typescript
import { registerLoopControlFunctions } from './delay.functions.js'; // or new file

export function registerAllFunctions(): void {
  // ... existing registrations ...
  registerLoopControlFunctions();
}
```

### 5. `src/utils/ast_parser/functions/index.ts`

No changes needed if registerLoopControlFunctions is called from delay.functions or a new dedicated file.

---

## Syntax Parsing Details

### Loop Variable Rules
- Must start with `#` followed by identifier: `#varname`
- The `#` is stripped when storing as loop variable name (e.g., `#i` → `"i"`)

### Range-Based Header Format (Strict)
```
for #varname = init; condition; update
```
- `init`: Single expression or assignment, e.g., `0` or `#i = 0`
- `condition`: Single expression that evaluates to truthy/falsy, e.g., `#i < 10`
- `update`: Single expression or unary op, e.g., `#i++` or `#i += 1`

### For-Each Header Format
```
for #varname in iterable
```
- `iterable`: Any expression that resolves to array, e.g., `%(myarray)` or `%(myarray[].filter "keyword")`

### Loop Header Assignment Handling
The following are recognized as loop-level expressions:
- `#var = value` → Set loop variable
- `#var++` → Increment (post/pre)
- `#var--` → Decrement
- `#var += n` → Compound add
- `#var -= n` → Compound subtract
- `#var *= n` → Compound multiply
- `#var /= n` → Compound divide

These are NOT parsed through normal expression logic - they're handled specially in the loop parser to extract the variable name and perform the operation.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Max nesting exceeded | Silent truncation (loop exits as if `$(break)`) |
| Empty array iteration | Silent success (0 iterations) |
| `$(break)` / `$(continue)` outside loop | Treated as no-op function call (returns `''`) |
| Invalid loop syntax | Parse error returned in `AstParseResult.error` |
| `#var` outside loop body | Literal string `#var` |

---

## Testing Scenarios

1. **Basic for-each**: `*(for #item in %(myarray) { $(item) })`
2. **Range loop**: `*(for #i = 0; #i < 3; #i++ { $(chat.send #i) })`
3. **Nested loops (pro)**: `*(for #i in %(a) { *(for #j in %(b) { #i-#j }) })`
4. **Break**: `*(for #i = 0; #i < 10; #i++ { *(if #i == 5 { $(break) }) #i })`
5. **Continue**: `*(for #i = 0; #i < 5; #i++ { *(if #i == 2 { $(continue) }) #i })`
6. **Loop var shadows cache**: If cache has `#count` and loop has `#count`, loop var wins inside body
7. **Cache access in loop**: `%(#count)` still accesses cache even inside loop body
8. **Free tier nesting block**: Free user tries nested loops - inner loop silently truncated
9. **Empty array**: `*(for #x in %(empty) { body })` → silent, no output
10. **Invalid syntax**: `*(for item in %(arr) { body })` (missing `#`) → parse error
