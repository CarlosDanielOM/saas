import { parse } from '../utils/ast_parser/parser.js';
import { evaluate, createExecutionContext } from '../utils/ast_parser/evaluator.js';
import { registerUserFunctions } from '../utils/ast_parser/functions/user.functions.js';
import { registerEventsubFunctions } from '../utils/ast_parser/functions/eventsub.functions.js';
import { registerStringFunctions } from '../utils/ast_parser/functions/string.functions.js';
import type { AstNode } from '../utils/ast_parser/types.js';
import type { AlertEvent, AlertLayout } from './model.js';

// The production AST parser/evaluator with a presentation-only capability boundary.
// Validate the complete tree before evaluating anything, including untaken branches.
const functions = new Set(['user', 'touser', 'cheer.amount', 'cheer.message', 'sub.tier', 'sub.months', 'gifted.user', 'raid.channel', 'raid.login', 'raid.viewers', 'upper', 'lower', 'title', 'capitalize', 'trim', 'length', 'slice']);
export function parseTemplate(text: string) {
  registerUserFunctions(); registerEventsubFunctions(); registerStringFunctions();
  if (text.length > 2000) throw new Error('Alert text exceeds 2000 characters');
  const result = parse(text); if (result.error) throw new Error(result.error);
  let nodes = 0;
  const visit = (node: AstNode, depth = 0): void => {
    if (++nodes > 300 || depth > 20) throw new Error('Alert expression is too complex');
    const child = (n: AstNode) => visit(n, depth + 1);
    switch (node.type) {
      case 'root': node.children.forEach(child); break;
      case 'literal': break;
      case 'function':
        if (!functions.has(node.name)) throw new Error(`Unsupported alert function: ${node.name}`);
        node.args.forEach(child); break;
      case 'binary': child(node.left); child(node.right); break;
      case 'unary': child(node.argument); break;
      case 'ternary': child(node.test); child(node.consequent); child(node.alternate); break;
      case 'template': node.segments.forEach(s => { if (s.type === 'expr') child(s.node); }); break;
      default: throw new Error(`This AST operation cannot be used in alert text: ${node.type}`);
    }
  };
  visit(result.ast); return result.ast;
}
export async function renderTemplate(text: string, channel: string, event: Record<string, unknown>): Promise<string> {
  const ast = parseTemplate(text);
  const display = event.is_anonymous ? 'Anonymous' : String(event.user_name || event.user_login || event.from_broadcaster_user_name || event.from_broadcaster_user_login || 'Viewer');
  const context = createExecutionContext({ broadcasterId: channel, userId: String(event.user_id || ''), userLogin: String(event.user_login || ''), userDisplayName: display,
    eventData: event, extraContext: { userName: display }, userPlan: 'pro', enforceFunctionPermissions: true });
  return String((await evaluate(ast, context)).value ?? '').slice(0, 8000);
}
export async function renderLayout(layout: AlertLayout, channel: string, event: Record<string, unknown>): Promise<AlertLayout> {
  return { ...layout, widgets: await Promise.all(layout.widgets.map(async w => w.kind === 'text' ? { ...w, text: await renderTemplate(w.text || '', channel, event) } : w)) };
}
export function sampleEvent(kind: AlertEvent, user = 'Luna', amount = 100, tier = '1000'): Record<string, unknown> {
  return { user_name: user, user_login: user.toLowerCase(), user_id: '0', bits: kind === 'bits' ? amount : 0,
    tier, cumulative_months: amount, from_broadcaster_user_name: user, from_broadcaster_user_login: user.toLowerCase(), viewers: amount, message: 'Thank you!' };
}
