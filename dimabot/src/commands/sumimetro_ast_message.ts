interface SumimetroAstParserResult {
    parsedText: string;
}

interface SumimetroAstParserContext {
    channelID: string;
    scopeType: 'command';
    scopeName: string;
    eventData: {
        chatter_user_login: string;
        chatter_user_name: string;
        badges: [];
    };
}

export type SumimetroAstParser = (
    text: string,
    context: SumimetroAstParserContext
) => Promise<SumimetroAstParserResult>;

const AST_START_TOKENS = ['%del(', '$(', '%(', '*(', '^(', '#('];

function isEscaped(input: string, index: number): boolean {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && input[cursor] === '\\'; cursor--) {
        backslashes++;
    }
    return backslashes % 2 === 1;
}

export function isAstSumimetroMessage(message: string): boolean {
    for (const token of AST_START_TOKENS) {
        let index = message.indexOf(token);
        while (index !== -1) {
            if (!isEscaped(message, index)) {
                return true;
            }
            index = message.indexOf(token, index + token.length);
        }
    }

    return false;
}

export async function renderAstSumimetroMessage(
    message: string,
    channelID: string,
    user: string,
    commandName: string,
    parseAst: SumimetroAstParser
): Promise<string> {
    const result = await parseAst(message, {
        channelID,
        scopeType: 'command',
        scopeName: commandName,
        eventData: {
            chatter_user_login: user,
            chatter_user_name: user,
            badges: []
        }
    });

    return result.parsedText;
}
