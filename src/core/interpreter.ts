import type { MethodDecl, Program, Stmt, Expr, TypeName, Param } from './parser.ts';
import { findEntry, flatMethods } from './parser.ts';
import type { ConsoleEvent, Diagnostic, Repair } from './types.ts';

type Value =
  | { t: 'int'; v: number }
  | { t: 'double'; v: number }
  | { t: 'string'; v: string }
  | { t: 'char'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'array'; items: Value[] }
  | { t: 'null' };

const NULL_VALUE: Value = { t: 'null' };

const intV = (v: number): Value => ({ t: 'int', v: Math.trunc(v) || 0 });
const doubleV = (v: number): Value => ({ t: 'double', v: Number.isFinite(v) ? v : 0 });
const stringV = (v: string): Value => ({ t: 'string', v });
const charV = (v: string): Value => ({ t: 'char', v: Array.from(v)[0] ?? '\0' });
const boolV = (v: boolean): Value => ({ t: 'bool', v });

function toStr(v: Value): string {
  switch (v.t) {
    case 'int':
      return String(v.v);
    case 'double':
      return Number.isInteger(v.v) ? String(v.v) : String(Number(v.v.toFixed(6)));
    case 'string':
      return v.v;
    case 'char':
      return v.v;
    case 'bool':
      return v.v ? 'True' : 'False';
    case 'array':
      return 'System.String[]';
    default:
      return '';
  }
}

function toNum(v: Value): number {
  switch (v.t) {
    case 'int':
    case 'double':
      return v.v;
    case 'bool':
      return v.v ? 1 : 0;
    case 'char':
      return v.v.charCodeAt(0) || 0;
    case 'string': {
      const parsed = Number(v.v.trim());
      return Number.isFinite(parsed) ? parsed : 0;
    }
    default:
      return 0;
  }
}

function toBool(v: Value): boolean {
  switch (v.t) {
    case 'bool':
      return v.v;
    case 'int':
    case 'double':
      return v.v !== 0;
    case 'string':
      return v.v.length > 0;
    case 'char':
      return v.v !== '\0';
    case 'array':
      return v.items.length > 0;
    default:
      return false;
  }
}

interface Cell {
  type: TypeName;
  value: Value;
}

class Scope {
  vars = new Map<string, Cell>();
  parent?: Scope;

  constructor(parent?: Scope) {
    this.parent = parent;
  }

  lookup(name: string): Cell | undefined {
    let scope: Scope | undefined = this;
    while (scope) {
      const cell = scope.vars.get(name);
      if (cell) return cell;
      scope = scope.parent;
    }
    return undefined;
  }

  declare(name: string, type: TypeName, value: Value): void {
    this.vars.set(name, { type, value });
  }
}

class BreakSignal {}
class ContinueSignal {}
class ReturnSignal {
  value: Value;
  constructor(value: Value) {
    this.value = value;
  }
}
class ExitSignal {
  code: number;
  constructor(code: number) {
    this.code = code;
  }
}
class BudgetExceeded {}
class OutputLimit {}

export interface RunOptions {
  maxSteps?: number;
  maxLines?: number;
  maxDepth?: number;
}

export interface RunResult {
  events: ConsoleEvent[];
  patches: Repair[];
  warnings: Diagnostic[];
  steps: number;
  exitCode: number;
  truncated: boolean;
  fatal?: Diagnostic;
}

const DEFAULT_TYPE_VALUES: Record<string, Value> = {
  int: intV(0),
  double: doubleV(0),
  string: stringV(''),
  bool: boolV(false),
  char: charV('\0'),
  void: NULL_VALUE,
  var: intV(0),
  'string[]': { t: 'array', items: [] },
};

export function runProgram(program: Program, options: RunOptions = {}): RunResult {
  const interp = new Interpreter(program, options);
  return interp.run();
}

class Interpreter {
  private program: Program;
  private maxSteps: number;
  private maxLines: number;
  private maxDepth: number;

  private events: ConsoleEvent[] = [];
  private patches: Repair[] = [];
  private patchKeys = new Set<string>();
  private warnings: Diagnostic[] = [];
  private steps = 0;
  private lines = 0;
  private lineBuffer = '';
  private truncated = false;
  private exitCode = 0;
  private depth = 0;
  private globals = new Scope();
  private methods = new Map<string, MethodDecl>();
  private methodsByName = new Map<string, MethodDecl[]>();

  constructor(program: Program, options: RunOptions) {
    this.program = program;
    this.maxSteps = options.maxSteps ?? 2_000_000;
    this.maxLines = options.maxLines ?? 500;
    this.maxDepth = options.maxDepth ?? 96;

    for (const method of flatMethods(program)) {
      const key = `${method.name}/${method.params.length}`;
      if (!this.methods.has(key)) this.methods.set(key, method);
      const list = this.methodsByName.get(method.name) ?? [];
      list.push(method);
      this.methodsByName.set(method.name, list);
    }
  }

  run(): RunResult {
    const entry = findEntry(this.program);
    if (!entry) {
      return {
        events: [],
        patches: [],
        warnings: [],
        steps: 0,
        exitCode: 1,
        truncated: false,
        fatal: {
          severity: 'error',
          message: 'No Main() entry point found',
          hint: 'Add `static void Main()` or `static void Main(string[] args)` to a class.',
        },
      };
    }

    this.initGlobals();

    const scope = new Scope(this.globals);
    if (entry.params.length === 1) {
      this.bindParam(scope, entry.params[0], { t: 'array', items: [] });
    }

    try {
      this.execBlock(entry.body, scope);
    } catch (err) {
      if (err instanceof ReturnSignal) {
        this.exitCode = err.value.t === 'int' ? err.value.v : err.value.t === 'null' ? 0 : 0;
      } else if (err instanceof ExitSignal) {
        this.exitCode = err.code;
      } else if (err instanceof BudgetExceeded) {
        this.truncated = true;
        this.warnings.push({
          severity: 'warning',
          message: `Execution stopped after ${this.maxSteps.toLocaleString()} steps (possible endless loop).`,
          hint: 'The image was still generated with the output produced so far.',
        });
      } else if (err instanceof OutputLimit) {
        this.truncated = true;
        this.warnings.push({
          severity: 'warning',
          message: `Console output exceeded ${this.maxLines} lines and was truncated.`,
        });
      } else if (!(err instanceof BreakSignal || err instanceof ContinueSignal)) {
        throw err;
      }
    }

    this.flush();

    return {
      events: this.events,
      patches: this.patches,
      warnings: this.warnings,
      steps: this.steps,
      exitCode: this.exitCode,
      truncated: this.truncated,
    };
  }

  private initGlobals(): void {
    for (const cls of this.program.classes) {
      for (const field of cls.fields) {
        let value: Value;
        if (field.init) {
          value = this.evalExpr(field.init, this.globals);
        } else {
          value = DEFAULT_TYPE_VALUES[field.type] ?? intV(0);
        }
        if (field.type !== 'var') value = this.coerce(field.type, value);
        this.globals.declare(field.name, field.type, value);
      }
    }
  }

  private patch(title: string, detail?: string, line?: number): void {
    const key = `${title}|${line ?? ''}`;
    if (this.patchKeys.has(key)) return;
    if (this.patches.length >= 40) return;
    this.patchKeys.add(key);
    this.patches.push({ phase: 'runtime', title, detail, line });
  }

  private tick(): void {
    this.steps++;
    if (this.steps > this.maxSteps) throw new BudgetExceeded();
  }

  private emitLine(text: string): void {
    if (this.lines >= this.maxLines) throw new OutputLimit();
    this.lines++;
    const clipped = text.length > 400 ? text.slice(0, 400) : text;
    if (clipped.length !== text.length) {
      this.patch('Clipped a very long console line to 400 characters', undefined, undefined);
    }
    this.events.push({ kind: 'line', text: clipped });
  }

  private flush(): void {
    if (this.lineBuffer.length > 0) {
      this.emitLine(this.lineBuffer);
      this.lineBuffer = '';
    }
  }

  private bindParam(scope: Scope, param: Param, value: Value): void {
    scope.declare(param.name, param.type, this.coerce(param.type, value));
  }

  private coerce(type: TypeName, value: Value): Value {
    switch (type) {
      case 'int':
        return intV(toNum(value));
      case 'double':
        return doubleV(toNum(value));
      case 'string':
        return stringV(toStr(value));
      case 'bool':
        return boolV(toBool(value));
      case 'char':
        return charV(toStr(value));
      case 'string[]':
        return value.t === 'array' ? value : { t: 'array', items: [] };
      case 'void':
        return NULL_VALUE;
      default:
        return value;
    }
  }

  private defaultFor(type: TypeName): Value {
    return DEFAULT_TYPE_VALUES[type] ?? intV(0);
  }

  private execBlock(stmts: Stmt[], scope: Scope): void {
    for (const stmt of stmts) this.execStmt(stmt, scope);
  }

  private execStmt(stmt: Stmt, scope: Scope): void {
    this.tick();

    switch (stmt.kind) {
      case 'block':
        this.execBlock(stmt.body, new Scope(scope));
        return;

      case 'empty':
        return;

      case 'var': {
        let value: Value;
        let type = stmt.type;
        if (stmt.init) {
          value = this.evalExpr(stmt.init, scope);
          if (type === 'var') type = typeOfValue(value);
        } else {
          value = type === 'var' ? intV(0) : this.defaultFor(type);
          if (type === 'var') {
            this.patch('`var` declaration without initializer defaulted to int 0', undefined, stmt.line);
            type = 'int';
          }
        }
        if (scope.vars.has(stmt.name)) {
          this.patch(`Duplicate local '${stmt.name}' shadowed`, undefined, stmt.line);
        }
        scope.declare(stmt.name, type, this.coerce(type, value));
        return;
      }

      case 'expr':
        this.evalExpr(stmt.expr, scope);
        return;

      case 'if':
        if (toBool(this.evalExpr(stmt.cond, scope))) {
          this.execBlock(stmt.then, new Scope(scope));
        } else if (stmt.otherwise) {
          this.execBlock(stmt.otherwise, new Scope(scope));
        }
        return;

      case 'while': {
        let guard = 0;
        while (toBool(this.evalExpr(stmt.cond, scope))) {
          this.tick();
          try {
            this.execBlock(stmt.body, new Scope(scope));
          } catch (err) {
            if (err instanceof BreakSignal) break;
            if (!(err instanceof ContinueSignal)) throw err;
          }
          if (++guard > this.maxSteps) throw new BudgetExceeded();
        }
        return;
      }

      case 'do': {
        let guard = 0;
        do {
          this.tick();
          try {
            this.execBlock(stmt.body, new Scope(scope));
          } catch (err) {
            if (err instanceof BreakSignal) break;
            if (!(err instanceof ContinueSignal)) throw err;
          }
          if (++guard > this.maxSteps) throw new BudgetExceeded();
        } while (toBool(this.evalExpr(stmt.cond, scope)));
        return;
      }

      case 'for': {
        const loopScope = new Scope(scope);
        if (stmt.init) this.execStmt(stmt.init, loopScope);
        let guard = 0;
        while (stmt.cond === undefined || toBool(this.evalExpr(stmt.cond, loopScope))) {
          this.tick();
          try {
            this.execBlock(stmt.body, new Scope(loopScope));
          } catch (err) {
            if (err instanceof BreakSignal) break;
            if (!(err instanceof ContinueSignal)) throw err;
          }
          if (stmt.update) this.execStmt(stmt.update, loopScope);
          if (++guard > this.maxSteps) throw new BudgetExceeded();
        }
        return;
      }

      case 'break':
        throw new BreakSignal();

      case 'continue':
        throw new ContinueSignal();

      case 'return':
        throw new ReturnSignal(stmt.value ? this.evalExpr(stmt.value, scope) : NULL_VALUE);
    }
  }

  private evalExpr(expr: Expr, scope: Scope): Value {
    switch (expr.kind) {
      case 'num':
        return expr.isInt ? intV(expr.value) : doubleV(expr.value);

      case 'str':
        return stringV(expr.value);

      case 'char':
        return charV(expr.value);

      case 'bool':
        return boolV(expr.value);

      case 'null':
        return NULL_VALUE;

      case 'ident': {
        const cell = scope.lookup(expr.name);
        if (cell) return cell.value;
        if (expr.name === 'args') return { t: 'array', items: [] };
        this.patch(`Undeclared identifier '${expr.name}' defaulted to 0`, 'The variable was never declared in this scope.', expr.line);
        scope.declare(expr.name, 'int', intV(0));
        return intV(0);
      }

      case 'member': {
        if (expr.object.kind === 'ident') {
          const staticValue = this.staticMember(expr.object.name, expr.name);
          if (staticValue) return staticValue;
        }
        const object = this.evalExpr(expr.object, scope);
        return this.instanceMember(object, expr.name, expr.line);
      }

      case 'index': {
        const object = this.evalExpr(expr.object, scope);
        const index = Math.trunc(toNum(this.evalExpr(expr.index, scope)));
        if (object.t === 'array') {
          if (index < 0 || index >= object.items.length) {
            this.patch(`Array index ${index} is out of range (length ${object.items.length})`, 'Returned an empty string.', expr.line);
            return stringV('');
          }
          return object.items[index];
        }
        if (object.t === 'string' || object.t === 'char') {
          const chars = Array.from(toStr(object));
          if (index < 0 || index >= chars.length) {
            this.patch(`String index ${index} is out of range (length ${chars.length})`, 'Returned a space.', expr.line);
            return charV(' ');
          }
          return charV(chars[index]);
        }
        this.patch('Indexing a non-sequence value returned 0', undefined, expr.line);
        return intV(0);
      }

      case 'call':
        return this.evalCall(expr, scope);

      case 'binary':
        return this.evalBinary(expr, scope);

      case 'unary': {
        const value = this.evalExpr(expr.expr, scope);
        if (expr.op === '!') return boolV(!toBool(value));
        if (expr.op === '-') return value.t === 'double' ? doubleV(-value.v) : intV(-toNum(value));
        return value.t === 'double' ? doubleV(toNum(value)) : intV(toNum(value));
      }

      case 'update': {
        const target = expr.target;
        if (target.kind !== 'ident') {
          this.patch(`Cannot apply '${expr.op}' to this expression`, undefined, expr.line);
          return intV(0);
        }
        const cell = scope.lookup(target.name);
        if (!cell) {
          this.patch(`Undeclared identifier '${target.name}' created as 0`, undefined, expr.line);
          scope.declare(target.name, 'int', intV(0));
          return intV(0);
        }
        const before = toNum(cell.value);
        const after = before + (expr.op === '++' ? 1 : -1);
        cell.value = cell.type === 'double' ? doubleV(after) : intV(after);
        return expr.prefix ? cell.value : cell.type === 'double' ? doubleV(before) : intV(before);
      }

      case 'assign': {
        const value = this.evalExpr(expr.value, scope);
        return this.assignTo(expr.target, expr.op, value, scope, expr.line);
      }

      case 'cond':
        return toBool(this.evalExpr(expr.cond, scope))
          ? this.evalExpr(expr.a, scope)
          : this.evalExpr(expr.b, scope);

      case 'interp':
        return stringV(
          expr.parts
            .map((part) => (typeof part === 'string' ? part : toStr(this.evalExpr(part, scope))))
            .join(''),
        );

      case 'new': {
        if (expr.args.length !== 2) {
          this.patch("new string(...) expects (char, count)", undefined, expr.line);
          return stringV('');
        }
        const ch = toStr(this.evalExpr(expr.args[0], scope));
        const count = Math.max(0, Math.min(5000, Math.trunc(toNum(this.evalExpr(expr.args[1], scope)))));
        return stringV((Array.from(ch)[0] ?? ' ').repeat(count));
      }

      case 'cast': {
        const value = this.evalExpr(expr.expr, scope);
        if (expr.type === 'int') return intV(toNum(value));
        if (expr.type === 'double') return doubleV(toNum(value));
        if (expr.type === 'string') return stringV(toStr(value));
        if (expr.type === 'bool') return boolV(toBool(value));
        if (expr.type === 'char') return charV(toStr(value));
        return value;
      }
    }
  }

  private assignTo(target: Expr, op: string, value: Value, scope: Scope, line: number): Value {
    if (target.kind !== 'ident') {
      this.patch('Assignment target is not a local variable — the write was skipped', undefined, line);
      return value;
    }
    const cell = scope.lookup(target.name);
    if (!cell) {
      const declared = this.coerce('int', value);
      scope.declare(target.name, 'int', declared);
      this.patch(`Undeclared variable '${target.name}' created by assignment`, 'Assumed int.', line);
      return declared;
    }

    let next = value;
    if (op !== '=') {
      const current = cell.value;
      const numeric = op === '+=' && (current.t === 'string' || value.t === 'string');
      if (numeric) {
        next = stringV(toStr(current) + toStr(value));
      } else {
        const a = toNum(current);
        const b = toNum(value);
        const isDouble = current.t === 'double' || value.t === 'double';
        let result = 0;
        if (op === '+=') result = a + b;
        else if (op === '-=') result = a - b;
        else if (op === '*=') result = a * b;
        else if (op === '/=') result = b === 0 ? 0 : a / b;
        else if (op === '%=') result = b === 0 ? 0 : a % b;
        if ((op === '/=' || op === '%=') && b === 0) {
          this.patch('Division by zero returned 0', undefined, line);
        }
        next = isDouble ? doubleV(result) : intV(result);
      }
    }

    cell.value = this.coerce(cell.type, next);
    return cell.value;
  }

  private evalBinary(expr: Expr & { kind: 'binary' }, scope: Scope): Value {
    if (expr.op === '&&') {
      if (!toBool(this.evalExpr(expr.left, scope))) return boolV(false);
      return boolV(toBool(this.evalExpr(expr.right, scope)));
    }
    if (expr.op === '||') {
      if (toBool(this.evalExpr(expr.left, scope))) return boolV(true);
      return boolV(toBool(this.evalExpr(expr.right, scope)));
    }

    const left = this.evalExpr(expr.left, scope);
    const right = this.evalExpr(expr.right, scope);

    if (expr.op === '==') return boolV(looseEquals(left, right));
    if (expr.op === '!=') return boolV(!looseEquals(left, right));

    if (expr.op === '+') {
      if (isTextual(left) || isTextual(right)) return stringV(toStr(left) + toStr(right));
      const isDouble = left.t === 'double' || right.t === 'double';
      const sum = toNum(left) + toNum(right);
      return isDouble ? doubleV(sum) : intV(sum);
    }

    const isStringish = isTextual(left) && isTextual(right);
    if (isStringish && ['<', '<=', '>', '>='].includes(expr.op)) {
      const a = toStr(left);
      const b = toStr(right);
      if (expr.op === '<') return boolV(a < b);
      if (expr.op === '<=') return boolV(a <= b);
      if (expr.op === '>') return boolV(a > b);
      return boolV(a >= b);
    }

    const a = toNum(this.coerceNumericOperand(left, expr.line));
    const b = toNum(this.coerceNumericOperand(right, expr.line));

    switch (expr.op) {
      case '-':
        return left.t === 'double' || right.t === 'double' ? doubleV(a - b) : intV(a - b);
      case '*':
        return left.t === 'double' || right.t === 'double' ? doubleV(a * b) : intV(a * b);
      case '/':
        if (b === 0) {
          this.patch('Division by zero returned 0', undefined, expr.line);
          return left.t === 'double' || right.t === 'double' ? doubleV(0) : intV(0);
        }
        return left.t === 'double' || right.t === 'double' ? doubleV(a / b) : intV(Math.trunc(a / b));
      case '%':
        if (b === 0) {
          this.patch('Modulo by zero returned 0', undefined, expr.line);
          return intV(0);
        }
        return intV(a % b);
      case '<':
        return boolV(a < b);
      case '<=':
        return boolV(a <= b);
      case '>':
        return boolV(a > b);
      case '>=':
        return boolV(a >= b);
      default:
        this.patch(`Operator '${expr.op}' is not supported`, 'Returned 0.', expr.line);
        return intV(0);
    }
  }

  private coerceNumericOperand(value: Value, line: number): Value {
    if (value.t === 'string' && !Number.isFinite(Number(value.v.trim()))) {
      this.patch('Non-numeric string used in arithmetic treated as 0', undefined, line);
    }
    return value;
  }

  private evalCall(call: Expr & { kind: 'call' }, scope: Scope): Value {
    const callee = call.callee;

    if (callee.kind === 'member') {
      if (callee.object.kind === 'ident') {
        const owner = callee.object.name;
        if (owner === 'Console') return this.consoleCall(callee.name, call.args, scope, call.line);
        if (isStaticOwner(owner)) return this.staticCall(owner, callee.name, call.args, scope, call.line);
      }
      const object = this.evalExpr(callee.object, scope);
      return this.instanceCall(object, callee.name, call.args, scope, call.line);
    }

    if (callee.kind === 'ident') {
      return this.userCall(callee.name, call.args, scope, call.line);
    }

    this.patch('Unsupported call expression, skipped', undefined, call.line);
    return NULL_VALUE;
  }

  private argValues(args: Expr[], scope: Scope): Value[] {
    return args.map((arg) => this.evalExpr(arg, scope));
  }

  private consoleCall(name: string, args: Expr[], scope: Scope, line: number): Value {
    const values = this.argValues(args, scope);

    if (name === 'Clear') {
      this.flush();
      this.events.push({ kind: 'clear' });
      return NULL_VALUE;
    }

    if (name === 'WriteLine' || name === 'Write') {
      let text = '';
      if (values.length === 1) {
        text = toStr(values[0]);
      } else if (values.length > 1) {
        text = formatText(toStr(values[0]), values.slice(1));
      }
      if (name === 'WriteLine') {
        this.emitLine(this.lineBuffer + text);
        this.lineBuffer = '';
      } else {
        this.lineBuffer += text;
        if (this.lineBuffer.length > 4000) {
          this.patch('A Console.Write line grew past 4000 characters and was flushed', undefined, line);
          this.emitLine(this.lineBuffer);
          this.lineBuffer = '';
        }
      }
      return NULL_VALUE;
    }

    if (name === 'ReadLine' || name === 'ReadKey') {
      this.patch('Console.' + name + ' has no keyboard input in this kernel', 'Returned an empty string.', line);
      return stringV('');
    }

    this.patch(`Console.${name} is not supported`, 'The call was skipped.', line);
    return NULL_VALUE;
  }

  private staticCall(owner: string, name: string, args: Expr[], scope: Scope, line: number): Value {
    const values = this.argValues(args, scope);

    if (owner === 'string' || owner === 'String') {
      if (name === 'Format') {
        if (values.length === 0) return stringV('');
        return stringV(formatText(toStr(values[0]), values.slice(1)));
      }
      if (name === 'Concat') return stringV(values.map(toStr).join(''));
      if (name === 'IsNullOrEmpty') return boolV(toStr(values[0] ?? NULL_VALUE).length === 0);
      if (name === 'IsNullOrWhiteSpace') return boolV(toStr(values[0] ?? NULL_VALUE).trim().length === 0);
      if (name === 'Join') {
        const sep = toStr(values[0] ?? stringV(','));
        const list = values[1];
        if (list && list.t === 'array') return stringV(list.items.map(toStr).join(sep));
        return stringV(values.slice(1).map(toStr).join(sep));
      }
    }

    if (owner === 'int' || owner === 'Int32' || owner === 'double') {
      if (name === 'Parse') {
        const text = toStr(values[0] ?? NULL_VALUE).trim();
        const parsed = Number(text);
        if (!Number.isFinite(parsed)) {
          this.patch(`Could not parse '${text}' as a number — returned 0`, undefined, line);
          return intV(0);
        }
        return owner === 'double' ? doubleV(parsed) : intV(parsed);
      }
      if (name === 'TryParse') {
        this.patch('TryParse is not supported — use Parse', undefined, line);
        return boolV(false);
      }
    }

    if (owner === 'Convert') {
      if (name === 'ToInt32') return intV(toNum(values[0] ?? NULL_VALUE));
      if (name === 'ToDouble') return doubleV(toNum(values[0] ?? NULL_VALUE));
      if (name === 'ToString') return stringV(toStr(values[0] ?? NULL_VALUE));
      if (name === 'ToBoolean') return boolV(toBool(values[0] ?? NULL_VALUE));
    }

    if (owner === 'Math') {
      const a = toNum(values[0] ?? NULL_VALUE);
      const b = toNum(values[1] ?? NULL_VALUE);
      switch (name) {
        case 'Abs': return intV(Math.abs(a));
        case 'Min': return intV(Math.min(a, b));
        case 'Max': return intV(Math.max(a, b));
        case 'Pow': return doubleV(Math.pow(a, b));
        case 'Sqrt': return doubleV(Math.sqrt(a));
        case 'Floor': return doubleV(Math.floor(a));
        case 'Ceiling': return doubleV(Math.ceil(a));
        case 'Round': return doubleV(Math.round(a));
        case 'Sin': return doubleV(Math.sin(a));
        case 'Cos': return doubleV(Math.cos(a));
        case 'Tan': return doubleV(Math.tan(a));
        case 'Sign': return intV(Math.sign(a));
      }
    }

    if (owner === 'Environment') {
      if (name === 'Exit') throw new ExitSignal(Math.trunc(toNum(values[0] ?? intV(0))));
    }

    if (owner === 'Thread') {
      if (name === 'Sleep') {
        this.patch('Thread.Sleep is ignored — the kernel has no scheduler', undefined, line);
        return NULL_VALUE;
      }
    }

    this.patch(`${owner}.${name} is not supported`, 'The call was skipped.', line);
    return NULL_VALUE;
  }

  private instanceCall(object: Value, name: string, args: Expr[], scope: Scope, line: number): Value {
    const values = this.argValues(args, scope);

    if (name === 'ToString') {
      return stringV(toStr(object));
    }

    if (object.t === 'string' || object.t === 'char') {
      const text = toStr(object);
      switch (name) {
        case 'ToUpper': return stringV(text.toUpperCase());
        case 'ToLower': return stringV(text.toLowerCase());
        case 'Trim': return stringV(text.trim());
        case 'TrimStart': return stringV(text.replace(/^\s+/, ''));
        case 'TrimEnd': return stringV(text.replace(/\s+$/, ''));
        case 'Substring': {
          const start = Math.trunc(toNum(values[0] ?? intV(0)));
          const length = values.length > 1 ? Math.trunc(toNum(values[1])) : text.length - start;
          if (start < 0 || start > text.length) {
            this.patch(`Substring start ${start} is out of range`, 'Returned an empty string.', line);
            return stringV('');
          }
          return stringV(text.substr(start, Math.max(0, length)));
        }
        case 'Replace':
          return stringV(text.split(toStr(values[0] ?? stringV(''))).join(toStr(values[1] ?? stringV(''))));
        case 'Contains':
          return boolV(text.includes(toStr(values[0] ?? stringV(''))));
        case 'StartsWith':
          return boolV(text.startsWith(toStr(values[0] ?? stringV(''))));
        case 'EndsWith':
          return boolV(text.endsWith(toStr(values[0] ?? stringV(''))));
        case 'IndexOf':
          return intV(text.indexOf(toStr(values[0] ?? stringV(''))));
        case 'PadLeft': {
          const width = Math.trunc(toNum(values[0] ?? intV(0)));
          const pad = toStr(values[1] ?? stringV(' ')) || ' ';
          return stringV(text.padStart(width, pad.charAt(0)));
        }
        case 'PadRight': {
          const width = Math.trunc(toNum(values[0] ?? intV(0)));
          const pad = toStr(values[1] ?? stringV(' ')) || ' ';
          return stringV(text.padEnd(width, pad.charAt(0)));
        }
        case 'Equals':
          return boolV(text === toStr(values[0] ?? NULL_VALUE));
        case 'ToCharArray':
          return { t: 'array', items: Array.from(text).map(charV) };
        case 'Split':
          this.patch('String.Split is not supported', 'Returned an empty array.', line);
          return { t: 'array', items: [] };
        case 'Length':
          this.patch('String.Length is a property, not a method', undefined, line);
          return intV(text.length);
      }
    }

    if (object.t === 'array') {
      if (name === 'GetLength') return intV(object.items.length);
    }

    this.patch(`Method '${name}' is not supported on ${object.t}`, 'The call was skipped.', line);
    return NULL_VALUE;
  }

  private staticMember(owner: string, name: string): Value | undefined {
    if (owner === 'Math') {
      if (name === 'PI') return doubleV(Math.PI);
      if (name === 'E') return doubleV(Math.E);
    }
    if (owner === 'int' || owner === 'Int32') {
      if (name === 'MaxValue') return intV(2147483647);
      if (name === 'MinValue') return intV(-2147483648);
    }
    if (owner === 'double') {
      if (name === 'MaxValue') return doubleV(Number.MAX_VALUE);
      if (name === 'MinValue') return doubleV(-Number.MAX_VALUE);
    }
    if (owner === 'string' || owner === 'String') {
      if (name === 'Empty') return stringV('');
    }
    if (owner === 'Environment' && name === 'NewLine') return stringV('\n');
    if (owner === 'Console' && name === 'Title') return stringV('');
    return undefined;
  }

  private instanceMember(object: Value, name: string, line: number): Value {
    if (name === 'Length') {
      if (object.t === 'string' || object.t === 'char') return intV(Array.from(toStr(object)).length);
      if (object.t === 'array') return intV(object.items.length);
      this.patch(`'Length' is not defined on ${object.t}`, 'Returned 0.', line);
      return intV(0);
    }
    if (object.t === 'array' && name === 'Count') return intV(object.items.length);
    this.patch(`Member '${name}' is not available on this value`, 'Returned an empty value.', line);
    return NULL_VALUE;
  }

  private userCall(name: string, args: Expr[], scope: Scope, line: number): Value {
    const method = this.methods.get(`${name}/${args.length}`);
    if (!method) {
      const alternatives = this.methodsByName.get(name);
      if (alternatives && alternatives.length > 0) {
        this.patch(
          `Called ${name}() with ${args.length} argument(s), but it takes ${alternatives[0].params.length}`,
          'The call was skipped.',
          line,
        );
      } else {
        this.patch(`Unknown method '${name}()' skipped`, 'It is neither a user method nor a supported built-in.', line);
      }
      return NULL_VALUE;
    }

    if (this.depth >= this.maxDepth) {
      this.patch('Recursion limit reached', `Stopped calling ${name}() beyond ${this.maxDepth} frames.`, line);
      return NULL_VALUE;
    }

    const values = this.argValues(args, scope);
    const local = new Scope(this.globals);
    for (let i = 0; i < method.params.length; i++) {
      this.bindParam(local, method.params[i], values[i] ?? NULL_VALUE);
    }

    this.depth++;
    try {
      this.execBlock(method.body, local);
    } catch (err) {
      if (err instanceof ReturnSignal) {
        return method.returnType === 'void' ? err.value : this.coerce(method.returnType, err.value);
      }
      throw err;
    } finally {
      this.depth--;
    }

    if (method.returnType !== 'void') {
      this.patch(
        `Method ${name}() can finish without returning a value`,
        `Returned the default ${method.returnType} value.`,
        method.line,
      );
      return this.defaultFor(method.returnType);
    }
    return NULL_VALUE;
  }
}

function isTextual(value: Value): boolean {
  return value.t === 'string' || value.t === 'char';
}

function isStaticOwner(name: string): boolean {
  return [
    'Math', 'Convert', 'string', 'String', 'int', 'Int32', 'double',
    'bool', 'Boolean', 'char', 'Char', 'Environment', 'Thread',
  ].includes(name);
}

function looseEquals(a: Value, b: Value): boolean {
  if (a.t === 'null' || b.t === 'null') return a.t === b.t;
  if (isTextual(a) || isTextual(b)) {
    if (a.t === 'bool' || b.t === 'bool') return toBool(a) === toBool(b);
    return toStr(a) === toStr(b);
  }
  if (a.t === 'bool' || b.t === 'bool') return toBool(a) === toBool(b);
  if (a.t === 'array' || b.t === 'array') return a === b;
  return toNum(a) === toNum(b);
}

function typeOfValue(value: Value): TypeName {
  switch (value.t) {
    case 'int': return 'int';
    case 'double': return 'double';
    case 'string': return 'string';
    case 'char': return 'char';
    case 'bool': return 'bool';
    case 'array': return 'string[]';
    default: return 'var';
  }
}

function formatText(format: string, values: Value[]): string {
  return format.replace(/\{(\d+)(?:,[^}]*)?(?::[^}]*)?\}/g, (match, indexText: string) => {
    const index = Number(indexText);
    return values[index] !== undefined ? toStr(values[index]) : match;
  });
}

export type { Value };
