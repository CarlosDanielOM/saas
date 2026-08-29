import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { parse } from './parser.js';
import type {
    ArrayLiteralNode,
    AstNode,
    BinaryExpressionNode,
    CommandRefNode,
    CustomNode,
    EvaluateResult,
    ExecutionContext,
    ExistsNode,
    ForLoopNode,
    FunctionNode,
    GetVarNode,
    LiteralNode,
    LoopAssignNode,
    LoopVarNode,
    RootNode,
    SetVarNode,
    TemplateNode,
    TernaryExpressionNode,
    UnaryExpressionNode,
    VariableStorage,
    DeleteVarNode,
    ArrayAccessor,
    FunctionMetadata
} from './types.js';

type InternalComparisonOperator = '==' | '=' | '!=' | '<>' | '>' | '<' | '>=' | '<=' | '~=';

function toNumberSafe(value: unknown): number {
    if (typeof value === 'number' && !isNaN(value) && isFinite(value)) {
        return value;
    }
    const str = String(value ?? '').trim();
    if (str === '' || str === 'null' || str === 'undefined') {
        return 0;
    }
    const num = parseFloat(str);
    return isNaN(num) || !isFinite(num) ? 0 : num;
}

function isTruthy(value: unknown): boolean {
    if (value === true || value === 1) return true;
    if (value === false || value === 0 || value === null || value === undefined) return false;
    const str = String(value).toLowerCase().trim();
    if (str === 'true' || str === '1') return true;
    if (str === 'false' || str === '0' || str === '') return false;
    return true;
}

function stripVarPrefix(name: string, storage: VariableStorage): string {
    switch (storage) {
        case 'dbUser':
            return name.startsWith('**') ? name.slice(2) : name;
        case 'db':
            return name.startsWith('*') && !name.startsWith('**') ? name.slice(1) : name;
        case 'cacheUser':
            return name.startsWith('##') ? name.slice(2) : name;
        case 'cache':
            return name.startsWith('#') && !name.startsWith('##') ? name.slice(1) : name;
        default:
            return name;
    }
}

function safeCompare(left: string, operator: InternalComparisonOperator, right: string): boolean {
    const trimmedLeft = String(left).trim();
    const trimmedRight = String(right).trim();

    // Full-string numeric check: parseFloat would treat "5abc" as 5
    const NUMERIC_REGEX = /^-?\d+(\.\d+)?$/;
    const bothNumeric = NUMERIC_REGEX.test(trimmedLeft) && NUMERIC_REGEX.test(trimmedRight);
    const leftNum = bothNumeric ? Number(trimmedLeft) : NaN;
    const rightNum = bothNumeric ? Number(trimmedRight) : NaN;

    switch (operator) {
        case '==':
        case '=':
            return bothNumeric ? leftNum === rightNum : trimmedLeft.toLowerCase() === trimmedRight.toLowerCase();
        case '!=':
        case '<>':
            return bothNumeric ? leftNum !== rightNum : trimmedLeft.toLowerCase() !== trimmedRight.toLowerCase();
        case '>':
            return bothNumeric ? leftNum > rightNum : trimmedLeft > trimmedRight;
        case '<':
            return bothNumeric ? leftNum < rightNum : trimmedLeft < trimmedRight;
        case '>=':
            return bothNumeric ? leftNum >= rightNum : trimmedLeft >= trimmedRight;
        case '<=':
            return bothNumeric ? leftNum <= rightNum : trimmedLeft <= trimmedRight;
        case '~=':
            return trimmedLeft.toLowerCase().includes(trimmedRight.toLowerCase());
        default:
            return false;
    }
}

function buildCacheKey(
    platform: string,
    channelId: string,
    scopeType: string,
    scopeName: string,
    varName: string,
    userScope?: string
): string {
    const normalizedScopeName = String(scopeName || '').trim().replace(/\s+/g, '_') || 'default';
    const normalizedScopeType = String(scopeType || '').trim() || 'command';

    if (userScope) {
        return `${platform}:${channelId}:scope:${normalizedScopeType}:${normalizedScopeName}:${varName}:${userScope}`;
    }
    return `${platform}:${channelId}:scope:${normalizedScopeType}:${normalizedScopeName}:${varName}`;
}

// Resolves an array index expression value against an array length.
// Supports negative indexes (`-1` = last element). Returns -1 when invalid/out of range.
function resolveArrayIndex(value: unknown, length: number): number {
    let idx = typeof value === 'number' ? Math.trunc(value) : parseInt(String(value).trim(), 10);
    if (!Number.isFinite(idx)) return -1;
    if (idx < 0) idx = length + idx;
    return idx >= 0 && idx < length ? idx : -1;
}

type DragonflyClient = Awaited<ReturnType<typeof getDragonflyClient>>;

// Iterates every candidate cache key for a variable (scope aliases × user scopes),
// stopping early when fn signals a hit by returning true.
async function walkCacheKeys(
    name: string,
    storage: VariableStorage,
    context: ExecutionContext,
    targetUserLogin: string | undefined,
    fn: (key: string, redis: DragonflyClient) => Promise<boolean | void>
): Promise<boolean> {
    const redis = await getDragonflyClient();
    const strippedName = stripVarPrefix(name, storage);
    const scopeCandidates = getScopeCandidates(context);
    const userScopeCandidates = storage === 'cacheUser'
        ? getCacheUserScopeCandidates(context, targetUserLogin)
        : [undefined];

    for (const scopeName of scopeCandidates) {
        for (const userScope of userScopeCandidates) {
            const key = buildCacheKey(
                context.platform,
                context.broadcasterId,
                context.scopeType,
                scopeName,
                strippedName,
                userScope
            );
            const hit = await fn(key, redis);
            if (hit === true) return true;
        }
    }

    return false;
}

function normalizeUserLogin(login: string): string {
    return String(login || '').trim().replace(/^@+/, '').toLowerCase();
}

function getCacheUserScopeCandidates(context: ExecutionContext, targetUserLogin?: string): string[] {
    const normalizedTarget = normalizeUserLogin(String(targetUserLogin || ''));
    if (normalizedTarget) {
        return [`login:${normalizedTarget}`];
    }

    const candidates: string[] = [];
    if (context.userId) {
        candidates.push(`id:${context.userId}`);
    }
    const normalizedCurrentLogin = normalizeUserLogin(context.userLogin);
    if (normalizedCurrentLogin) {
        candidates.push(`login:${normalizedCurrentLogin}`);
    }

    return candidates.length > 0 ? [...new Set(candidates)] : ['id:unknown'];
}

function getScopeCandidates(context: ExecutionContext): string[] {
    const candidates = [context.scopeName, ...(context.scopeAliases || [])]
        .map((scope) => String(scope || '').trim())
        .filter((scope) => scope.length > 0);

    if (candidates.length === 0) {
        return ['default'];
    }

    return [...new Set(candidates)];
}

function canWriteDbVariables(plan: 'free' | 'premium' | 'pro'): boolean {
    return plan === 'premium' || plan === 'pro';
}

function getMaxLoopDepth(plan: 'free' | 'premium' | 'pro'): number {
    switch (plan) {
        case 'free':
            return 2;
        case 'premium':
            return 3;
        case 'pro':
            return 4;
        default:
            return 2;
    }
}

function getMaxLoopIterations(plan: 'free' | 'premium' | 'pro'): number {
    switch (plan) {
        case 'free':
            return 25;
        case 'premium':
            return 50;
        case 'pro':
            return 100;
        default:
            return 25;
    }
}

function parseIterableValue(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((item) => String(item ?? ''));
    }

    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) {
                return parsed.map((item) => String(item ?? ''));
            }
        } catch {
            return value === '' ? [] : [value];
        }
    }

    return value === undefined || value === null ? [] : [String(value)];
}

function getLoopVarValue(context: ExecutionContext, name: string): string | undefined {
    return context.loopVars?.get(name);
}

function setLoopVarValue(context: ExecutionContext, name: string, value: string): void {
    if (!context.loopVars) {
        context.loopVars = new Map<string, string>();
    }

    context.loopVars.set(name, value);
}

function applyLoopAssignment(currentValue: string | undefined, operator: LoopAssignNode['operator'], value?: unknown): string {
    if (operator === '++') {
        return String(toNumberSafe(currentValue) + 1);
    }

    if (operator === '--') {
        return String(toNumberSafe(currentValue) - 1);
    }

    const nextValue = String(value ?? '');
    if (operator === '=') {
        return nextValue;
    }

    if (operator === '+=') {
        const leftNum = Number(String(currentValue ?? '').trim());
        const rightNum = Number(String(nextValue).trim());
        const bothNumeric = Number.isFinite(leftNum) && Number.isFinite(rightNum);
        return bothNumeric ? String(leftNum + rightNum) : `${currentValue ?? ''}${nextValue}`;
    }

    const leftNum = toNumberSafe(currentValue);
    const rightNum = toNumberSafe(nextValue);

    switch (operator) {
        case '-=':
            return String(leftNum - rightNum);
        case '*=':
            return String(leftNum * rightNum);
        case '/=':
            return String(rightNum === 0 ? 0 : leftNum / rightNum);
        case '%=':
            return String(rightNum === 0 ? 0 : leftNum % rightNum);
        default:
            return nextValue;
    }
}

async function getValueFromStorage(
    name: string,
    storage: VariableStorage,
    context: ExecutionContext,
    targetUserLogin?: string
): Promise<string> {
    const strippedName = stripVarPrefix(name, storage);

    switch (storage) {
        case 'memory': {
            const val = context.variables.get(strippedName);
            if (val !== undefined) return String(val);
            const arr = context.arrays.get(strippedName);
            if (arr) return JSON.stringify(arr);
            return '';
        }

        case 'cache':
        case 'cacheUser': {
            let found = '';
            await walkCacheKeys(name, storage, context, targetUserLogin, async (key, redis) => {
                const cached = await redis.get(key);
                if (cached !== null && cached !== undefined) {
                    found = cached;
                    return true;
                }
                return false;
            });
            return found;
        }

        case 'db': {
            if (context.commandVariables.has(strippedName)) {
                return context.commandVariables.get(strippedName) ?? '';
            }
            const loadedValue = await context.loadChannelVariable(strippedName);
            if (loadedValue !== undefined && loadedValue !== null && loadedValue !== '') {
                context.commandVariables.set(strippedName, loadedValue);
                return loadedValue;
            }
            return '';
        }

        case 'dbUser': {
            if (context.userCommandVariables.has(strippedName)) {
                return context.userCommandVariables.get(strippedName) ?? '';
            }
            const loadedValue = await context.loadUserVariable(strippedName, targetUserLogin);
            if (loadedValue !== undefined && loadedValue !== null && loadedValue !== '') {
                context.userCommandVariables.set(strippedName, loadedValue);
                return loadedValue;
            }
            return '';
        }

        default:
            return '';
    }
}

async function getArrayFromStorage(
    name: string,
    storage: VariableStorage,
    context: ExecutionContext,
    targetUserLogin?: string
): Promise<string[]> {
    if (name === 'responses' && storage === 'memory') {
        return context.commandResponses;
    }

    const value = await getValueFromStorage(name, storage, context, targetUserLogin);
    if (!value) return [];

    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [String(parsed)];
    } catch {
        return [];
    }
}

async function checkKeyExists(
    name: string,
    storage: VariableStorage,
    context: ExecutionContext,
    targetUserLogin?: string
): Promise<boolean> {
    const strippedName = stripVarPrefix(name, storage);

    switch (storage) {
        case 'memory': {
            if (context.variables.has(strippedName)) return true;
            if (context.arrays.has(strippedName)) return true;
            return false;
        }

        case 'cache':
        case 'cacheUser': {
            return walkCacheKeys(name, storage, context, targetUserLogin, async (key, redis) => {
                const exists = await redis.exists(key);
                return exists === 1;
            });
        }

        case 'db': {
            if (context.commandVariables.has(strippedName)) {
                return true;
            }
            const loadedValue = await context.loadChannelVariable(strippedName);
            if (loadedValue !== undefined && loadedValue !== null && loadedValue !== '') {
                context.commandVariables.set(strippedName, loadedValue);
                return true;
            }
            return false;
        }

        case 'dbUser': {
            if (context.userCommandVariables.has(strippedName)) {
                return true;
            }
            const loadedValue = await context.loadUserVariable(strippedName, targetUserLogin);
            if (loadedValue !== undefined && loadedValue !== null && loadedValue !== '') {
                context.userCommandVariables.set(strippedName, loadedValue);
                return true;
            }
            return false;
        }

        default:
            return false;
    }
}

async function checkArrayKeyExists(
    name: string,
    storage: VariableStorage,
    context: ExecutionContext,
    targetUserLogin?: string
): Promise<boolean> {
    if (name === 'responses' && storage === 'memory') {
        return context.commandResponses.length > 0;
    }

    return checkKeyExists(name, storage, context, targetUserLogin);
}

async function saveValueToStorage(
    name: string,
    storage: VariableStorage,
    value: string,
    context: ExecutionContext
): Promise<void> {
    const strippedName = stripVarPrefix(name, storage);

    if ((storage === 'db' || storage === 'dbUser') && !canWriteDbVariables(context.userPlan)) {
        return;
    }

    switch (storage) {
        case 'memory': {
            context.variables.set(strippedName, value);
            break;
        }

        case 'cache':
        case 'cacheUser': {
            const redis = await getDragonflyClient();
            if (storage === 'cacheUser') {
                const userScopeCandidates = getCacheUserScopeCandidates(context);
                for (const userScope of userScopeCandidates) {
                    const key = buildCacheKey(
                        context.platform,
                        context.broadcasterId,
                        context.scopeType,
                        context.scopeName,
                        strippedName,
                        userScope
                    );
                    await redis.set(key, value);
                    await redis.expire(key, 86400);
                }
            } else {
                const key = buildCacheKey(
                    context.platform,
                    context.broadcasterId,
                    context.scopeType,
                    context.scopeName,
                    strippedName
                );
                await redis.set(key, value);
                await redis.expire(key, 86400);
            }
            break;
        }

        case 'db':
            await context.saveChannelVariable(strippedName, value);
            context.commandVariables.set(strippedName, value);
            break;

        case 'dbUser':
            await context.saveUserVariable(strippedName, value);
            context.userCommandVariables.set(strippedName, value);
            break;
    }
}

async function deleteValueFromStorage(
    name: string,
    storage: VariableStorage,
    context: ExecutionContext,
    accessor?: ArrayAccessor,
    targetUserLogin?: string
): Promise<void> {
    const strippedName = stripVarPrefix(name, storage);

    switch (storage) {
        case 'memory': {
            if (!accessor) {
                context.variables.delete(strippedName);
                context.arrays.delete(strippedName);
            } else if (accessor.type === 'clear') {
                context.variables.delete(strippedName);
                context.arrays.delete(strippedName);
            } else if (accessor.type === 'remove') {
                const arrStr = context.variables.get(strippedName) as string | undefined;
                let arr: string[] = [];
                if (arrStr) {
                    try {
                        arr = JSON.parse(arrStr);
                        if (!Array.isArray(arr)) arr = [];
                    } catch {
                        arr = [];
                    }
                }
                const idxResult = await evaluate(accessor.index, context);
                const idx = resolveArrayIndex(idxResult.value, arr.length);
                if (idx >= 0) {
                    arr.splice(idx, 1);
                    context.variables.set(strippedName, JSON.stringify(arr));
                }
            }
            break;
        }

        case 'cache':
        case 'cacheUser': {
            if (!accessor || accessor.type === 'clear') {
                // Delete entire variable / clear entire array
                await walkCacheKeys(name, storage, context, targetUserLogin, async (key, redis) => {
                    await redis.del(key);
                });
            } else if (accessor.type === 'remove') {
                // Remove specific index
                const idxResult = await evaluate(accessor.index, context);
                await walkCacheKeys(name, storage, context, targetUserLogin, async (key, redis) => {
                    const value = await redis.get(key);
                    if (!value) return;

                    try {
                        const arr = JSON.parse(value);
                        if (!Array.isArray(arr)) return;

                        const idx = resolveArrayIndex(idxResult.value, arr.length);
                        if (idx >= 0) {
                            arr.splice(idx, 1);
                            await redis.set(key, JSON.stringify(arr));
                            await redis.expire(key, 86400);
                        }
                    } catch {
                        // Not a JSON array, ignore
                    }
                });
            }
            break;
        }

        case 'db':
        case 'dbUser': {
            if (!accessor) {
                // Delete entire variable from context caches
                if (storage === 'db') {
                    context.commandVariables.delete(strippedName);
                } else {
                    context.userCommandVariables.delete(strippedName);
                }
            } else if (accessor.type === 'clear' || accessor.type === 'remove') {
                // For db arrays, load, modify, save
                let currentValue = '';
                if (storage === 'db') {
                    currentValue = context.commandVariables.get(strippedName) ?? '';
                    if (!currentValue) {
                        currentValue = await context.loadChannelVariable(strippedName);
                    }
                } else {
                    currentValue = context.userCommandVariables.get(strippedName) ?? '';
                    if (!currentValue) {
                        currentValue = await context.loadUserVariable(strippedName, targetUserLogin);
                    }
                }

                if (currentValue) {
                    try {
                        let arr = JSON.parse(currentValue);
                        if (Array.isArray(arr)) {
                            if (accessor.type === 'clear') {
                                arr = [];
                            } else {
                                const idxResult = await evaluate(accessor.index, context);
                                const idx = resolveArrayIndex(idxResult.value, arr.length);
                                if (idx >= 0) {
                                    arr.splice(idx, 1);
                                }
                            }
                            const newValue = JSON.stringify(arr);
                            if (storage === 'db') {
                                await context.saveChannelVariable(strippedName, newValue);
                                context.commandVariables.set(strippedName, newValue);
                            } else {
                                await context.saveUserVariable(strippedName, newValue);
                                context.userCommandVariables.set(strippedName, newValue);
                            }
                        }
                    } catch {
                        // Not a JSON array, ignore
                    }
                }
            }
            break;
        }
    }
}

export type FunctionHandler = (args: unknown[], context: ExecutionContext) => Promise<unknown>;

const functionRegistry = new Map<string, FunctionHandler>();
const functionMetadataRegistry = new Map<string, FunctionMetadata>();

export function registerFunction(name: string, handler: FunctionHandler, metadata?: FunctionMetadata): void {
    functionRegistry.set(name, handler);
    if (metadata) {
        functionMetadataRegistry.set(name, metadata);
    }
}

export function getFunctionHandler(name: string): FunctionHandler | undefined {
    return functionRegistry.get(name);
}

export function getFunctionMetadata(name: string): FunctionMetadata | undefined {
    return functionMetadataRegistry.get(name);
}

export interface RegisteredFunctionEntry {
    name: string;
    handler: FunctionHandler;
    metadata?: FunctionMetadata;
}

export function getAllRegisteredFunctions(): RegisteredFunctionEntry[] {
    return [...functionRegistry.keys()].map((name) => ({
        name,
        handler: functionRegistry.get(name) as FunctionHandler,
        metadata: functionMetadataRegistry.get(name)
    }));
}

export async function evaluate(node: AstNode, context: ExecutionContext): Promise<EvaluateResult> {
    switch (node.type) {
        case 'literal': {
            const literalNode = node as LiteralNode;
            return { value: literalNode.value, context };
        }

        case 'loopVar': {
            const loopVarNode = node as LoopVarNode;
            const loopValue = getLoopVarValue(context, loopVarNode.name);
            return { value: loopValue ?? `#${loopVarNode.name}`, context };
        }

        case 'loopAssign': {
            const loopAssignNode = node as LoopAssignNode;
            let nextValue: unknown;
            let currentContext = context;

            if (loopAssignNode.value) {
                const valueResult = await evaluate(loopAssignNode.value, context);
                nextValue = valueResult.value;
                currentContext = valueResult.context;
            }

            const currentValue = getLoopVarValue(currentContext, loopAssignNode.name);
            const resolvedValue = applyLoopAssignment(currentValue, loopAssignNode.operator, nextValue);
            setLoopVarValue(currentContext, loopAssignNode.name, resolvedValue);
            return { value: resolvedValue, context: currentContext };
        }

        case 'getVar': {
            const getNode = node as GetVarNode;
            const { name, storage, accessor, userSelector } = getNode;
            let targetUserLogin: string | undefined;
            let workingContext = context;

            if ((storage === 'cacheUser' || storage === 'dbUser') && userSelector) {
                const selectorResult = await evaluate(userSelector, workingContext);
                targetUserLogin = String(selectorResult.value ?? '').trim();
                workingContext = selectorResult.context;
            }

            if (name === 'responses' && storage === 'memory') {
                if (!accessor) {
                    return { value: JSON.stringify(context.commandResponses), context };
                }

                switch (accessor.type) {
                    case 'array': {
                        return { value: JSON.stringify(context.commandResponses), context };
                    }

                    case 'index': {
                        const indexResult = await evaluate(accessor.index, context);
                        const index = resolveArrayIndex(indexResult.value, context.commandResponses.length);
                        if (index < 0) {
                            return { value: '', context };
                        }
                        return { value: context.commandResponses[index], context };
                    }

                    case 'random': {
                        if (context.commandResponses.length === 0) return { value: '', context };
                        const idx = Math.floor(Math.random() * context.commandResponses.length);
                        return { value: context.commandResponses[idx], context };
                    }

                    case 'length': {
                        return { value: String(context.commandResponses.length), context };
                    }
                }
                return { value: '', context };
            }

            if (!accessor) {
                const value = await getValueFromStorage(name, storage, workingContext, targetUserLogin);
                return { value, context: workingContext };
            }

            const arrayData = await getArrayFromStorage(name, storage, workingContext, targetUserLogin);

            switch (accessor.type) {
                case 'array': {
                    return { value: JSON.stringify(arrayData), context: workingContext };
                }

                case 'index': {
                    const indexResult = await evaluate(accessor.index, workingContext);
                    const index = resolveArrayIndex(indexResult.value, arrayData.length);
                    if (index < 0) {
                        return { value: '', context: workingContext };
                    }
                    return { value: arrayData[index], context: workingContext };
                }

                case 'random': {
                    if (arrayData.length === 0) return { value: '', context: workingContext };
                    const idx = Math.floor(Math.random() * arrayData.length);
                    return { value: arrayData[idx], context: workingContext };
                }

                case 'length': {
                    return { value: String(arrayData.length), context: workingContext };
                }
            }
            return { value: '', context: workingContext };
        }

        case 'setVar': {
            const setNode = node as SetVarNode;
            const { name, storage, value, accessor } = setNode;
            const valueResult = await evaluate(value, context);
            const valueStr = String(valueResult.value);
            let currentContext = valueResult.context;
            const appendValues = Array.isArray(valueResult.value)
                ? valueResult.value.map((item) => String(item))
                : [valueStr];

            if (name === 'responses' && storage === 'memory') {
                if (accessor?.type === 'append') {
                    context.commandResponses.push(...appendValues);
                    await context.saveResponses();
                    return { value: '', context: currentContext };
                }

                if (accessor?.type === 'setIndex') {
                    const indexResult = await evaluate(accessor.index, currentContext);
                    const index = resolveArrayIndex(indexResult.value, context.commandResponses.length);
                    if (index >= 0) {
                        context.commandResponses[index] = valueStr;
                        await context.saveResponses();
                    }
                    return { value: '', context: indexResult.context };
                }
                return { value: '', context: currentContext };
            }

            if (!accessor) {
                await saveValueToStorage(name, storage, valueStr, context);
                return { value: '', context: currentContext };
            }

            const arrayData = await getArrayFromStorage(name, storage, context);

            switch (accessor.type) {
                case 'append': {
                    arrayData.push(...appendValues);
                    await saveValueToStorage(name, storage, JSON.stringify(arrayData), context);
                    return { value: '', context: currentContext };
                }

                case 'setIndex': {
                    const indexResult = await evaluate(accessor.index, currentContext);
                    const index = resolveArrayIndex(indexResult.value, arrayData.length);
                    if (index >= 0) {
                        arrayData[index] = valueStr;
                        await saveValueToStorage(name, storage, JSON.stringify(arrayData), context);
                    }
                    return { value: '', context: indexResult.context };
                }
            }
            return { value: '', context: currentContext };
        }

        case 'function': {
            const funcNode = node as FunctionNode;
            // Evaluate args sequentially, threading context, so side effects
            // (e.g. `$(fn %(a 1) %(a 2))`) apply in deterministic left-to-right order.
            const args: unknown[] = [];
            let currentContext = context;

            for (const arg of funcNode.args) {
                const argResult = await evaluate(arg, currentContext);
                currentContext = argResult.context;
                args.push(argResult.value);
            }

            const handler = functionRegistry.get(funcNode.name);
            if (!handler) {
                return { value: `[Unknown function: ${funcNode.name}]`, context: currentContext };
            }

            const result = await handler(args, currentContext);
            return { value: result, context: currentContext };
        }

        case 'exists': {
            const existsNode = node as ExistsNode;
            const { name, storage, accessor, userSelector } = existsNode;
            let targetUserLogin: string | undefined;
            let workingContext = context;

            if ((storage === 'cacheUser' || storage === 'dbUser') && userSelector) {
                const selectorResult = await evaluate(userSelector, workingContext);
                targetUserLogin = String(selectorResult.value ?? '').trim();
                workingContext = selectorResult.context;
            }

            if (name === 'responses' && storage === 'memory') {
                if (!accessor) {
                    return { value: context.commandResponses.length > 0 ? 'true' : 'false', context };
                }

                switch (accessor.type) {
                    case 'array': {
                        return { value: context.commandResponses.length > 0 ? 'true' : 'false', context };
                    }

                    case 'index': {
                        const indexResult = await evaluate(accessor.index, context);
                        const exists = resolveArrayIndex(indexResult.value, context.commandResponses.length) >= 0;
                        return { value: exists ? 'true' : 'false', context: indexResult.context };
                    }

                    case 'random': {
                        return { value: context.commandResponses.length > 0 ? 'true' : 'false', context };
                    }

                    case 'length': {
                        return { value: 'true', context };
                    }
                }
                return { value: 'false', context };
            }

            if (!accessor) {
                const exists = await checkKeyExists(name, storage, workingContext, targetUserLogin);
                return { value: exists ? 'true' : 'false', context: workingContext };
            }

            const arrayExists = await checkArrayKeyExists(name, storage, workingContext, targetUserLogin);

            switch (accessor.type) {
                case 'array': {
                    return { value: arrayExists ? 'true' : 'false', context: workingContext };
                }

                case 'index': {
                    if (!arrayExists) {
                        return { value: 'false', context: workingContext };
                    }
                    const arrayData = await getArrayFromStorage(name, storage, workingContext, targetUserLogin);
                    const indexResult = await evaluate(accessor.index, workingContext);
                    const exists = resolveArrayIndex(indexResult.value, arrayData.length) >= 0;
                    return { value: exists ? 'true' : 'false', context: indexResult.context };
                }

                case 'random': {
                    if (!arrayExists) {
                        return { value: 'false', context: workingContext };
                    }
                    const arrayData = await getArrayFromStorage(name, storage, workingContext, targetUserLogin);
                    return { value: arrayData.length > 0 ? 'true' : 'false', context: workingContext };
                }

                case 'length': {
                    return { value: arrayExists ? 'true' : 'false', context: workingContext };
                }
            }
            return { value: 'false', context: workingContext };
        }

        case 'deleteVar': {
            const delNode = node as DeleteVarNode;
            const { name, storage, accessor, userSelector } = delNode;
            let targetUserLogin: string | undefined;
            let workingContext = context;

            if ((storage === 'cacheUser' || storage === 'dbUser') && userSelector) {
                const selectorResult = await evaluate(userSelector, workingContext);
                targetUserLogin = String(selectorResult.value ?? '').trim();
                workingContext = selectorResult.context;
            }

            await deleteValueFromStorage(name, storage, workingContext, accessor, targetUserLogin);
            return { value: '', context: workingContext };
        }

        case 'binary': {
            const binaryNode = node as BinaryExpressionNode;
            const { operator, left, right } = binaryNode;

            const leftResult = await evaluate(left, context);
            const rightResult = await evaluate(right, leftResult.context);
            const evalContext = rightResult.context;

            const arithmeticOps = ['+', '-', '*', '/', '%'];
            const comparisonOps = ['==', '!=', '>=', '<=', '>', '<', '=', '~=', '<>'];

            if (arithmeticOps.includes(operator)) {
                const leftNum = toNumberSafe(leftResult.value);
                const rightNum = toNumberSafe(rightResult.value);

                let result: number;
                switch (operator) {
                    case '+': result = leftNum + rightNum; break;
                    case '-': result = leftNum - rightNum; break;
                    case '*': result = leftNum * rightNum; break;
                    case '/':
                        result = rightNum === 0 ? 0 : leftNum / rightNum;
                        break;
                    case '%':
                        result = rightNum === 0 ? 0 : leftNum % rightNum;
                        break;
                    default: result = 0;
                }

                const intResult = Number.isInteger(result) ? result : Math.round(result * 1000000) / 1000000;
                return { value: String(intResult), context: evalContext };
            }

            if (comparisonOps.includes(operator)) {
                const leftValue = String(leftResult.value);
                const rightValue = String(rightResult.value);
                const result = safeCompare(leftValue, operator as InternalComparisonOperator, rightValue);
                return { value: result ? 'true' : 'false', context: evalContext };
            }

            return { value: '', context: evalContext };
        }

        case 'unary': {
            const unaryNode = node as UnaryExpressionNode;
            const { operator, argument } = unaryNode;

            const argResult = await evaluate(argument, context);
            const numValue = toNumberSafe(argResult.value);

            let result: number;
            switch (operator) {
                case '+': result = numValue; break;
                case '-': result = -numValue; break;
                default: result = numValue;
            }

            return { value: String(result), context: argResult.context };
        }

        case 'ternary': {
            const ternaryNode = node as TernaryExpressionNode;
            const { test, consequent, alternate } = ternaryNode;

            const testResult = await evaluate(test, context);
            const isTrue = isTruthy(testResult.value);

            const branchResult = await evaluate(
                isTrue ? consequent : alternate,
                testResult.context
            );

            return { value: branchResult.value, context: branchResult.context };
        }

        case 'template': {
            const templateNode = node as TemplateNode;
            const { segments } = templateNode;

            const parts: string[] = [];
            let currentContext = context;

            for (const segment of segments) {
                if (segment.type === 'text') {
                    parts.push(segment.value);
                } else {
                    const segmentResult = await evaluate(segment.node, currentContext);
                    currentContext = segmentResult.context;
                    parts.push(String(segmentResult.value ?? ''));
                }
            }

            return { value: parts.join(''), context: currentContext };
        }

        case 'arrayLiteral': {
            const arrayNode = node as ArrayLiteralNode;
            const values: string[] = [];
            let currentContext = context;

            for (const item of arrayNode.items) {
                const result = await evaluate(item, currentContext);
                currentContext = result.context;
                values.push(String(result.value ?? ''));
            }

            // Trailing accessor: %[1,2,3][random] / %[1,2,3][0] / %[1,2,3][].length
            if (arrayNode.accessor) {
                switch (arrayNode.accessor.type) {
                    case 'index': {
                        const indexResult = await evaluate(arrayNode.accessor.index, currentContext);
                        const index = resolveArrayIndex(indexResult.value, values.length);
                        return { value: index >= 0 ? values[index] : '', context: indexResult.context };
                    }

                    case 'random': {
                        if (values.length === 0) return { value: '', context: currentContext };
                        const idx = Math.floor(Math.random() * values.length);
                        return { value: values[idx], context: currentContext };
                    }

                    case 'length': {
                        return { value: String(values.length), context: currentContext };
                    }
                }
            }

            return { value: values, context: currentContext };
        }

        case 'forLoop': {
            const forLoopNode = node as ForLoopNode;
            const currentDepth = context.loopDepth ?? 0;
            if (currentDepth >= getMaxLoopDepth(context.userPlan)) {
                return { value: '', context };
            }

            const maxIterations = getMaxLoopIterations(context.userPlan);
            const baseLoopVars = new Map(context.loopVars ?? []);
            const loopContext: ExecutionContext = {
                ...context,
                loopDepth: currentDepth + 1,
                loopVars: baseLoopVars,
                loopExit: undefined
            };

            let activeContext = loopContext;
            let iterations = 0;

            const runBody = async (): Promise<'break' | 'continue' | 'normal'> => {
                const iterationLoopVars = new Map(activeContext.loopVars ?? []);
                const bodyContext: ExecutionContext = {
                    ...activeContext,
                    loopVars: iterationLoopVars,
                    loopExit: undefined
                };

                for (const bodyNode of forLoopNode.body) {
                    const bodyResult = await evaluate(bodyNode, bodyContext);
                    bodyContext.loopVars = new Map(bodyResult.context.loopVars ?? bodyContext.loopVars ?? []);
                    bodyContext.loopExit = bodyResult.context.loopExit;
                    activeContext = {
                        ...bodyResult.context,
                        loopDepth: loopContext.loopDepth,
                        loopVars: new Map(bodyContext.loopVars ?? []),
                        loopExit: bodyContext.loopExit
                    };

                    if (bodyContext.loopExit === 'break') {
                        activeContext.loopExit = undefined;
                        return 'break';
                    }

                    if (bodyContext.loopExit === 'continue') {
                        activeContext.loopExit = undefined;
                        return 'continue';
                    }
                }

                activeContext.loopExit = undefined;
                return 'normal';
            };

            if (forLoopNode.mode === 'foreach') {
                const iterableResult = await evaluate(forLoopNode.iterable ?? { type: 'literal', value: '' }, loopContext);
                activeContext = { ...iterableResult.context, loopDepth: loopContext.loopDepth, loopVars: new Map(iterableResult.context.loopVars ?? baseLoopVars), loopExit: undefined };
                const iterableValues = parseIterableValue(iterableResult.value);

                for (const item of iterableValues) {
                    if (iterations >= maxIterations) {
                        break;
                    }

                    setLoopVarValue(activeContext, forLoopNode.loopVar, item);
                    const loopResult = await runBody();
                    iterations++;

                    if (loopResult === 'break') {
                        break;
                    }
                }

                return { value: '', context: { ...activeContext, loopDepth: context.loopDepth, loopExit: undefined, loopVars: context.loopVars } };
            }

            if (forLoopNode.init) {
                const initResult = await evaluate(forLoopNode.init, loopContext);
                activeContext = { ...initResult.context, loopDepth: loopContext.loopDepth, loopVars: new Map(initResult.context.loopVars ?? baseLoopVars), loopExit: undefined };
            }

            while (iterations < maxIterations) {
                if (forLoopNode.condition) {
                    const conditionResult = await evaluate(forLoopNode.condition, activeContext);
                    activeContext = { ...conditionResult.context, loopDepth: loopContext.loopDepth, loopVars: new Map(conditionResult.context.loopVars ?? activeContext.loopVars ?? []), loopExit: undefined };
                    if (!isTruthy(conditionResult.value)) {
                        break;
                    }
                }

                const bodyResult = await runBody();
                iterations++;

                if (bodyResult === 'break') {
                    break;
                }

                if (forLoopNode.update) {
                    const updateResult = await evaluate(forLoopNode.update, activeContext);
                    activeContext = { ...updateResult.context, loopDepth: loopContext.loopDepth, loopVars: new Map(updateResult.context.loopVars ?? activeContext.loopVars ?? []), loopExit: undefined };
                }
            }

            return { value: '', context: { ...activeContext, loopDepth: context.loopDepth, loopExit: undefined, loopVars: context.loopVars } };
        }

        case 'custom': {
            const customNode = node as CustomNode;
            return { value: `[Custom node not implemented: ${customNode.customType}]`, context };
        }

        case 'commandRef': {
            const cmdRefNode = node as CommandRefNode;
            const { commandName, args } = cmdRefNode;

            const MAX_COMMAND_REF_DEPTH = 5;
            const currentDepth = context.commandRefDepth ?? 0;
            if (currentDepth >= MAX_COMMAND_REF_DEPTH) {
                return { value: '', context };
            }

            const visitedCommands = context.visitedCommands ?? new Set<string>();
            const commandKey = `${context.broadcasterId}:${commandName.toLowerCase()}`;
            if (visitedCommands.has(commandKey)) {
                return { value: '', context };
            }

            const newVisitedCommands = new Set(visitedCommands);
            newVisitedCommands.add(commandKey);

            let argsString = '';
            if (args.length > 0) {
                const argsResults: string[] = [];
                let argsContext = context;
                for (const arg of args) {
                    const argResult = await evaluate(arg, argsContext);
                    argsContext = argResult.context;
                    argsResults.push(String(argResult.value ?? ''));
                }
                argsString = argsResults.join(' ');
            }

            try {
                const { commandHandler } = await import('../../handlers/commands.handler.js');
                const fakeEventData = {
                    chatter_user_id: context.broadcasterId,
                    chatter_user_login: context.userLogin || context.broadcasterId,
                    chatter_user_name: context.userDisplayName || context.broadcasterId,
                    badges: []
                };

                const result = await commandHandler(
                    context.broadcasterId,
                    fakeEventData,
                    commandName.toLowerCase(),
                    argsString || undefined
                );

                if (result.error || !result.message) {
                    return { value: '', context };
                }

                const nestedContext: ExecutionContext = {
                    ...context,
                    visitedCommands: newVisitedCommands,
                    commandRefDepth: currentDepth + 1,
                    argument: argsString || context.argument,
                    commandName: commandName.toLowerCase()
                };

                const { ast, error } = parse(result.message);
                if (error) {
                    // Restore the original visited set: cycle protection is per
                    // reference path, so siblings may reuse the same command.
                    return { value: result.message, context: { ...nestedContext, visitedCommands: context.visitedCommands } };
                }

                const nestedResult = await evaluate(ast, nestedContext);
                return { value: nestedResult.value, context: { ...nestedResult.context, visitedCommands: context.visitedCommands } };
            } catch (error) {
                console.error('Error in commandRef evaluation:', {
                    commandName,
                    args: argsString,
                    broadcasterId: context.broadcasterId,
                    error: error instanceof Error ? error.message : String(error)
                });
                return { value: '', context };
            }
        }

        case 'root': {
            const rootNode = node as RootNode;
            const results: string[] = [];
            let currentContext = context;

            for (const child of rootNode.children) {
                const result = await evaluate(child, currentContext);
                currentContext = result.context;
                if (result.value !== undefined && result.value !== '') {
                    results.push(String(result.value));
                }
            }

            return { value: results.join(' '), context: currentContext };
        }

        default:
            return { value: '', context };
    }
}

export function createExecutionContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
    return {
        variables: new Map<string, unknown>(),
        arrays: new Map<string, string[]>(),
        broadcasterId: '',
        userId: '',
        userLogin: '',
        userDisplayName: '',
        userPlan: 'free',
        userLevel: 1,
        count: 0,
        countModified: false,
        streamer: null,
        platform: 'twitch',
        scopeType: 'command',
        scopeName: '',
        scopeAliases: [],
        commandName: '',
        commandId: '',
        loopExit: undefined,
        loopVars: new Map<string, string>(),
        loopDepth: 0,
        commandResponses: [],
        commandVariables: new Map<string, string>(),
        userCommandVariables: new Map<string, string>(),
        saveResponses: async () => {},
        saveChannelVariable: async () => {},
        loadChannelVariable: async () => '',
        saveUserVariable: async () => {},
        loadUserVariable: async () => '',
        ...overrides
    };
}
