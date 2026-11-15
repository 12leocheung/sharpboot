import type { Diagnostic } from './types.ts';
import { tokenize } from './lexer.ts';
import type { Token } from './lexer.ts';

export type TypeName =
  | 'int' | 'double' | 'string' | 'bool' | 'char' | 'void' | 'var'
  | 'int[]' | 'string[]' | 'bool[]';

export interface Param {
  name: string;
  type: TypeName;
}

export interface FieldDecl {
  name: string;
  type: TypeName;
  init?: Expr;
  isConst: boolean;
  line: number;
}

export interface MethodDecl {
  name: string;
  returnType: TypeName;
  params: Param[];
  body: Stmt[];
  line: number;
}

export interface ClassDecl {
  name: string;
  methods: MethodDecl[];
  fields: FieldDecl[];
  line: number;
}

export interface Program {
  classes: ClassDecl[];
  usings: string[];
}

export type Stmt =
  | { kind: 'block'; body: Stmt[]; line: number }
  | { kind: 'var'; type: TypeName; name: string; init?: Expr; line: number }
  | { kind: 'expr'; expr: Expr; line: number }
  | { kind: 'if'; cond: Expr; then: Stmt[]; otherwise?: Stmt[]; line: number }
  | { kind: 'while'; cond: Expr; body: Stmt[]; line: number }
  | { kind: 'do'; body: Stmt[]; cond: Expr; line: number }
  | { kind: 'for'; init?: Stmt; cond?: Expr; update?: Stmt; body: Stmt[]; line: number }
  | { kind: 'foreach'; varName: string; varType: TypeName | null; iterable: Expr; body: Stmt[]; line: number }
  | { kind: 'break'; line: number }
  | { kind: 'continue'; line: number }
  | { kind: 'return'; value?: Expr; line: number }
  | { kind: 'empty'; line: number };

export type Expr =
  | { kind: 'num'; value: number; isInt: boolean; line: number }
  | { kind: 'str'; value: string; line: number }
  | { kind: 'char'; value: string; line: number }
  | { kind: 'bool'; value: boolean; line: number }
  | { kind: 'null'; line: number }
  | { kind: 'ident'; name: string; line: number }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; line: number }
  | { kind: 'unary'; op: string; expr: Expr; line: number }
  | { kind: 'update'; op: '++' | '--'; target: Expr; prefix: boolean; line: number }
  | { kind: 'assign'; target: Expr; op: string; value: Expr; line: number }
  | { kind: 'call'; callee: Expr; args: Expr[]; line: number }
  | { kind: 'member'; object: Expr; name: string; line: number }
  | { kind: 'index'; object: Expr; index: Expr; line: number }
  | { kind: 'cond'; cond: Expr; a: Expr; b: Expr; line: number }
  | { kind: 'interp'; parts: (string | Expr)[]; line: number }
  | { kind: 'new'; typeName: TypeName; args: Expr[]; line: number }
  | { kind: 'newarray'; elementType: 'int' | 'string' | 'bool'; size: Expr; line: number }
  | { kind: 'arrayinit'; elementType: 'int' | 'string' | 'bool'; items: Expr[]; line: number }
  | { kind: 'cast'; type: TypeName; expr: Expr; line: number };

export interface ParseResult {
  program?: Program;
  error?: Diagnostic;
  tokens: Token[];
}

class ParseFailure extends Error {
  diag: Diagnostic;
  constructor(diag: Diagnostic) {
    super(diag.message);
    this.diag = diag;
  }
}

const TYPE_WORDS: Record<string, TypeName> = {
  int: 'int',
  Int32: 'int',
  int32: 'int',
  long: 'int',
  Int64: 'int',
  short: 'int',
  Int16: 'int',
  byte: 'int',
  sbyte: 'int',
  uint: 'int',
  ulong: 'int',
  ushort: 'int',
  double: 'double',
  Double: 'double',
  float: 'double',
  Single: 'double',
  decimal: 'double',
  string: 'string',
  String: 'string',
  bool: 'bool',
  Boolean: 'bool',
  char: 'char',
  Char: 'char',
  void: 'void',
  Void: 'void',
  var: 'var',
};

const MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'sealed',
  'abstract',
  'partial',
  'readonly',
  'override',
  'virtual',
  'new',
  'extern',
  'unsafe',
  'volatile',
]);

export function mapType(raw: string): TypeName | null {
  return TYPE_WORDS[raw] ?? null;
}

function describe(tok: Token): string {
  if (tok.kind === 'eof') return 'end of file';
  if (tok.kind === 'string' || tok.kind === 'interp') return 'string literal';
  if (tok.kind === 'char') return 'character literal';
  return `'${tok.value}'`;
}

export function parse(source: string): ParseResult {
  const lex = tokenize(source);
  const lexError = lex.errors.find((e) => e.severity === 'error');
  if (lexError) return { error: lexError, tokens: lex.tokens };
  try {
    const parser = new Parser(lex.tokens);
    const program = parser.parseProgram();
    return { program, tokens: lex.tokens };
  } catch (err) {
    if (err instanceof ParseFailure) {
      return { error: err.diag, tokens: lex.tokens };
    }
    throw err;
  }
}

export function findEntry(program: Program): MethodDecl | undefined {
  const candidates: MethodDecl[] = [];
  for (const cls of program.classes) {
    for (const method of cls.methods) {
      if (method.name === 'Main') candidates.push(method);
    }
  }
  return candidates.find((m) => m.params.length <= 1) ?? candidates[0];
}

export function flatMethods(program: Program): MethodDecl[] {
  const out: MethodDecl[] = [];
  for (const cls of program.classes) out.push(...cls.methods);
  return out;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parseExpression(): Expr {
    return this.parseAssignment();
  }

  atEof(): boolean {
    return this.peek().kind === 'eof';
  }

  private peek(offset = 0): Token {
    const idx = Math.min(this.pos + offset, this.tokens.length - 1);
    return this.tokens[idx];
  }

  private at(value: string): boolean {
    const tok = this.peek();
    return (tok.kind === 'ident' || tok.kind === 'op') && tok.value === value;
  }

  private eat(value: string): boolean {
    if (this.at(value)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private next(): Token {
    const tok = this.peek();
    if (tok.kind !== 'eof') this.pos++;
    return tok;
  }

  private expect(value: string): Token {
    if (!this.at(value)) {
      this.fail(`Expected '${value}' but found ${describe(this.peek())}`);
    }
    return this.next();
  }

  private expectIdent(): Token {
    const tok = this.peek();
    if (tok.kind !== 'ident') {
      this.fail(`Expected an identifier but found ${describe(tok)}`);
    }
    this.pos++;
    return tok;
  }

  private fail(message: string, hint?: string): never {
    const tok = this.peek();
    throw new ParseFailure({
      severity: 'error',
      message,
      line: tok.line,
      column: tok.column,
      hint,
    });
  }

  parseProgram(): Program {
    const usings: string[] = [];
    const classes: ClassDecl[] = [];
    let namespaceDepth = 0;

    while (!this.atEof()) {
      if (this.eat(';')) continue;
      if (this.at('}')) {
        if (namespaceDepth > 0) {
          this.next();
          namespaceDepth--;
          continue;
        }
        this.fail('Unexpected closing brace at file scope');
      }
      if (this.at('using')) {
        usings.push(this.readUsing());
        continue;
      }
      if (this.at('namespace')) {
        this.next();
        this.readDottedName();
        this.expect('{');
        namespaceDepth++;
        continue;
      }
      if (this.at('async')) {
        this.fail("'async' is not supported", 'SharpBoot programs are synchronous.');
      }

      const startPos = this.pos;
      let sawTypeKeyword = false;
      while (true) {
        const tok = this.peek();
        if (tok.kind === 'ident' && MODIFIERS.has(tok.value)) {
          this.next();
          continue;
        }
        if (this.at('class')) {
          sawTypeKeyword = true;
          break;
        }
        if (this.at('struct') || this.at('record') || this.at('interface') || this.at('enum')) {
          const kw = this.peek().value;
          this.fail(`'${kw}' declarations are not supported`, `Rewrite the ${kw} as a plain class with static methods.`);
        }
        break;
      }

      if (sawTypeKeyword) {
        classes.push(this.parseClass());
        continue;
      }

      if (this.pos !== startPos) {
        this.fail(`Unexpected ${describe(this.peek())} at file scope`, 'Only using directives, namespaces and class declarations are allowed here.');
      }

      this.fail(
        `Unexpected ${describe(this.peek())} at file scope`,
        'The repair engine can wrap loose statements in Program.Main() — check that the file contains a class.',
      );
    }

    if (classes.length === 0) {
      this.fail('No class declaration found in the file', 'A SharpBoot program needs a class with a static Main() method.');
    }

    return { classes, usings };
  }

  private readUsing(): string {
    const parts: string[] = [];
    while (!this.atEof() && !this.at(';')) parts.push(this.next().value);
    if (!this.eat(';')) this.fail("Missing ';' after using directive");
    return parts.join(' ');
  }

  private readDottedName(): string {
    let name = this.expectIdent().value;
    while (this.eat('.')) name += '.' + this.expectIdent().value;
    return name;
  }

  private parseClass(): ClassDecl {
    const line = this.peek().line;
    this.expect('class');
    const name = this.expectIdent().value;
    if (this.at('<')) {
      this.fail('Generic classes are not supported', 'Remove the type parameter list.');
    }
    if (this.eat(':')) {
      while (!this.at('{') && !this.atEof()) this.next();
    }
    this.expect('{');

    const methods: MethodDecl[] = [];
    const fields: FieldDecl[] = [];

    while (!this.at('}') && !this.atEof()) {
      if (this.eat(';')) continue;
      this.skipAttributes();

      let isConst = false;
      while (true) {
        if (this.at('const')) {
          isConst = true;
          this.next();
          continue;
        }
        const tok = this.peek();
        if (tok.kind === 'ident' && MODIFIERS.has(tok.value)) {
          this.next();
          continue;
        }
        break;
      }

      if (this.at('class')) {
        this.fail('Nested classes are not supported');
      }
      if (this.peek().kind === 'ident' && this.peek().value === name && this.peek(1).kind === 'op' && this.peek(1).value === '(') {
        this.fail('Constructors are not supported', 'Use static methods and fields instead.');
      }
      if (this.at('~')) {
        this.fail('Finalizers are not supported');
      }

      const type = this.parseType();
      const memberName = this.expectIdent();

      if (this.at('(')) {
        methods.push(this.parseMethodRest(memberName.value, type, memberName.line));
        continue;
      }

      if (type === 'void') {
        this.fail('A field cannot have type void');
      }
      let init: Expr | undefined;
      if (this.eat('=')) init = this.parseExpression();
      else if (isConst) this.fail('A const field must be initialized');
      if (this.at('{')) {
        this.fail('Properties are not supported', 'Use a field or a GetX() method instead.');
      }
      this.expect(';');
      fields.push({ name: memberName.value, type, init, isConst, line: memberName.line });
    }

    this.expect('}');
    return { name, methods, fields, line };
  }

  private parseMethodRest(name: string, returnType: TypeName, line: number): MethodDecl {
    this.expect('(');
    const params: Param[] = [];
    if (!this.at(')')) {
      do {
        if (this.at('ref') || this.at('out') || this.at('params') || this.at('in')) {
          this.fail('ref/out/params parameters are not supported');
        }
        const type = this.parseType();
        if (type === 'void' || type === 'var') {
          this.fail('Parameter types must be concrete (int, double, string, bool, char)');
        }
        const paramName = this.expectIdent();
        if (this.at('=')) {
          this.fail('Default parameter values are not supported');
        }
        params.push({ name: paramName.value, type });
      } while (this.eat(','));
    }
    this.expect(')');

    let body: Stmt[];
    if (this.at('{')) {
      body = this.parseBlock();
    } else if (this.eat('=>')) {
      const expr = this.parseExpression();
      this.expect(';');
      body = returnType === 'void'
        ? [{ kind: 'expr', expr, line }]
        : [{ kind: 'return', value: expr, line }];
    } else {
      this.fail('Expected a method body', 'Only methods with bodies are supported.');
    }

    return { name, returnType, params, body, line };
  }

  private parseType(): TypeName {
    const tok = this.peek();
    if (tok.kind !== 'ident') {
      this.fail(`Expected a type but found ${describe(tok)}`);
    }
    this.next();
    if (this.at('[')) {
      this.next();
      this.expect(']');
      const base = mapType(tok.value);
      if (base === 'int' || base === 'bool') return `${base}[]`;
      if (base === 'string' || base === 'char') return 'string[]';
      if (base === 'double') return 'int[]';
      this.fail(`Arrays of '${tok.value}' are not supported`, 'Use int[], double[], string[], bool[] or char[].');
    }
    if (this.at('<')) {
      this.fail('Generic types are not supported', 'Use plain int, double, string, bool or char values.');
    }
    const mapped = mapType(tok.value);
    if (!mapped) {
      this.fail(`Type '${tok.value}' is not supported`, 'Supported types: int, double, string, bool, char.');
    }
    return mapped;
  }

  private skipAttributes(): void {
    while (this.at('[')) {
      let depth = 0;
      while (!this.atEof()) {
        const tok = this.next();
        if (tok.value === '[') depth++;
        if (tok.value === ']') {
          depth--;
          if (depth === 0) break;
        }
      }
    }
  }

  private parseBlock(): Stmt[] {
    this.expect('{');
    const body: Stmt[] = [];
    while (!this.at('}') && !this.atEof()) body.push(this.parseStatement());
    this.expect('}');
    return body;
  }

  private parseStatementAsBlock(): Stmt[] {
    if (this.at('{')) return this.parseBlock();
    return [this.parseStatement()];
  }

  private parseStatement(): Stmt {
    const line = this.peek().line;

    if (this.at('{')) return { kind: 'block', body: this.parseBlock(), line };
    if (this.eat(';')) return { kind: 'empty', line };

    if (this.at('if')) {
      this.next();
      this.expect('(');
      const cond = this.parseExpression();
      this.expect(')');
      const thenBody = this.parseStatementAsBlock();
      let otherwise: Stmt[] | undefined;
      if (this.eat('else')) otherwise = this.parseStatementAsBlock();
      return { kind: 'if', cond, then: thenBody, otherwise, line };
    }

    if (this.at('while')) {
      this.next();
      this.expect('(');
      const cond = this.parseExpression();
      this.expect(')');
      return { kind: 'while', cond, body: this.parseStatementAsBlock(), line };
    }

    if (this.at('do')) {
      this.next();
      const body = this.parseStatementAsBlock();
      this.expect('while');
      this.expect('(');
      const cond = this.parseExpression();
      this.expect(')');
      this.expect(';');
      return { kind: 'do', body, cond, line };
    }

    if (this.at('for')) {
      this.next();
      this.expect('(');
      let init: Stmt | undefined;
      if (!this.at(';')) {
        if (this.isLocalDeclaration()) {
          init = this.parseLocalDeclaration();
        } else {
          const expr = this.parseExpression();
          init = { kind: 'expr', expr, line };
        }
      }
      this.expect(';');
      let cond: Expr | undefined;
      if (!this.at(';')) cond = this.parseExpression();
      this.expect(';');
      let update: Stmt | undefined;
      if (!this.at(')')) {
        const expr = this.parseExpression();
        update = { kind: 'expr', expr, line };
      }
      this.expect(')');
      return { kind: 'for', init, cond, update, body: this.parseStatementAsBlock(), line };
    }

    if (this.at('break')) {
      this.next();
      this.expect(';');
      return { kind: 'break', line };
    }

    if (this.at('continue')) {
      this.next();
      this.expect(';');
      return { kind: 'continue', line };
    }

    if (this.at('return')) {
      this.next();
      if (this.eat(';')) return { kind: 'return', line };
      const value = this.parseExpression();
      this.expect(';');
      return { kind: 'return', value, line };
    }

    if (this.at('switch')) {
      this.fail('switch statements are not supported', 'Rewrite the switch as an if/else chain.');
    }
    if (this.at('foreach')) {
      this.next();
      this.expect('(');
      let varType: TypeName | null = null;
      if (this.eat('var')) {
        varType = null;
      } else {
        varType = this.parseType();
      }
      const varName = this.expectIdent().value;
      this.expect('in');
      const iterable = this.parseExpression();
      this.expect(')');
      return { kind: 'foreach', varName, varType, iterable, body: this.parseStatementAsBlock(), line };
    }
    if (this.at('try') || this.at('catch') || this.at('finally') || this.at('throw')) {
      this.fail('Exceptions are not supported', 'The kernel has no exception machinery — remove try/catch/throw.');
    }
    if (this.at('using')) {
      this.fail('using statements are not supported');
    }
    if (this.at('lock') || this.at('yield') || this.at('goto')) {
      this.fail(`'${this.peek().value}' is not supported`);
    }

    if (this.isLocalDeclaration()) {
      const decl = this.parseLocalDeclaration();
      this.expect(';');
      return decl;
    }

    const expr = this.parseExpression();
    this.expect(';');
    return { kind: 'expr', expr, line };
  }

  private isLocalDeclaration(): boolean {
    if (this.at('const')) return true;
    const tok = this.peek();
    if (tok.kind !== 'ident' || mapType(tok.value) === null) return false;
    let offset = 1;
    if (this.peek(offset).kind === 'op' && this.peek(offset).value === '[') {
      offset++;
      if (!(this.peek(offset).kind === 'op' && this.peek(offset).value === ']')) return false;
      offset++;
    }
    const nameTok = this.peek(offset);
    if (nameTok.kind !== 'ident') return false;
    const after = this.peek(offset + 1);
    return after.kind === 'op' && ['=', ';', ',', ')'].includes(after.value);
  }

  private parseLocalDeclaration(): Stmt {
    const line = this.peek().line;
    let isConst = false;
    if (this.at('const')) {
      isConst = true;
      this.next();
    }
    const type = this.parseType();
    if (type === 'void') this.fail('A local variable cannot have type void');
    const decls: Stmt[] = [];

    do {
      const name = this.expectIdent().value;
      let init: Expr | undefined;
      if (this.eat('=')) init = this.parseExpression();
      else if (isConst) this.fail('A const local must be initialized');
      decls.push({ kind: 'var', type, name, init, line });
    } while (this.eat(','));

    return decls.length === 1 ? decls[0] : { kind: 'block', body: decls, line };
  }

  private parseAssignment(): Expr {
    const left = this.parseConditional();
    const tok = this.peek();
    const ops = ['=', '+=', '-=', '*=', '/=', '%='];
    if (tok.kind === 'op' && ops.includes(tok.value)) {
      if (left.kind !== 'ident' && left.kind !== 'member' && left.kind !== 'index') {
        this.fail('Invalid assignment target');
      }
      const op = this.next().value;
      const value = this.parseAssignment();
      return { kind: 'assign', target: left, op, value, line: left.line };
    }
    return left;
  }

  private parseConditional(): Expr {
    const cond = this.parseBinary(0);
    if (this.eat('?')) {
      const a = this.parseAssignment();
      this.expect(':');
      const b = this.parseAssignment();
      return { kind: 'cond', cond, a, b, line: cond.line };
    }
    return cond;
  }

  private parseBinary(level: number): Expr {
    const levels = [
      ['||'],
      ['&&'],
      ['==', '!='],
      ['<', '<=', '>', '>='],
      ['+', '-'],
      ['*', '/', '%'],
    ];
    if (level >= levels.length) return this.parseUnary();

    let left = this.parseBinary(level + 1);
    while (true) {
      const tok = this.peek();
      if (tok.kind !== 'op' || !levels[level].includes(tok.value)) break;
      const op = this.next().value;
      const right = this.parseBinary(level + 1);
      left = { kind: 'binary', op, left, right, line: left.line };
    }
    return left;
  }

  private parseUnary(): Expr {
    const tok = this.peek();
    if (tok.kind === 'op' && (tok.value === '!' || tok.value === '-' || tok.value === '+')) {
      this.next();
      return { kind: 'unary', op: tok.value, expr: this.parseUnary(), line: tok.line };
    }
    if (tok.kind === 'op' && (tok.value === '++' || tok.value === '--')) {
      this.next();
      return {
        kind: 'update',
        op: tok.value as '++' | '--',
        target: this.parseUnary(),
        prefix: true,
        line: tok.line,
      };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();

    while (true) {
      if (this.eat('.')) {
        const nameTok = this.expectIdent();
        expr = { kind: 'member', object: expr, name: nameTok.value, line: nameTok.line };
        continue;
      }
      if (this.at('(')) {
        const line = this.peek().line;
        this.next();
        const args: Expr[] = [];
        if (!this.at(')')) {
          do {
            args.push(this.parseExpression());
          } while (this.eat(','));
        }
        this.expect(')');
        expr = { kind: 'call', callee: expr, args, line };
        continue;
      }
      if (this.at('[')) {
        const line = this.peek().line;
        this.next();
        const index = this.parseExpression();
        this.expect(']');
        expr = { kind: 'index', object: expr, index, line };
        continue;
      }
      if (this.at('++') || this.at('--')) {
        const tok = this.next();
        expr = {
          kind: 'update',
          op: tok.value as '++' | '--',
          target: expr,
          prefix: false,
          line: tok.line,
        };
        continue;
      }
      break;
    }

    return expr;
  }

  private parsePrimary(): Expr {
    const tok = this.peek();

    if (tok.kind === 'number') {
      this.next();
      const text = tok.value;
      const isInt = !/[.fFdDmM]/.test(text);
      const numeric = Number(text.replace(/[fFdDmMlL]$/, ''));
      if (Number.isNaN(numeric)) this.fail(`Invalid numeric literal '${text}'`);
      return { kind: 'num', value: numeric, isInt, line: tok.line };
    }

    if (tok.kind === 'string') {
      this.next();
      return { kind: 'str', value: tok.value, line: tok.line };
    }

    if (tok.kind === 'char') {
      this.next();
      return { kind: 'char', value: tok.value, line: tok.line };
    }

    if (tok.kind === 'interp') {
      this.next();
      return this.parseInterpolated(tok);
    }

    if (tok.kind === 'ident') {
      if (tok.value === 'true' || tok.value === 'false') {
        this.next();
        return { kind: 'bool', value: tok.value === 'true', line: tok.line };
      }
      if (tok.value === 'null') {
        this.next();
        return { kind: 'null', line: tok.line };
      }
      if (tok.value === 'new') {
        this.next();
        const baseTok = this.peek();
        const base = baseTok.kind === 'ident' ? mapType(baseTok.value) : null;
        if (!base) {
          this.fail('Expected int, string or bool after new');
        }
        this.next();
        if (this.at('[')) {
          this.next();
          if (this.eat(']')) {
            this.expect('{');
            const items: Expr[] = [];
            if (!this.at('}')) {
              do {
                items.push(this.parseExpression());
              } while (this.eat(','));
            }
            this.expect('}');
            const elementType = base === 'double' ? 'int' : base === 'char' ? 'string' : base;
            if (elementType !== 'int' && elementType !== 'string' && elementType !== 'bool') {
              this.fail(`new ${base}[] { ... } is not supported`);
            }
            return { kind: 'arrayinit', elementType, items, line: tok.line };
          }
          const size = this.parseExpression();
          this.expect(']');
          const elementType = base === 'double' ? 'int' : base === 'char' ? 'string' : base;
          if (elementType !== 'int' && elementType !== 'string' && elementType !== 'bool') {
            this.fail(`new ${base}[...] is not supported`);
          }
          return { kind: 'newarray', elementType, size, line: tok.line };
        }
        if (base !== 'string') {
          this.fail('Only new string(...) and new int[n] are supported');
        }
        this.expect('(');
        const args: Expr[] = [];
        if (!this.at(')')) {
          do {
            args.push(this.parseExpression());
          } while (this.eat(','));
        }
        this.expect(')');
        return { kind: 'new', typeName: base, args, line: tok.line };
      }
      if (tok.value === 'this' || tok.value === 'base') {
        this.fail("'this' and 'base' are not supported", 'All methods are treated as static.');
      }
      this.next();
      return { kind: 'ident', name: tok.value, line: tok.line };
    }

    if (tok.kind === 'op' && tok.value === '(') {
      const nextTok = this.peek(1);
      const closeTok = this.peek(2);
      if (nextTok.kind === 'ident' && mapType(nextTok.value) && closeTok.kind === 'op' && closeTok.value === ')') {
        this.next();
        const typeName = this.parseType();
        this.expect(')');
        return { kind: 'cast', type: typeName, expr: this.parseUnary(), line: tok.line };
      }
      this.next();
      const expr = this.parseExpression();
      this.expect(')');
      return expr;
    }

    this.fail(`Unexpected ${describe(tok)}`);
  }

  private parseInterpolated(tok: Token): Expr {
    const raw = tok.raw ?? '';
    const verbatim = tok.verbatim === true;
    const parts: (string | Expr)[] = [];
    let lit = '';
    let i = 0;

    const flush = (): void => {
      if (lit.length > 0) {
        parts.push(lit);
        lit = '';
      }
    };

    while (i < raw.length) {
      const c = raw[i];

      if (!verbatim && c === '\\') {
        const decoded = decodeEscape(raw.slice(i));
        if (!decoded) {
          this.fail('Invalid escape sequence in interpolated string');
        }
        lit += decoded.text;
        i += decoded.length;
        continue;
      }

      if (verbatim && c === '"' && raw[i + 1] === '"') {
        lit += '"';
        i += 2;
        continue;
      }

      if (c === '{') {
        if (raw[i + 1] === '{') {
          lit += '{';
          i += 2;
          continue;
        }
        let depth = 0;
        let j = i + 1;
        for (; j < raw.length; j++) {
          if (raw[j] === '{') depth++;
          else if (raw[j] === '}') {
            if (depth === 0) break;
            depth--;
          }
        }
        if (j >= raw.length) {
          this.fail('Unterminated interpolation hole', 'Close the {expression} with }.');
        }
        const code = stripHoleFormat(raw.slice(i + 1, j));
        if (code.trim().length === 0) this.fail('Empty interpolation hole');
        flush();

        const subLex = tokenize(code);
        if (subLex.errors.length > 0) {
          this.fail(subLex.errors[0].message, subLex.errors[0].hint);
        }
        for (const subTok of subLex.tokens) {
          subTok.line = tok.line;
          subTok.column = tok.column;
        }
        const subParser = new Parser(subLex.tokens);
        const expr = subParser.parseExpression();
        if (!subParser.atEof()) subParser.fail('Unexpected token inside interpolation hole');
        parts.push(expr);
        i = j + 1;
        continue;
      }

      if (c === '}' && raw[i + 1] === '}') {
        lit += '}';
        i += 2;
        continue;
      }

      lit += c;
      i++;
    }

    flush();
    if (parts.length === 0) parts.push('');
    return { kind: 'interp', parts, line: tok.line };
  }
}

function stripHoleFormat(code: string): string {
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if ((c === ':' || c === ',') && depth === 0) return code.slice(0, i);
  }
  return code;
}

function decodeEscape(text: string): { text: string; length: number } | null {
  if (text[0] !== '\\') return null;
  const c = text[1];
  switch (c) {
    case 'n': return { text: '\n', length: 2 };
    case 'r': return { text: '\r', length: 2 };
    case 't': return { text: '\t', length: 2 };
    case '0': return { text: '\0', length: 2 };
    case '\\': return { text: '\\', length: 2 };
    case '"': return { text: '"', length: 2 };
    case "'": return { text: "'", length: 2 };
    case 'u': {
      const hex = text.slice(2, 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      return { text: String.fromCharCode(parseInt(hex, 16)), length: 6 };
    }
    case 'x': {
      const hex = text.slice(2, 6).match(/^[0-9a-fA-F]{2,4}/);
      if (!hex) return null;
      return { text: String.fromCharCode(parseInt(hex[0], 16)), length: 2 + hex[0].length };
    }
    default:
      return { text: c ?? '', length: 2 };
  }
}
