import { spawnSync } from 'node:child_process';

function lua(value: unknown): string {
    if (value === null || value === undefined) return 'nil';
    if (typeof value === 'string') return `"${[...Buffer.from(value)].map(byte => `\\${String(byte).padStart(3, '0')}`).join('')}"`;
    if (typeof value !== 'object') return String(value);
    return `{${Object.entries(value).map(([key, item]) => `[${lua(key)}]=${lua(item)}`).join(',')}}`;
}

// Runs the actual production script in standalone Lua, with only Redis commands and the JSON boundary mocked.
// No Redis client, server, database, network or application bootstrap is involved.
export function runFollowDefenseStateLua(
    script: string,
    options: { keys: string[]; arguments: string[] },
    values: Map<string, string>,
    sorted: Map<string, Map<string, number>>,
    now: number
): [number, string] {
    const decoded: Record<string, unknown> = {};
    for (const raw of [...values.values(), ...options.arguments]) {
        try { decoded[raw] = JSON.parse(raw); } catch { /* Non-JSON Redis values are valid fixtures. */ }
    }
    const input = `
local values = ${lua(Object.fromEntries(values))}
local sorted = ${lua(Object.fromEntries([...sorted].map(([key, entries]) => [key, Object.fromEntries(entries)])))}
local decoded = ${lua(decoded)}
local function encode(value)
    if type(value) == 'string' then
        return '"' .. value:gsub('[%z\\1-\\31\\\\"]', function(char)
            return string.format('\\\\u%04x', string.byte(char))
        end) .. '"'
    end
    if type(value) ~= 'table' then return tostring(value) end
    local parts = {}
    for key, item in pairs(value) do table.insert(parts, encode(key) .. ':' .. encode(item)) end
    return '{' .. table.concat(parts, ',') .. '}'
end
cjson = {
    decode = function(raw) if decoded[raw] == nil then error('Invalid JSON') end return decoded[raw] end,
    encode = encode
}
redis = {
    error_reply = function(message) error(message) end,
    call = function(command, key, a, b)
        if command == 'TIME' then return {${Math.floor(now / 1000)}, ${(now % 1000) * 1000}} end
        if command == 'TYPE' then return {ok = values[key] and 'string' or sorted[key] and 'zset' or 'none'} end
        if command == 'GET' then
            if sorted[key] then error('WRONGTYPE') end
            return values[key] or false
        end
        if command == 'SET' then values[key] = a; sorted[key] = nil; return 'OK' end
        if command == 'DEL' then
            values[key] = nil; sorted[key] = nil
            if a then values[a] = nil; sorted[a] = nil end
            return 1
        end
        if command == 'ZADD' or command == 'ZREM' then
            if values[key] then error('WRONGTYPE') end
            if command == 'ZADD' then
                sorted[key] = sorted[key] or {}; sorted[key][b] = tonumber(a)
            elseif sorted[key] then sorted[key][a] = nil end
            return 1
        end
        error('Unexpected Redis command: ' .. command)
    end
}
KEYS = {${options.keys.map(lua).join(',')}}
ARGV = {${options.arguments.map(lua).join(',')}}
local ok, result = pcall(function()
${script}
end)
io.write('{"values":' .. encode(values) .. ',"sorted":' .. encode(sorted))
if ok then io.write(',"result":[' .. encode(result[1]) .. ',' .. encode(result[2]) .. ']')
else io.write(',"error":' .. encode(result)) end
io.write('}')
`;
    const process = spawnSync('lua', ['-'], { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (process.error) throw process.error;
    if (process.status !== 0) throw new Error(process.stderr);
    const output = JSON.parse(process.stdout) as {
        values: Record<string, string>; sorted: Record<string, Record<string, number>>;
        result: [number, string]; error?: string;
    };
    values.clear();
    for (const [key, value] of Object.entries(output.values)) values.set(key, value);
    sorted.clear();
    for (const [key, entries] of Object.entries(output.sorted)) sorted.set(key, new Map(Object.entries(entries)));
    if (output.error) throw new Error(output.error);
    return output.result;
}
