import {
    BlocksError,
    type BlockAccessor,
    type BlockBinaryOp,
    type BlockLoopAssignOp,
    type BlockNode,
    type BlockRoot,
    type BlockStorage
} from './types.js';

export const MAX_BLOCK_NODES = 4000;
export const MAX_BLOCK_DEPTH = 48;
const MAX_STRING = 10_000;

const STORAGES: BlockStorage[] = ['memory', 'cache', 'cacheUser', 'db', 'dbUser'];
const BINARY_OPS: BlockBinaryOp[] = ['+', '-', '*', '/', '%', '==', '!=', '>=', '<=', '>', '<', '=', '~=', '<>'];
const LOOP_ASSIGN_OPS: BlockLoopAssignOp[] = ['=', '+=', '-=', '*=', '/=', '%=', '++', '--'];
const VAR_NAME = /^[\p{L}\p{N}_]{1,64}$/u;
const LOOP_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const COMMAND_NAME = /^[^\s()"\\]{1,60}$/;
const ID = /^[\w-]{1,64}$/;

type Raw = Record<string, unknown>;

/**
 * Checks an untrusted block tree from the browser and returns a typed copy.
 * Unknown fields are dropped; missing or duplicate ids are replaced.
 */
export function readBlockRoot(input: unknown): BlockRoot {
    const state = { nodes: 0, ids: new Set<string>(), seq: 0 };
    if (!isObject(input) || input.type !== 'root' || !Array.isArray(input.children)) {
        throw new BlocksError('The block tree is missing or broken.');
    }

    const freshId = (candidate: unknown): string => {
        if (typeof candidate === 'string' && ID.test(candidate) && !state.ids.has(candidate)) {
            state.ids.add(candidate);
            return candidate;
        }
        let id: string;
        do { id = `s${(state.seq += 1).toString(36)}`; } while (state.ids.has(id));
        state.ids.add(id);
        return id;
    };

    const rootId = freshId(input.id);

    const str = (value: unknown, label: string, id: string, max = MAX_STRING): string => {
        if (typeof value !== 'string') throw new BlocksError(`${label} is missing.`, id);
        if (value.length > max) throw new BlocksError(`${label} is too long.`, id);
        return value;
    };

    const node = (value: unknown, depth: number, atRoot = false): BlockNode => {
        if (!isObject(value) || typeof value.type !== 'string') throw new BlocksError('A block is broken.');
        if (depth > MAX_BLOCK_DEPTH) throw new BlocksError('Blocks are nested too deeply.');
        state.nodes += 1;
        if (state.nodes > MAX_BLOCK_NODES) throw new BlocksError(`Too many blocks (limit ${MAX_BLOCK_NODES}).`);
        const id = freshId(value.id);
        const child = (slot: unknown, label: string, optional = false): BlockNode | undefined => {
            if (slot === null || slot === undefined) {
                if (optional) return undefined;
                throw new BlocksError(`Fill in ${label}.`, id);
            }
            return node(slot, depth + 1);
        };
        const list = (slot: unknown): BlockNode[] => {
            if (slot === undefined || slot === null) return [];
            if (!Array.isArray(slot)) throw new BlocksError('A block list is broken.', id);
            return slot.map((item) => node(item, depth + 1));
        };
        const storage = (): BlockStorage => {
            if (!STORAGES.includes(value.storage as BlockStorage)) throw new BlocksError('Pick how long the variable is kept.', id);
            return value.storage as BlockStorage;
        };
        const varName = (): string => {
            const name = str(value.name, 'The variable name', id, 64);
            if (!VAR_NAME.test(name)) throw new BlocksError('Variable names use only letters, numbers and _.', id);
            return name;
        };
        const selector = (store: BlockStorage): BlockNode | undefined => {
            if (value.userSelector === null || value.userSelector === undefined) return undefined;
            if (store !== 'cacheUser' && store !== 'dbUser') return undefined;
            return node(value.userSelector, depth + 1);
        };
        const accessor = (allowed: BlockAccessor['type'][]): BlockAccessor | undefined => {
            const raw = value.accessor;
            if (raw === null || raw === undefined) return undefined;
            if (!isObject(raw) || !allowed.includes(raw.type as BlockAccessor['type'])) {
                throw new BlocksError('This list option is not available here.', id);
            }
            const type = raw.type as BlockAccessor['type'];
            if (type === 'index' || type === 'setIndex' || type === 'remove') {
                if (raw.index === null || raw.index === undefined) throw new BlocksError('Fill in the list position.', id);
                return { type, index: node(raw.index, depth + 1) };
            }
            return { type } as BlockAccessor;
        };

        switch (value.type) {
            case 'literal':
                return { id, type: 'literal', value: str(value.value ?? '', 'Text', id) };
            case 'raw':
                if (!atRoot) throw new BlocksError('Advanced pieces can only be used at the top level.', id);
                return { id, type: 'raw', source: str(value.source, 'The advanced piece', id) };
            case 'function': {
                const name = str(value.name, 'The function name', id, 80);
                if (!FUNCTION_NAME.test(name)) throw new BlocksError('That function name is not valid.', id);
                return { id, type: 'function', name, args: list(value.args) };
            }
            case 'commandRef': {
                const commandName = str(value.commandName, 'The command name', id, 60).replace(/^!/, '');
                if (!COMMAND_NAME.test(commandName)) throw new BlocksError('Type the command to run, like so.', id);
                return { id, type: 'commandRef', commandName, args: list(value.args) };
            }
            case 'getVar': {
                const store = storage();
                return compact({ id, type: 'getVar', name: varName(), storage: store,
                    accessor: accessor(['array', 'index', 'random', 'length']), userSelector: selector(store) });
            }
            case 'exists': {
                const store = storage();
                return compact({ id, type: 'exists', name: varName(), storage: store,
                    accessor: accessor(['array', 'index', 'random', 'length']), userSelector: selector(store) });
            }
            case 'deleteVar': {
                const store = storage();
                return compact({ id, type: 'deleteVar', name: varName(), storage: store,
                    accessor: accessor(['clear', 'remove']), userSelector: selector(store) });
            }
            case 'setVar': {
                const store = storage();
                return compact({ id, type: 'setVar', name: varName(), storage: store,
                    value: child(value.value, 'the value to remember')!,
                    accessor: accessor(['append', 'setIndex']), userSelector: selector(store) });
            }
            case 'binary': {
                if (!BINARY_OPS.includes(value.operator as BlockBinaryOp)) throw new BlocksError('Pick a check or math sign.', id);
                return { id, type: 'binary', operator: value.operator as BlockBinaryOp,
                    left: child(value.left, 'the left side')!, right: child(value.right, 'the right side')! };
            }
            case 'unary': {
                if (value.operator !== '-' && value.operator !== '+') throw new BlocksError('Pick + or −.', id);
                return { id, type: 'unary', operator: value.operator, argument: child(value.argument, 'the value')! };
            }
            case 'ternary':
                return { id, type: 'ternary', test: child(value.test, 'the check')!,
                    consequent: child(value.consequent, '', true) ?? { id: freshId(null), type: 'literal', value: '' },
                    alternate: child(value.alternate, '', true) ?? { id: freshId(null), type: 'literal', value: '' } };
            case 'template':
                return { id, type: 'template', parts: list(value.parts) };
            case 'group':
                return { id, type: 'group', children: list(value.children) };
            case 'arrayLiteral':
                return compact({ id, type: 'arrayLiteral', items: list(value.items), accessor: accessor(['index', 'random', 'length']) });
            case 'loopVar': {
                const name = str(value.name, 'The counter name', id, 32);
                if (!LOOP_NAME.test(name)) throw new BlocksError('Counter names start with a letter.', id);
                return { id, type: 'loopVar', name };
            }
            case 'loopAssign': {
                const name = str(value.name, 'The counter name', id, 32);
                if (!LOOP_NAME.test(name)) throw new BlocksError('Counter names start with a letter.', id);
                if (!LOOP_ASSIGN_OPS.includes(value.operator as BlockLoopAssignOp)) throw new BlocksError('Pick how the counter changes.', id);
                const operator = value.operator as BlockLoopAssignOp;
                return compact({ id, type: 'loopAssign', name, operator,
                    value: operator === '++' || operator === '--' ? undefined : child(value.value, 'the counter value')! });
            }
            case 'forLoop': {
                const loopVar = str(value.loopVar, 'The counter name', id, 32);
                if (!LOOP_NAME.test(loopVar)) throw new BlocksError('Counter names start with a letter.', id);
                if (value.mode !== 'range' && value.mode !== 'foreach') throw new BlocksError('Pick the kind of repeat.', id);
                if (value.mode === 'foreach') {
                    return { id, type: 'forLoop', loopVar, mode: 'foreach',
                        iterable: child(value.iterable, 'the list to go through')!, body: list(value.body) };
                }
                return { id, type: 'forLoop', loopVar, mode: 'range', init: child(value.init, 'the start')!,
                    condition: child(value.condition, 'when to stop')!, update: child(value.update, 'the step')!, body: list(value.body) };
            }
            default:
                throw new BlocksError(`Unknown block type “${String(value.type).slice(0, 24)}”.`, id);
        }
    };

    return { id: rootId, type: 'root', children: input.children.map((item) => node(item, 1, true)) };
}

function isObject(value: unknown): value is Raw {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drops undefined optional fields so trees compare cleanly. */
function compact<T extends object>(value: T): T {
    for (const key of Object.keys(value) as (keyof T)[]) {
        if (value[key] === undefined) delete value[key];
    }
    return value;
}
