import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isAstSumimetroMessage,
    renderAstSumimetroMessage
} from './sumimetro_ast_message.js';

test('recognizes AST syntax without routing legacy sumimetro templates', () => {
    assert.equal(isAstSumimetroMessage('$(user) obtuvo %(##sumiso)%'), true);
    assert.equal(isAstSumimetroMessage('El usuario {user} tiene {sumiso}%'), false);
});

test('renders AST sumimetro messages through the supplied parser', async () => {
    const calls: unknown[] = [];
    const result = await renderAstSumimetroMessage(
        '$(user) obtuvo %(##sumiso)%',
        '452912249',
        'vtluciel',
        'sumimetro',
        async (text, context) => {
            calls.push({ text, context });
            return { parsedText: 'vtluciel obtuvo 42%', count: 0, countModified: false };
        }
    );

    assert.equal(result, 'vtluciel obtuvo 42%');
    assert.deepEqual(calls, [{
        text: '$(user) obtuvo %(##sumiso)%',
        context: {
            channelID: '452912249',
            scopeType: 'command',
            scopeName: 'sumimetro',
            eventData: {
                chatter_user_login: 'vtluciel',
                chatter_user_name: 'vtluciel',
                badges: []
            }
        }
    }]);
});
