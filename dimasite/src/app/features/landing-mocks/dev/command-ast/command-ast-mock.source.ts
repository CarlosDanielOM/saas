import type { MockNode, MockRoot, MockVarStorage } from './command-ast-mock.model';

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
    const src = toSource(nodes[i], false);
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

export function toSource(node: MockNode, wrapComputeExpr = true): string {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'loopVar':
      return `#${node.name}`;
    case 'function': {
      const args = node.args.map((arg) => toSource(arg, false)).join(' ');
      return args ? `$(${node.name} ${args})` : `$(${node.name})`;
    }
    case 'getVar':
      return `%(${storagePrefix(node.storage)}${node.name})`;
    case 'setVar': {
      const value = node.value ? ` ${toSource(node.value, false)}` : '';
      return `%(${storagePrefix(node.storage)}${node.name}${value})`;
    }
    case 'exists':
      return `^(${storagePrefix(node.storage)}${node.name})`;
    case 'deleteVar':
      return `%del(${storagePrefix(node.storage)}${node.name})`;
    case 'binary': {
      const left = node.left ? toSource(node.left, false) : '?';
      const right = node.right ? toSource(node.right, false) : '?';
      return wrapCompute(`${left} ${node.operator} ${right}`, wrapComputeExpr);
    }
    case 'ternary': {
      const test = node.test ? toSource(node.test, false) : '?';
      const yes = node.consequent ? toSource(node.consequent, false) : '';
      const no = node.alternate ? toSource(node.alternate, false) : '';
      return wrapCompute(`${test} ? ${yes} : ${no}`, wrapComputeExpr);
    }
    case 'commandRef': {
      const args = node.args.map((arg) => toSource(arg, false)).join(' ');
      return args ? `#(${node.commandName} ${args})` : `#(${node.commandName})`;
    }
    case 'forLoop': {
      const body = joinParts(node.body);
      if (node.mode === 'foreach') {
        const iterable = node.iterable ? toSource(node.iterable, false) : '%(items[])';
        return wrapCompute(`for #${node.loopVar} in ${iterable} { ${body} }`, wrapComputeExpr);
      }
      const init = node.init ? toSource(node.init, false) : `#${node.loopVar} = 0`;
      const condition = node.condition ? toSource(node.condition, false) : `#${node.loopVar} < 3`;
      const update = node.update ? toSource(node.update, false) : `#${node.loopVar}++`;
      return wrapCompute(`for ${init}; ${condition}; ${update} { ${body} }`, wrapComputeExpr);
    }
    case 'group':
      return joinParts(node.children);
    case 'root':
      return joinParts(node.children);
  }
}

export function astPreview(root: MockRoot): string {
  return JSON.stringify(stripIds(root), null, 2);
}

function stripIds(node: MockNode): unknown {
  const { id: _id, ...rest } = node;
  switch (node.type) {
    case 'function':
    case 'commandRef':
      return { ...rest, args: node.args.map(stripIds) };
    case 'setVar':
      return { ...rest, value: node.value ? stripIds(node.value) : null };
    case 'binary':
      return {
        ...rest,
        left: node.left ? stripIds(node.left) : null,
        right: node.right ? stripIds(node.right) : null
      };
    case 'ternary':
      return {
        ...rest,
        test: node.test ? stripIds(node.test) : null,
        consequent: node.consequent ? stripIds(node.consequent) : null,
        alternate: node.alternate ? stripIds(node.alternate) : null
      };
    case 'forLoop':
      return {
        ...rest,
        init: node.init ? stripIds(node.init) : null,
        condition: node.condition ? stripIds(node.condition) : null,
        update: node.update ? stripIds(node.update) : null,
        iterable: node.iterable ? stripIds(node.iterable) : null,
        body: node.body.map(stripIds)
      };
    case 'group':
    case 'root':
      return { ...rest, children: node.children.map(stripIds) };
    default:
      return rest;
  }
}
