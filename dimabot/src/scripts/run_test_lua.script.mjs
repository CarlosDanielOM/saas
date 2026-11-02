// Test-only Redis Lua 5.1 interpreter; Node >= 22 and npm ci (dev dependencies)
// are required. The WASM package needs no system Lua or native build toolchain.
// https://github.com/fatal10110/lua-redis-wasm#readme
// Its mocked Redis boundary is not a substitute for a disposable Dragonfly check.
import { readFileSync } from 'node:fs';
import { LuaWasmEngine } from 'lua-redis-wasm';

try {
    const engine = await LuaWasmEngine.createStandalone({});
    const result = engine.eval(readFileSync(0, 'utf8'));
    if (!Buffer.isBuffer(result)) throw new Error(`Expected Lua string result, got ${String(result)}`);
    process.stdout.write(result);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
