import type { MockArrayAccessor, MockNode, MockRoot, MockVarStorage } from './command-ast-mock.model';

function storagePrefix(storage: MockVarStorage): string {
  switch (storage) {
    case 'cache':
      return '#';
    case 'cacheUser':
      return '##';
    case 'db':
      return '*';
    case 'dbUser':
      return '**';
    default:
      return '';
  }
}

function joinParts(nodes: MockNode[]): string {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const src = toSource(nodes[i]);
    if (i === 0) {
      out = src;
      continue;
    }
    const prev = nodes[i - 1];
    if (prev.type === 'literal' || nodes[i].type === 'literal') {
      out += src;
    } else {
      out += ` ${src}`;
    }
  }
  return out;
}

function wrapCompute(inner: string, wrap: boolean): string {
  if (!wrap) return inner;
  return `*(${inner})`;
}

function quoteLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Operand inside a *( ) expression: no extra *( ), quote text with spaces. */
function computeAtom(node: MockNode): string {
  if (node.type === 'literal' && /[\s?:]/.test(node.value)) return quoteLiteral(node.value);
  // Several blocks in a branch become one quoted piece.
  if (node.type === 'group') {
    return quoteLiteral(node.children.map((child) => (child.type === 'literal' ? child.value : toSource(child))).join(''));
  }
  return toSource(node, false);
}

/** Value outside an expression (variable value, list item): expressions keep their *( ). */
function valueAtom(node: MockNode): string {
  if (node.type === 'literal' && /[\s?:]/.test(node.value)) return quoteLiteral(node.value);
  return toSource(node);
}

function selectorSource(selector: MockNode | null | undefined): string {
  return selector ? `(${toSource(selector, false)})` : '';
}

function accessorSource(accessor: MockArrayAccessor | undefined, writing = false): string {
  if (!accessor) return '';
  switch (accessor.type) {
    case 'array':
    case 'append':
      return '[]';
    case 'index':
    case 'setIndex':
      return `[${accessor.index ? toSource(accessor.index, false) : '0'}]`;
    case 'random':
      return '[random]';
    case 'length':
      return '[].length';
    default:
      return writing ? '[]' : '';
  }
}

export function toSource(node: MockNode, wrapComputeExpr = true): string {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'loopVar':
      return `#${node.name}`;
    case 'function': {
      const args = node.args.map((arg) => toSource(arg)).join(' ');
      return args ? `$(${node.name} ${args})` : `$(${node.name})`;
    }
    case 'getVar': {
      const acc = accessorSource(node.accessor);
      return `%(${storagePrefix(node.storage)}${node.name}${selectorSource(node.userSelector)}${acc})`;
    }
    case 'setVar': {
      const acc = accessorSource(node.accessor, true);
      const value = node.value ? ` ${valueAtom(node.value)}` : '';
      return `%(${storagePrefix(node.storage)}${node.name}${selectorSource(node.userSelector)}${acc}${value})`;
    }
    case 'template': {
      const inner = node.parts.map((part) => (part.type === 'literal' ? part.value : toSource(part))).join('');
      return `"${inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    case 'arrayLiteral': {
      const items = node.items.map((item) => valueAtom(item)).join(', ');
      return `%[${items}]`;
    }
    case 'exists':
      return `^(${storagePrefix(node.storage)}${node.name}${selectorSource(node.userSelector)})`;
    case 'deleteVar':
      return `%del(${storagePrefix(node.storage)}${node.name}${selectorSource(node.userSelector)})`;
    case 'binary': {
      const left = node.left ? toSource(node.left, false) : '?';
      const right = node.right ? computeAtom(node.right) : '?';
      return wrapCompute(`${left} ${node.operator} ${right}`, wrapComputeExpr);
    }
    case 'ternary': {
      const test = node.test ? toSource(node.test, false) : '?';
      const yes = node.consequent ? computeAtom(node.consequent) : '';
      const no = node.alternate ? computeAtom(node.alternate) : '';
      return wrapCompute(`${test} ? ${yes} : ${no}`, wrapComputeExpr);
    }
    case 'commandRef': {
      const args = node.args.map((arg) => toSource(arg)).join(' ');
      return args ? `#(${node.commandName} ${args})` : `#(${node.commandName})`;
    }
    case 'forLoop': {
      const body = joinParts(node.body);
      if (node.mode === 'foreach') {
        const iterable = node.iterable ? toSource(node.iterable, false) : '%(items[])';
        return wrapCompute(`for #${node.loopVar} in ${iterable} { ${body} }`, wrapComputeExpr);
      }
      // Real bot syntax: for #i = 0; #i < 3; #i++ { … }
      const v = `#${node.loopVar}`;
      const start = node.init?.type === 'binary' && node.init.right ? computeAtom(node.init.right) : '0';
      const condition = node.condition ? toSource(node.condition, false) : `${v} < 3`;
      const step = node.update?.type === 'binary' && node.update.right ? computeAtom(node.update.right) : '1';
      const init = `${v} = ${start}`;
      const update = step === '1' ? `${v}++` : `${v} = ${v} + ${step}`;
      return wrapCompute(`for ${init}; ${condition}; ${update} { ${body} }`, wrapComputeExpr);
    }
    case 'group':
      return joinParts(node.children);
    case 'root':
      return joinParts(node.children);
  }
}
