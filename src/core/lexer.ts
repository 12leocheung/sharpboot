import type { Diagnostic } from './types.ts';

export type TokenKind = 'ident' | 'number' | 'string' | 'char' | 'interp' | 'op' | 'eof';

export interface Token {
  kind: TokenKind;
  value: string;
  raw?: string;
  verbatim?: boolean;
  line: number;
  column: number;
  start: number;
  end: number;
}

export interface LexResult {
  tokens: Token[];
  errors: Diagnostic[];
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '0': '\0',
  '\\': '\\',
  '"': '"',
  "'": "'",
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
};

const OPS_TWO = new Set([
  '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=',
  '%=', '=>', '??', '?.', '::', '<<', '>>', '&=', '|=', '^=',
]);
const OPS_ONE = new Set('+-*/%=<>!&|^~?:;,.(){}[]#'.split(''));

export function tokenize(source: string): LexResult {
  const tokens: Token[] = [];
  const errors: Diagnostic[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let col = 1;
  let lineHasCode = false;

  const step = (count = 1): void => {
    for (let k = 0; k < count; k++) {
      if (i >= n) return;
      if (source[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  const push = (tok: Token): void => {
    tokens.push(tok);
    lineHasCode = true;
  };

  const readEscape = (): { text: string; raw: string } => {
    const at = i;
    step();
    if (i >= n) return { text: '\\', raw: '\\' };
    const c = source[i];
    if (c === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 1, i + 5))) {
      const text = String.fromCharCode(parseInt(source.slice(i + 1, i + 5), 16));
      step(5);
      return { text, raw: source.slice(at, i) };
    }
    if (c === 'x' && /^[0-9a-fA-F]{2,4}$/.test(source.slice(i + 1, i + 5))) {
      const hex = source.slice(i + 1, i + 5).match(/^[0-9a-fA-F]{2,4}/);
      if (hex) {
        const text = String.fromCharCode(parseInt(hex[0], 16));
        step(1 + hex[0].length);
        return { text, raw: source.slice(at, i) };
      }
    }
    const mapped = ESCAPES[c];
    step();
    if (mapped === undefined) {
      errors.push({
        severity: 'error',
        message: `Unknown escape sequence '\\${c}'`,
        line,
        column: col - 2,
        hint: 'Supported escapes: \\n \\t \\r \\0 \\\\ \\" \\uXXXX',
      });
      return { text: c, raw: source.slice(at, i) };
    }
    return { text: mapped, raw: source.slice(at, i) };
  };

  const readString = (): void => {
    const start = i;
    const startLine = line;
    const startCol = col;
    let verbatim = false;
    let interp = false;

    while (i < n && (source[i] === '$' || source[i] === '@')) {
      if (source[i] === '$') interp = true;
      else verbatim = true;
      step();
    }

    if (source[i] !== '"') {
      errors.push({
        severity: 'error',
        message: 'Malformed string literal',
        line: startLine,
        column: startCol,
      });
      return;
    }
    step(); // opening quote

    let raw = '';
    let value = '';
    let closed = false;

    while (i < n) {
      const c = source[i];
      if (c === '"') {
        if (verbatim && source[i + 1] === '"') {
          raw += '""';
          value += '"';
          step(2);
          continue;
        }
        step();
        closed = true;
        break;
      }
      if (c === '\n') {
        if (!verbatim) break;
        raw += c;
        value += c;
        step();
        continue;
      }
      if (c === '\\' && !verbatim) {
        const esc = readEscape();
        raw += esc.raw;
        value += esc.text;
        continue;
      }
      raw += c;
      value += c;
      step();
    }

    if (!closed) {
      errors.push({
        severity: 'error',
        message: 'Unterminated string literal',
        line: startLine,
        column: startCol,
        hint: 'Add a closing " at the end of the line.',
      });
    }

    push({
      kind: interp ? 'interp' : 'string',
      value: interp ? '' : value,
      raw,
      verbatim,
      line: startLine,
      column: startCol,
      start,
      end: i,
    });
  };

  const readChar = (): void => {
    const start = i;
    const startLine = line;
    const startCol = col;
    step(); // opening '
    let value = '';

    if (i < n && source[i] === '\\') {
      value = readEscape().text;
    } else if (i < n && source[i] !== "'" && source[i] !== '\n') {
      value = source[i];
      step();
    }

    if (source[i] === "'") {
      step();
    } else {
      errors.push({
        severity: 'error',
        message: 'Unterminated character literal',
        line: startLine,
        column: startCol,
        hint: "Add a closing ' after the character.",
      });
    }

    if (Array.from(value).length !== 1) {
      errors.push({
        severity: 'error',
        message: 'A character literal must contain exactly one character',
        line: startLine,
        column: startCol,
      });
    }

    push({
      kind: 'char',
      value: value || '?',
      line: startLine,
      column: startCol,
      start,
      end: i,
    });
  };

  const readNumber = (): void => {
    const start = i;
    const startLine = line;
    const startCol = col;
    while (i < n && /[0-9]/.test(source[i])) step();
    if (source[i] === '.' && /[0-9]/.test(source[i + 1] ?? '')) {
      step();
      while (i < n && /[0-9]/.test(source[i])) step();
    }
    while (i < n && /[fFdDmMlL]/.test(source[i])) step();
    push({
      kind: 'number',
      value: source.slice(start, i),
      line: startLine,
      column: startCol,
      start,
      end: i,
    });
  };

  const readIdent = (): void => {
    const start = i;
    const startLine = line;
    const startCol = col;
    while (i < n && /[A-Za-z0-9_]/.test(source[i])) step();
    push({
      kind: 'ident',
      value: source.slice(start, i),
      line: startLine,
      column: startCol,
      start,
      end: i,
    });
  };

  while (i < n) {
    const c = source[i];

    if (c === '\n') {
      step();
      lineHasCode = false;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      step();
      continue;
    }

    // Preprocessor directives (#region, #if ...) are ignored wholesale.
    if (c === '#' && !lineHasCode) {
      while (i < n && source[i] !== '\n') step();
      continue;
    }

    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') step();
      continue;
    }

    if (c === '/' && source[i + 1] === '*') {
      const startLine = line;
      const startCol = col;
      step(2);
      let closed = false;
      while (i < n) {
        if (source[i] === '*' && source[i + 1] === '/') {
          step(2);
          closed = true;
          break;
        }
        step();
      }
      if (!closed) {
        errors.push({
          severity: 'error',
          message: 'Unterminated block comment',
          line: startLine,
          column: startCol,
          hint: 'Close the comment with */.',
        });
      }
      continue;
    }

    if (c === "'") {
      readChar();
      continue;
    }

    if (c === '"') {
      readString();
      continue;
    }

    if ((c === '$' || c === '@') && /^[$@]*"/.test(source.slice(i, i + 4))) {
      readString();
      continue;
    }

    if (/[0-9]/.test(c)) {
      readNumber();
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      readIdent();
      continue;
    }

    const two = source.slice(i, i + 2);
    if (OPS_TWO.has(two)) {
      push({
        kind: 'op',
        value: two,
        line,
        column: col,
        start: i,
        end: i + 2,
      });
      step(2);
      continue;
    }

    if (OPS_ONE.has(c)) {
      push({
        kind: 'op',
        value: c,
        line,
        column: col,
        start: i,
        end: i + 1,
      });
      step();
      continue;
    }

    errors.push({
      severity: 'error',
      message: `Unexpected character '${c}'`,
      line,
      column: col,
    });
    step();
  }

  tokens.push({
    kind: 'eof',
    value: '',
    line,
    column: col,
    start: n,
    end: n,
  });

  return { tokens, errors };
}
