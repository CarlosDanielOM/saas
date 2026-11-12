// Feature services mix schema declarations with runtime imports. Evaluate only the exact
// top-level schema/model declarations from the frozen source, using TypeScript's parser.
// No feature functions or dependency imports execute; Mongoose is the recorder's instance.
// In particular service -> Twitch headers -> TwitchStreamers -> posthog_events constructs a
// PostHog client (flushInterval: 1000); none of that initialization runs in this loader.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DECLARATIONS: Record<string, string[]> = {
    'src/custom_widgets/widget-store.ts': ["schema", "WidgetStore"],
    'src/custom_widgets/store.ts': ["schema", "CustomWidgets"],
    'src/overlays/interactions.ts': ["Interaction"],
    'src/overlays/store.ts': ["schema", "Studio"],
    'src/duel/completion.ts': ['restoreSchema', 'DuelModeratorRestore'],
    'src/duel/stats.ts': ['schema', 'DuelResult'],
    'src/duel/service.ts': ['schema', 'DuelChannel'],
    'src/roulette/service.ts': ['schema', 'RouletteChannel'],
    'src/goals/service.ts': ['GoalSet', 'contributionSchema', 'GoalContribution', 'GoalCustomReceipt'],
    'src/widgets/service.ts': ['schema', 'WidgetChannel'],
};
const loaded = new Set<string>();
export async function loadSchema(root: string, file: string, mongoose: any): Promise<void> {
    if (loaded.has(file)) return;
    const names = DECLARATIONS[file];
    if (!names) {
        await import(pathToFileURL(path.join(root, file)).href);
    } else {
        const ts = (await import(pathToFileURL(path.join(root, 'node_modules/typescript/lib/typescript.js')).href)).default;
        const source = readFileSync(path.join(root, file), 'utf8');
        const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const selected: string[] = [];
        const found = new Set<string>();
        for (const node of ast.statements) {
            if (ts.isVariableStatement(node) && node.declarationList.declarations.some((d: any) => names.includes(d.name.getText(ast)))) {
                for (const d of node.declarationList.declarations) found.add(d.name.getText(ast));
                selected.push(node.getText(ast).replace(/^export\s+/, ''));
            } else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
                && ts.isPropertyAccessExpression(node.expression.expression)
                && node.expression.expression.name.text === 'index'
                && found.has(node.expression.expression.expression.getText(ast))) {
                selected.push(node.getText(ast));
            }
        }
        if (names.some(name => !found.has(name))) throw new Error(`missing schema declaration in ${file}`);
        const js = ts.transpileModule(selected.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        // Only the allowlisted declarations above; no imports, initializers or service calls.
        new Function('Schema', 'model', js)(mongoose.Schema, mongoose.model.bind(mongoose));
    }
    loaded.add(file);
}
