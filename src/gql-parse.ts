// A small GraphQL document parser: operations, fragments, variables,
// arguments with every literal form, aliases and directives — enough for
// the documents gh and github-mcp-server actually send.

export type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'lit'; value: unknown };

export interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Map<string, ValueNode>;
  directives: Array<{ name: string; args: Map<string, ValueNode> }>;
  selection?: SelectionNode[];
}
export type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string; directives: Array<{ name: string; args: Map<string, ValueNode> }> }
  | { kind: 'inline'; typeCondition?: string; directives: Array<{ name: string; args: Map<string, ValueNode> }>; selection: SelectionNode[] };

export interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name?: string;
  selection: SelectionNode[];
}
export interface Fragment { typeCondition: string; selection: SelectionNode[] }
export interface Document {
  operations: Operation[];
  fragments: Map<string, Fragment>;
}

export class GqlSyntaxError extends Error {}

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '=', '@', '$', '!', '|', '&']);

function lex(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (/\s|,/.test(c)) { i++; continue; }
    if (source.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if (PUNCT.has(c)) { tokens.push(c); i++; continue; }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new GqlSyntaxError('unterminated block string');
        tokens.push(JSON.stringify(source.slice(i + 3, end)));
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') { out += source[j] + source[j + 1]; j += 2; }
        else { out += source[j]; j++; }
      }
      if (j >= source.length) throw new GqlSyntaxError('unterminated string');
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j++;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j++;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

export function parseGraphql(source: string): Document {
  const tokens = lex(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (t: string) => {
    const got = next();
    if (got !== t) throw new GqlSyntaxError(`expected ${t}, got ${got ?? 'EOF'}`);
  };

  const parseValue = (): ValueNode => {
    const t = next();
    if (t === undefined) throw new GqlSyntaxError('unexpected EOF in value');
    if (t === '$') return { kind: 'var', name: next() };
    if (t === '[') {
      const items: ValueNode[] = [];
      while (peek() !== ']') items.push(parseValue());
      expect(']');
      return { kind: 'lit', value: items };
    }
    if (t === '{') {
      const obj: Record<string, ValueNode> = {};
      while (peek() !== '}') {
        const key = next();
        expect(':');
        obj[key] = parseValue();
      }
      expect('}');
      return { kind: 'lit', value: obj };
    }
    if (t.startsWith('"')) return { kind: 'lit', value: JSON.parse(t) };
    if (/^-?\d+$/.test(t)) return { kind: 'lit', value: parseInt(t, 10) };
    if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(t) || /^-?\d+[eE][+-]?\d+$/.test(t)) return { kind: 'lit', value: parseFloat(t) };
    if (t === 'true') return { kind: 'lit', value: true };
    if (t === 'false') return { kind: 'lit', value: false };
    if (t === 'null') return { kind: 'lit', value: null };
    return { kind: 'lit', value: t }; // enum value
  };

  const parseArgs = (): Map<string, ValueNode> => {
    const args = new Map<string, ValueNode>();
    if (peek() !== '(') return args;
    next();
    while (peek() !== ')') {
      const name = next();
      expect(':');
      args.set(name, parseValue());
    }
    expect(')');
    return args;
  };

  const parseDirectives = (): Array<{ name: string; args: Map<string, ValueNode> }> => {
    const out: Array<{ name: string; args: Map<string, ValueNode> }> = [];
    while (peek() === '@') {
      next();
      const name = next();
      out.push({ name, args: parseArgs() });
    }
    return out;
  };

  const parseTypeRef = (): void => {
    // consume a type reference (in variable definitions / fragment headers)
    if (peek() === '[') { next(); parseTypeRef(); expect(']'); }
    else next();
    if (peek() === '!') next();
  };

  const parseSelectionSet = (): SelectionNode[] => {
    expect('{');
    const selections: SelectionNode[] = [];
    while (peek() !== '}') {
      if (peek() === '...') {
        next();
        if (peek() === 'on') {
          next();
          const typeCondition = next();
          const directives = parseDirectives();
          selections.push({ kind: 'inline', typeCondition, directives, selection: parseSelectionSet() });
        } else if (/^[A-Za-z_]/.test(peek() ?? '')) {
          const name = next();
          selections.push({ kind: 'spread', name, directives: parseDirectives() });
        } else {
          selections.push({ kind: 'inline', directives: parseDirectives(), selection: parseSelectionSet() });
        }
        continue;
      }
      let name = next();
      let alias: string | undefined;
      if (peek() === ':') { next(); alias = name; name = next(); }
      const args = parseArgs();
      const directives = parseDirectives();
      const selection = peek() === '{' ? parseSelectionSet() : undefined;
      selections.push({ kind: 'field', alias, name, args, directives, selection });
    }
    expect('}');
    return selections;
  };

  const doc: Document = { operations: [], fragments: new Map() };
  while (pos < tokens.length) {
    const t = peek();
    if (t === '{') {
      doc.operations.push({ type: 'query', selection: parseSelectionSet() });
    } else if (t === 'query' || t === 'mutation' || t === 'subscription') {
      const opType = next() as Operation['type'];
      let name: string | undefined;
      if (peek() !== '(' && peek() !== '{' && peek() !== '@') name = next();
      if (peek() === '(') {
        // variable definitions: skip, values come from the request
        let depth = 0;
        do {
          const tk = next();
          if (tk === '(') depth++;
          else if (tk === ')') depth--;
          else if (tk === '$') { next(); expect(':'); parseTypeRef(); if (peek() === '=') { next(); parseValue(); } }
        } while (depth > 0);
      }
      parseDirectives();
      doc.operations.push({ type: opType, name, selection: parseSelectionSet() });
    } else if (t === 'fragment') {
      next();
      const name = next();
      expect('on');
      const typeCondition = next();
      parseDirectives();
      doc.fragments.set(name, { typeCondition, selection: parseSelectionSet() });
    } else if (t === 'schema' || t === 'type' || t === 'interface' || t === 'enum' || t === 'input' || t === 'extend' || t === 'directive' || t === 'scalar' || t === 'union') {
      // type-system definitions in a document: skip the definition
      next();
      let depth = 0;
      while (pos < tokens.length) {
        const tk = peek();
        if (tk === '{') depth++;
        if (tk === '}') { depth--; if (depth <= 0) { next(); break; } }
        if (depth === 0 && (tk === 'query' || tk === 'mutation' || tk === 'fragment' || tk === '{')) break;
        next();
      }
    } else {
      throw new GqlSyntaxError(`unexpected token ${t}`);
    }
  }
  return doc;
}

/** Resolve a ValueNode against request variables. */
export function valueOf(node: ValueNode | undefined, variables: Record<string, unknown>): unknown {
  if (!node) return undefined;
  if (node.kind === 'var') return variables[node.name];
  const v = node.value;
  if (Array.isArray(v)) return v.map((item) => valueOf(item as ValueNode, variables));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries(v as Record<string, ValueNode>)) out[k] = valueOf(sub, variables);
    return out;
  }
  return v;
}

export function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of field.args) out[k] = valueOf(v, variables);
  return out;
}
