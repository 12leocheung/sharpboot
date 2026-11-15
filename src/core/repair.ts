import type { Diagnostic, Repair } from './types.ts';
import { tokenize } from './lexer.ts';
import type { Token } from './lexer.ts';
import { mapType } from './parser.ts';

const CONSOLE_METHODS: Record<string, string> = {
  writeline: 'WriteLine',
  write: 'Write',
  clear: 'Clear',
  readline: 'ReadLine',
  readkey: 'ReadKey',
};

const MANAGED_REPLACEMENTS: Record<string, string> = {
  Int32: 'int',
  Int64: 'long',
  Boolean: 'bool',
  String: 'string',
  Double: 'double',
  Char: 'char',
  Void: 'void',
  Single: 'float',
  Decimal: 'decimal',
};

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(source: string, edits: Edit[]): string {
  if (edits.length === 0) return source;
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of sorted) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

export function normalizeSource(input: string): { source: string; repairs: Repair[] } {
  const repairs: Repair[] = [];
  let source = input;

  if (source.charCodeAt(0) === 0xfeff) {
    source = source.slice(1);
    repairs.push({ phase: 'source', title: 'Removed a UTF-8 byte-order mark' });
  }

  if (source.includes('\r\n')) {
    source = source.replace(/\r\n/g, '\n');
    repairs.push({ phase: 'source', title: 'Normalized Windows line endings to LF' });
  }

  if (source.includes('\u00a0') || source.includes('\u200b') || source.includes('\ufeff')) {
    source = source.replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, '');
    repairs.push({ phase: 'source', title: 'Removed invisible characters (non-breaking spaces / zero-width spaces)' });
  }

  const tabCount = (source.match(/\t/g) ?? []).length;
  if (tabCount > 0) {
    source = source.replace(/\t/g, '    ');
    repairs.push({
      phase: 'source',
      title: `Expanded ${tabCount} tab character${tabCount === 1 ? '' : 's'} to four spaces`,
    });
  }

  if (!source.endsWith('\n')) source += '\n';
  return { source, repairs };
}

/** Runs the mechanical repair passes until the source parses cleanly (or stops improving). */
export function repairSource(
  input: string,
  parseFn: (source: string) => { error?: Diagnostic },
  maxRounds = 6,
): { source: string; repairs: Repair[] } {
  const normalized = normalizeSource(input);
  let source = normalized.source;
  const repairs = normalized.repairs;

  let error = parseFn(source).error;

  for (let round = 0; round < maxRounds; round++) {
    const before = source;

    source = fixUnterminatedStrings(source, repairs);
    source = fixUsingDirectives(source, repairs);
    source = wrapTopLevelStatements(source, repairs);
    source = fixConsoleApi(source, repairs);
    source = fixTypeKeywords(source, repairs);
    source = fixMainSignature(source, repairs);
    source = ensureEntryPoint(source, repairs);
    source = fixMissingSemicolons(source, repairs);
    source = balanceBraces(source, repairs, error);

    if (source === before) break;
    error = parseFn(source).error;
    if (!error) break;
  }

  return { source, repairs };
}

function fixUnterminatedStrings(source: string, repairs: Repair[]): string {
  let out = source;

  for (let pass = 0; pass < 8; pass++) {
    const errors = tokenize(out).errors;
    const err = errors.find((e) => e.message === 'Unterminated string literal');
    if (!err || !err.line) break;

    const lines = out.split('\n');
    const index = err.line - 1;
    if (index < 0 || index >= lines.length) break;

    const raw = lines[index];
    const trimmed = raw.replace(/\s+$/, '');
    if (trimmed.endsWith('"') || trimmed.endsWith('\\')) break;

    lines[index] = trimmed + '"';
    out = lines.join('\n');
    repairs.push({
      phase: 'source',
      title: 'Closed an unterminated string literal',
      detail: 'Added the missing closing quote at the end of the line.',
      line: err.line,
    });
  }

  return out;
}

function fixUsingDirectives(source: string, repairs: Repair[]): string {
  let out = source;

  const missingSemicolon = out
    .split('\n')
    .map((line) =>
      /^[ \t]*using[ \t]+(?:static[ \t]+)?[A-Za-z_][\w.]*[ \t]*$/.test(line)
        ? line.replace(/[ \t]+$/, '') + ';'
        : line,
    )
    .join('\n');
  if (missingSemicolon !== out) {
    repairs.push({
      phase: 'source',
      title: 'Added a missing semicolon to a using directive',
    });
    out = missingSemicolon;
  }

  const usesConsole = /\bConsole\s*\./.test(out);
  const hasSystem = /^[ \t]*using\s+System\s*;/m.test(out);
  if (usesConsole && !hasSystem) {
    const usingLines = [...out.matchAll(/^[ \t]*using\s+[^;\n]*;\s*$/gm)];
    if (usingLines.length > 0) {
      const last = usingLines[usingLines.length - 1];
      const insertAt = (last.index ?? 0) + last[0].length;
      out = out.slice(0, insertAt) + '\nusing System;' + out.slice(insertAt);
    } else {
      out = 'using System;\n\n' + out;
    }
    repairs.push({
      phase: 'source',
      title: 'Inserted the missing `using System;`',
      detail: 'Console is referenced without its namespace import.',
    });
  }

  return out;
}

function wrapTopLevelStatements(source: string, repairs: Repair[]): string {
  const lex = tokenize(source);
  const hasType = lex.tokens.some(
    (tok) => tok.kind === 'ident' && ['class', 'struct', 'record', 'interface'].includes(tok.value),
  );
  if (hasType) return source;

  const lines = source.split('\n');
  let prefixEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || /^using\s+/.test(line) || line.startsWith('//')) {
      prefixEnd = i + 1;
      continue;
    }
    break;
  }

  const prefix = lines.slice(0, prefixEnd).join('\n').trimEnd();
  const body = lines.slice(prefixEnd).join('\n').trim();
  if (body.length === 0) return source;

  const indented = body
    .split('\n')
    .map((line) => (line.trim().length === 0 ? '' : '        ' + line))
    .join('\n');

  const wrapped =
    (prefix.length > 0 ? prefix + '\n\n' : '') +
    'class Program\n{\n    static void Main(string[] args)\n    {\n' +
    indented +
    '\n    }\n}\n';

  repairs.push({
    phase: 'source',
    title: 'Wrapped top-level statements in `Program.Main()`',
    detail: 'The file had no class declaration, so a standard entry point was synthesised.',
  });

  return wrapped;
}

function fixConsoleApi(source: string, repairs: Repair[]): string {
  const tokens = tokenize(source).tokens;
  const edits: Edit[] = [];
  const touchedLines: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind !== 'ident') continue;

    if (tok.value === 'System' && tokens[i + 1]?.value === '.' && tokens[i + 2]?.value === 'Console') {
      edits.push({ start: tok.start, end: tokens[i + 2].end, text: 'Console' });
      touchedLines.push(tok.line);
      i += 2;
      continue;
    }

    if (tok.value.toLowerCase() === 'console' && tokens[i + 1]?.value === '.') {
      if (tok.value !== 'Console') {
        edits.push({ start: tok.start, end: tok.end, text: 'Console' });
        touchedLines.push(tok.line);
      }
      const member = tokens[i + 2];
      if (member?.kind === 'ident') {
        const canonical = CONSOLE_METHODS[member.value.toLowerCase()];
        if (canonical && canonical !== member.value) {
          edits.push({ start: member.start, end: member.end, text: canonical });
          touchedLines.push(member.line);
        }
      }
    }
  }

  if (edits.length > 0) {
    repairs.push({
      phase: 'source',
      title: `Normalized ${edits.length} Console API reference${edits.length === 1 ? '' : 's'}`,
      detail: 'Fixed casing and spelling such as `console.writeline` → `Console.WriteLine`.',
      line: touchedLines[0],
    });
  }

  return applyEdits(source, edits);
}

function fixTypeKeywords(source: string, repairs: Repair[]): string {
  const tokens = tokenize(source).tokens;
  const edits: Edit[] = [];

  for (const tok of tokens) {
    if (tok.kind !== 'ident') continue;
    const replacement = MANAGED_REPLACEMENTS[tok.value];
    if (replacement) edits.push({ start: tok.start, end: tok.end, text: replacement });
    if (tok.value === 'main') edits.push({ start: tok.start, end: tok.end, text: 'Main' });
  }

  if (edits.length > 0) {
    repairs.push({
      phase: 'source',
      title: `Canonicalized ${edits.length} type/identifier name${edits.length === 1 ? '' : 's'}`,
      detail: 'Replaced BCL aliases (String, Int32, Boolean…) with C# keywords.',
    });
  }

  return applyEdits(source, edits);
}

function fixMainSignature(source: string, repairs: Repair[]): string {
  let changed = false;

  const pattern = /(^|\n)([ \t]*)((?:(?:public|private|protected|internal|static|async|unsafe|sealed|new)\s+)*)([A-Za-z_][A-Za-z0-9_]*)\s+Main\s*\(([^)]*)\)/g;

  const out = source.replace(
    pattern,
    (match: string, lead: string, indent: string, modifiers: string, returnType: string, params: string) => {
      let nextModifiers = modifiers;
      let nextReturn = returnType;
      let nextParams = params.trim();
      let localChange = false;

      if (!/\bstatic\b/.test(nextModifiers)) {
        nextModifiers = ('static ' + nextModifiers).replace(/\s+/g, ' ').trimEnd() + ' ';
        localChange = true;
      } else {
        nextModifiers = nextModifiers.replace(/\s+/g, ' ').trimEnd() + (nextModifiers.trim().length ? ' ' : '');
      }

      if (nextReturn !== 'void' && nextReturn !== 'int') {
        nextReturn = 'void';
        localChange = true;
      }

      if (nextParams.length > 0) {
        const isArgs = /^string\s*\[\s*\]\s+[A-Za-z_][A-Za-z0-9_]*$/.test(nextParams)
          || /^string\s+[A-Za-z_][A-Za-z0-9_]*$/.test(nextParams);
        if (!isArgs) {
          nextParams = 'string[] args';
          localChange = true;
        }
      }

      if (!localChange) return match;
      changed = true;
      return `${lead}${indent}${nextModifiers}${nextReturn} Main(${nextParams})`;
    },
  );

  if (changed) {
    repairs.push({
      phase: 'source',
      title: 'Repaired the `Main()` entry point signature',
      detail: 'Ensured `static`, a valid return type, and `string[] args` compatibility.',
    });
  }

  return out;
}

function ensureEntryPoint(source: string, repairs: Repair[]): string {
  if (/\bMain\s*\(/.test(source)) return source;

  const candidate = source.match(
    /(^|\n)([ \t]*)((?:(?:public|private|protected|internal|static)\s+)*)void\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)/,
  );
  if (!candidate) return source;

  const name = candidate[4];
  if (name === 'Main') return source;

  const token = tokenize(source).tokens.find((tok) => tok.kind === 'ident' && tok.value === name);
  if (!token) return source;

  repairs.push({
    phase: 'source',
    title: `Promoted \`${name}()\` to \`Main()\``,
    detail: 'No entry point was present; the first parameterless void method became Main.',
    line: token.line,
  });

  return source.slice(0, token.start) + 'Main' + source.slice(token.end);
}

function fixMissingSemicolons(source: string, repairs: Repair[]): string {
  const tokens = tokenize(source).tokens;
  const byLine = new Map<number, Token[]>();
  for (const tok of tokens) {
    if (tok.kind === 'eof') continue;
    const list = byLine.get(tok.line) ?? [];
    list.push(tok);
    byLine.set(tok.line, list);
  }

  const skipFirst = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'foreach', 'case', 'default',
    'class', 'struct', 'record', 'interface', 'enum', 'namespace', 'using', '[',
    'try', 'catch', 'finally', 'lock', 'get', 'set', 'return',
  ]);

  const insertions: Edit[] = [];
  const fixedLines: number[] = [];

  const maxLine = Math.max(...byLine.keys());
  for (let lineNo = 1; lineNo <= maxLine; lineNo++) {
    const lineTokens = byLine.get(lineNo);
    if (!lineTokens || lineTokens.length === 0) continue;

    const firstTok = lineTokens[0];
    const lastTok = lineTokens[lineTokens.length - 1];
    const first = firstTok.value;
    const last = lastTok.value;

    if (first === '[' || first === ')' || first === ',' || first === '}' || first === '{') continue;
    if (last === ';' || last === '{' || last === '}' || last === ',' || last === ':' || last === '(' || last === '[' || last === '=>') continue;
    if (skipFirst.has(first) && first !== 'return') continue;
    if (
      lineTokens.some(
        (tok) =>
          tok.kind === 'ident' &&
          ['class', 'struct', 'record', 'interface', 'enum', 'namespace'].includes(tok.value),
      )
    ) {
      continue;
    }

    const hasAssign = lineTokens.some(
      (tok) => tok.kind === 'op' && ['=', '+=', '-=', '*=', '/=', '%='].includes(tok.value),
    );
    const startsWithType = mapType(first) !== null;
    const startsWithModifier = ['public', 'private', 'protected', 'internal', 'static', 'const', 'readonly'].includes(first);

    // Method / class headers end with ')' and carry no assignment.
    if (!hasAssign && last === ')' && (startsWithType || startsWithModifier)) continue;
    if (!hasAssign && last === ')' && first === 'class') continue;
    if (!hasAssign && (last === ')' || last === ']') && !startsWithType && !startsWithModifier && !first.match(/^[A-Za-z_]/)) continue;

    const nextToken = byLine.get(lineNo + 1)?.[0];
    if (nextToken?.kind === 'op' && ['.', '+', '-', '*', '/', '%', '?', ':', '&&', '||', ',', ')', ']', '=', '=>'].includes(nextToken.value)) {
      continue;
    }
    if (nextToken && (nextToken.value === 'else' || nextToken.value === 'while')) continue;

    // Only add when the line looks like a real statement.
    const returnsEarly = first === 'return' || first === 'break' || first === 'continue';
    const callLike = lineTokens.some((tok) => tok.value === '(');
    const expressionEnd = ['ident', 'number', 'string', 'char', 'op'].includes(lastTok.kind)
      && ![';', '{', '}', ',', ':', '(', '[', '=>'].includes(last);

    if (!(hasAssign || startsWithType || returnsEarly || callLike || expressionEnd)) continue;
    if (first === 'else') continue;

    insertions.push({ start: lastTok.end, end: lastTok.end, text: ';' });
    fixedLines.push(lineNo);
  }

  if (insertions.length === 0) return source;

  repairs.push({
    phase: 'source',
    title: `Added ${insertions.length} missing semicolon${insertions.length === 1 ? '' : 's'}`,
    detail: `Lines ${fixedLines.slice(0, 6).join(', ')}${fixedLines.length > 6 ? '…' : ''}`,
    line: fixedLines[0],
  });

  return applyEdits(source, insertions);
}

function balanceBraces(source: string, repairs: Repair[], lastError: Diagnostic | undefined): string {
  let out = source;

  for (let pass = 0; pass < 8; pass++) {
    const tokens = tokenize(out).tokens;
    let depth = 0;
    let unmatched: Token | null = null;

    for (const tok of tokens) {
      if (tok.kind !== 'op') continue;
      if (tok.value === '{') depth++;
      if (tok.value === '}') {
        depth--;
        if (depth < 0) {
          unmatched = tok;
          break;
        }
      }
    }

    if (unmatched) {
      out = out.slice(0, unmatched.start) + out.slice(unmatched.end);
      repairs.push({
        phase: 'source',
        title: 'Removed an unmatched closing brace',
        line: unmatched.line,
      });
      continue;
    }

    if (depth > 0) {
      if (depth > 8) break;
      let closing = '';
      for (let level = depth; level > 0; level--) closing += '    '.repeat(level - 1) + '}\n';
      out = out.replace(/\s*$/, '') + '\n' + closing;
      repairs.push({
        phase: 'source',
        title: `Closed ${depth} unclosed brace${depth === 1 ? '' : 's'}`,
        detail: lastError?.message,
        line: lastError?.line,
      });
      continue;
    }

    break;
  }

  return out;
}
