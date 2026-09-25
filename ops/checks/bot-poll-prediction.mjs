import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const catalog = JSON.parse(readFileSync('src/utils/ai/ast_catalog/ast-catalog.json', 'utf8'));
for (const name of ['get.prediction', 'end.prediction', 'cancel.prediction', 'end.poll', 'cancel.poll']) {
    const entry = catalog.entries.find(item => item.name === name);
    assert.ok(entry, `${name} is missing from the built AST catalog`);
    assert.equal(entry.minUserLevel, 7);
    assert.ok(entry.surfaces.includes('action'));
}

const tools = JSON.parse(readFileSync('src/utils/ai/tools.json', 'utf8'));
const astTool = tools.tools.find(item => item.function?.name === 'AST_PARSER');
assert.match(astTool.function.description, /call get\.prediction.*wait for its result.*end\.prediction/i);

const result = spawnSync('node', [
    '--test', '--experimental-test-module-mocks',
    'dist/utils/ast_parser/poll_prediction_actions.test.js',
    'dist/functions/polls/prediction_lookup.test.js',
    'dist/utils/ast_parser/permission_gate.test.js'
], { encoding: 'utf8', timeout: 120000, env: { ...process.env, NODE_OPTIONS: '' } });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
assert.equal(result.status, 0, `AST behavior tests failed: ${result.error?.message || result.signal || result.status}`);
