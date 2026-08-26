import type { TokenizeResult, SyntaxDefinition } from './types.js';
import { SyntaxRegistry } from './registry.js';

// Characters that can be escaped with a backslash inside literals.
// Used so text like `$(say hi :)\))` or `%(mood :\))` keeps the `)` as data
// instead of closing the expression early. The escape is preserved in the
// token stream (so `\)` never collides with a structural `)`) and only
// resolved when a literal node is created (see parseLiteral in registry.ts).
const ESCAPABLE_CHARS = new Set(['(', ')', '[', ']', '{', '}', ';', '?', ':', '\\']);
const ESCAPE_REGEX = /\\([()\[\]{};?:\\])/g;

export function unescapeLiteral(literal: string): string {
    return literal.includes('\\') ? literal.replace(ESCAPE_REGEX, '$1') : literal;
}

export function tokenize(input: string, registry: Map<string, SyntaxDefinition> = SyntaxRegistry): TokenizeResult {
    const tokens: string[] = [];
    let i = 0;
    
    const startTokens = Array.from(registry.keys());
    
    while (i < input.length) {
        const remaining = input.slice(i);

        if (remaining.startsWith('%[')) {
            let endIndex = i + 2;
            let depth = 1;
            let inQuote: 'single' | 'double' | null = null;

            while (endIndex < input.length && depth > 0) {
                const char = input[endIndex];

                if (inQuote) {
                    if (char === '\\') {
                        endIndex += 2;
                        continue;
                    }

                    if ((inQuote === 'single' && char === '\'') || (inQuote === 'double' && char === '"')) {
                        inQuote = null;
                    }

                    endIndex++;
                    continue;
                }

                if (char === '"') {
                    inQuote = 'double';
                    endIndex++;
                    continue;
                }

                if (char === '\'') {
                    inQuote = 'single';
                    endIndex++;
                    continue;
                }

                if (char === '[') {
                    depth++;
                    endIndex++;
                    continue;
                }

                if (char === ']') {
                    depth--;
                    if (depth === 0) {
                        break;
                    }
                }

                endIndex++;
            }

            if (depth === 0) {
                const content = input.slice(i + 2, endIndex);
                tokens.push(`__ARRAY__:${content}`);
                i = endIndex + 1;
                continue;
            }
        }

        if (remaining.startsWith('http://') || remaining.startsWith('https://')) {
            let urlEnd = i;

            while (urlEnd < input.length) {
                const char = input[urlEnd];
                const slice = input.slice(urlEnd);

                if (/\s/.test(char)) break;

                let isStartToken = false;
                for (const startToken of startTokens) {
                    if (slice.startsWith(startToken)) {
                        isStartToken = true;
                        break;
                    }
                }

                if (isStartToken) break;

                urlEnd++;
            }

            if (urlEnd > i) {
                tokens.push(input.slice(i, urlEnd));
                i = urlEnd;
                continue;
            }
        }
        
        let matched = false;
        
        for (const startToken of startTokens) {
            if (remaining.startsWith(startToken)) {
                tokens.push(startToken);
                i += startToken.length;
                matched = true;
                break;
            }
        }
        
        if (matched) continue;
        
        if (remaining[0] === ')') {
            tokens.push(')');
            i += 1;
            continue;
        }
        
        if (remaining[0] === '[') {
            tokens.push('[');
            i += 1;
            continue;
        }
        
        if (remaining[0] === ']') {
            tokens.push(']');
            i += 1;
            continue;
        }

        if (remaining[0] === '{') {
            tokens.push('{');
            i += 1;
            continue;
        }

        if (remaining[0] === '}') {
            tokens.push('}');
            i += 1;
            continue;
        }

        if (remaining[0] === ';') {
            tokens.push(';');
            i += 1;
            continue;
        }
        
        if (remaining[0] === '.') {
            tokens.push('.');
            i += 1;
            continue;
        }
        
        if (remaining[0] === '"') {
            let endQuote = i + 1;
            let braceDepth = 0;
            
            while (endQuote < input.length) {
                const char = input[endQuote];
                
                if (char === '\\' && endQuote + 1 < input.length) {
                    endQuote += 2;
                    continue;
                }
                
                if (endQuote + 1 < input.length && char === '$' && input[endQuote + 1] === '{') {
                    braceDepth++;
                    endQuote += 2;
                    continue;
                }
                
                if (braceDepth > 0) {
                    if (char === '{') {
                        braceDepth++;
                    } else if (char === '}') {
                        braceDepth--;
                    }
                    endQuote++;
                    continue;
                }
                
                if (char === '"') {
                    break;
                }
                
                endQuote++;
            }
            
            const quotedContent = input.slice(i + 1, endQuote);
            tokens.push(`__TEMPLATE__:${quotedContent}`);
            i = endQuote + 1;
            continue;
        }
        
        if (remaining[0] === '?') {
            tokens.push('?');
            i += 1;
            continue;
        }
        
        if (remaining[0] === ':') {
            tokens.push(':');
            i += 1;
            continue;
        }
        
        if (remaining[0] === '(') {
            tokens.push('(');
            i += 1;
            continue;
        }
        
        const compoundOpMatch = remaining.match(/^(\+\+|--|\+=|-=|\*=|\/=|%=)/);
        if (compoundOpMatch) {
            tokens.push(compoundOpMatch[1]);
            i += compoundOpMatch[1].length;
            continue;
        }

        if (remaining[0] === '+') {
            const next = remaining[1];
            if (next && /[a-zA-Z_]/.test(next)) {
                // Don't tokenize + as operator if followed by letter (unary plus on variable)
            } else {
                tokens.push('+');
                i += 1;
                continue;
            }
        }
        
        if (remaining[0] === '/') {
            tokens.push('/');
            i += 1;
            continue;
        }
        
        if (remaining[0] === '-' && remaining.length > 1 && remaining[1] !== '>') {
            const next = remaining[1];
            if (/[a-zA-Z_]/.test(next)) {
                // Don't tokenize - as operator if followed by letter (could be variable name or unary minus)
            } else {
                tokens.push('-');
                i += 1;
                continue;
            }
        }
        
        if (remaining[0] === '%' && remaining.length > 1 && remaining[1] !== '(') {
            const next = remaining[1];
            if (/[a-zA-Z_#*]/.test(next)) {
                // Don't tokenize % as operator if followed by letter or prefix chars (variable name)
            } else {
                tokens.push('%');
                i += 1;
                continue;
            }
        }
        
        if (remaining[0] === '*' && remaining.length > 1 && remaining[1] !== '(') {
            const next = remaining[1];
            if (/[a-zA-Z_#*]/.test(next)) {
                // Don't tokenize * as operator if followed by letter or prefix chars (variable name like *deaths or **myvar)
            } else {
                tokens.push('*');
                i += 1;
                continue;
            }
        }
        
        // Handle bare # that could be part of a variable prefix
        if (remaining[0] === '#' && remaining.length > 1 && remaining[1] !== '(') {
            const next = remaining[1];
            if (/[a-zA-Z_#]/.test(next)) {
                // Don't tokenize # as separate if followed by letter or another # (variable name like #var or ##var)
            } else {
                tokens.push('#');
                i += 1;
                continue;
            }
        }
        
        const opMatch = remaining.match(/^(==|!=|>=|<=|~=|<>|[=<>])/);
        if (opMatch) {
            tokens.push(opMatch[1]);
            i += opMatch[1].length;
            continue;
        }
        
        if (/\s/.test(remaining[0])) {
            i += 1;
            continue;
        }
        
        let literalEnd = i;
        let hasNonPrefixChar = false;
        while (literalEnd < input.length) {
            const char = input[literalEnd];
            const slice = input.slice(literalEnd);

            // Backslash escape: keep `\X` (X in ESCAPABLE_CHARS) inside the literal
            // so escaped structural chars (e.g. `\)`) don't terminate the literal.
            if (char === '\\' && literalEnd + 1 < input.length && ESCAPABLE_CHARS.has(input[literalEnd + 1])) {
                hasNonPrefixChar = true;
                literalEnd += 2;
                continue;
            }

            if (/\s/.test(char)) break;
            if (char === ')') break;
            if (char === '{' || char === '}') break;
            if (char === ';') break;
            if (char === '?' || char === ':') break;
            if (char === '[' || char === ']') break;
            if (char === '.') {
                // Keep digit.dot.digit sequences (decimal literals like 5.5) as one
                // token; split every other `.` (member access like .length).
                const prev = input[literalEnd - 1];
                const next = input[literalEnd + 1];
                if (!(prev !== undefined && next !== undefined && /\d/.test(prev) && /\d/.test(next))) break;
            }
            if (char === '(') break;
            if (char === '+' || char === '/') break;
            if (char === '-' && literalEnd > i) break;
            
            // Allow * and # at start of literal (for prefixes like *, **, #, ##)
            // Only break on them after we've seen a non-prefix character
            if (char === '*' || char === '#') {
                if (hasNonPrefixChar) {
                    break;
                }
                // It's part of prefix, continue
            } else if (char === '%' && !slice.startsWith('%(')) {
                if (literalEnd > i) break;
            } else {
                hasNonPrefixChar = true;
            }
            
            let isStartToken = false;
            for (const startToken of startTokens) {
                if (slice.startsWith(startToken)) {
                    isStartToken = true;
                    break;
                }
            }
            if (isStartToken) break;
            
            const opMatch = slice.match(/^(==|!=|>=|<=|~=|<>|[=<>])/);
            if (opMatch) break;
            
            literalEnd++;
        }
        
        if (literalEnd > i) {
            // Keep escape sequences intact here; they are resolved in parseLiteral
            // so an escaped `\)` token never equals the structural `)` token.
            tokens.push(input.slice(i, literalEnd));
            i = literalEnd;
        } else {
            i++;
        }
    }
    
    return { tokens };
}
