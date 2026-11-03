/** Test-only faults installed before the candidate API imports its pet runtime. */
import './providers.mjs';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Loader hooks work in the intended runtime command without test-only Node flags.
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url !== 'file:///app/dist/pets/moods.js') return result;
  let source = String(result.source);
  for (const [name, flag] of [['resolvePetMood', '__dima046Extracted'], ['moodInstruction', '__dima046Instructed']]) {
    const signature = new RegExp(`(export function ${name}\\([^)]*\\) \\{)`);
    assert(signature.test(source), `fault fixture requires ${name} export`);
    source = source.replace(signature, `$1 if (!${flag}) { ${flag} = true; throw new Error('fixture mood decoration failure'); }`);
  }
  return { ...result, source: `let __dima046Extracted = false, __dima046Instructed = false;\n${source}` };
} });
