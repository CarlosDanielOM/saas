import { ToolInputError } from '../types.js';

/**
 * Wrap text that came from viewers, chat, command bodies or other people's input. The system
 * prompt tells the model that anything inside `untrusted_data` is data, never instructions.
 */
export function untrusted<T>(value: T): { untrusted_data: T } {
    return { untrusted_data: value };
}

export function asObject(raw: unknown): Record<string, unknown> {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new ToolInputError('Arguments must be a JSON object');
    return raw as Record<string, unknown>;
}

export function str(input: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number; min?: number; trim?: boolean } = {}): string | undefined {
    const value = input[key];
    if (value === undefined || value === null || value === '') {
        if (opts.required) throw new ToolInputError(`${key} is required`);
        return undefined;
    }
    if (typeof value !== 'string') throw new ToolInputError(`${key} must be a string`);
    const text = opts.trim === false ? value : value.trim();
    if (opts.max !== undefined && text.length > opts.max) throw new ToolInputError(`${key} is too long (max ${opts.max} characters)`);
    if (opts.min !== undefined && text.length < opts.min) throw new ToolInputError(`${key} is too short (min ${opts.min} characters)`);
    return text;
}

export function int(input: Record<string, unknown>, key: string, opts: { required?: boolean; min?: number; max?: number } = {}): number | undefined {
    const value = input[key];
    if (value === undefined || value === null || value === '') {
        if (opts.required) throw new ToolInputError(`${key} is required`);
        return undefined;
    }
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isInteger(number)) throw new ToolInputError(`${key} must be an integer`);
    if (opts.min !== undefined && number < opts.min) throw new ToolInputError(`${key} must be at least ${opts.min}`);
    if (opts.max !== undefined && number > opts.max) throw new ToolInputError(`${key} must be at most ${opts.max}`);
    return number;
}

export function bool(input: Record<string, unknown>, key: string, opts: { required?: boolean } = {}): boolean | undefined {
    const value = input[key];
    if (value === undefined || value === null) {
        if (opts.required) throw new ToolInputError(`${key} is required`);
        return undefined;
    }
    if (typeof value !== 'boolean') throw new ToolInputError(`${key} must be true or false`);
    return value;
}

export function oneOf<T extends string>(input: Record<string, unknown>, key: string, values: readonly T[], opts: { required?: boolean } = {}): T | undefined {
    const value = input[key];
    if (value === undefined || value === null || value === '') {
        if (opts.required) throw new ToolInputError(`${key} is required`);
        return undefined;
    }
    if (typeof value !== 'string' || !values.includes(value as T)) throw new ToolInputError(`${key} must be one of: ${values.join(', ')}`);
    return value as T;
}

/** Stable JSON (sorted keys) for fingerprints and compare-and-set checks. */
export function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value as Record<string, unknown>).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
            .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}
