/**
 * Compiles the C# subset into SharpBoot stack bytecode.
 *
 * The same bytecode is interpreted twice: by the 16-bit kernel on bare metal and
 * by src/core/vm.ts for the live browser preview. Keep both interpreters in sync
 * with the opcode list below.
 */

import type { Diagnostic } from './types.ts';
import type { Expr, MethodDecl, Program, Stmt, TypeName } from './parser.ts';
import { findEntry, flatMethods } from './parser.ts';
import {
  CODE_START,
  MAX_CODE_BYTES,
  MAX_GLOBALS,
  MAX_STRING_BYTES,
  STRING_START,
} from './kernel.ts';
import { GRAPHICS_HEIGHT, GRAPHICS_WIDTH } from './graphics.ts';

export const Op = {
  HALT: 0,
  PUSHI: 1,
  PUSHS: 2,
  LOAD: 3,
  STORE: 4,
  LOADG: 5,
  STOREG: 6,
  ADD: 7,
  SUB: 8,
  MUL: 9,
  DIV: 10,
  MOD: 11,
  NEG: 12,
  EQ: 13,
  NE: 14,
  LT: 15,
  LE: 16,
  GT: 17,
  GE: 18,
  AND: 19,
  OR: 20,
  NOT: 21,
  CONCAT: 22,
  PRINT: 23,
  PRINTLN: 24,
  NEWLINE: 25,
  CLEAR: 26,
  JMP: 27,
  JZ: 28,
  JNZ: 29,
  CALL: 30,
  RET: 31,
  READLINE: 32,
  READKEY: 33,
  TOSTR: 34,
  LEN: 35,
  PARSE: 36,
  DUP: 37,
  POP: 38,
  ABS: 39,
  MIN: 40,
  MAX: 41,
  UPPER: 42,
  LOWER: 43,
  GINIT: 44,
  GEND: 45,
  GCLEAR: 46,
  GPIXEL: 47,
  GFILLRECT: 48,
  GRECT: 49,
  GLINE: 50,
  GFILLCIRCLE: 51,
  GCIRCLE: 52,
  RGB: 53,
} as const;

export type Op = (typeof Op)[keyof typeof Op];

export const OPCODE_COUNT = 54;

type VType = 'int' | 'string' | 'bool' | 'void';

interface GlobalVar {
  name: string;
  className: string;
  type: VType;
  index: number;
  init?: Expr;
  line: number;
}

interface CompiledMethod {
  name: string;
  index: number;
  codeOffset: number;
  locals: number;
  params: number;
  returnType: VType;
}

export interface CompiledProgram {
  code: Uint8Array;
  strings: Uint8Array;
  methods: CompiledMethod[];
  entryIndex: number;
  globalCount: number;
  diagnostics: Diagnostic[];
  stats: {
    bytecodeBytes: number;
    stringBytes: number;
    methods: number;
    globals: number;
    instructions: number;
  };
}

interface FnState {
  method: MethodDecl;
  nextSlot: number;
  scopes: Map<string, { slot: number; type: VType }>[];
  breaks: number[][];
  continues: number[][];
  returnType: VType;
  isEntry: boolean;
}

const DEFAULT_TEXT = '';

export function compileToBytecode(program: Program): CompiledProgram {
  return new Compiler(program).compile();
}

class Compiler {
  private program: Program;
  private diagnostics: Diagnostic[] = [];
  private code: number[] = [];
  private instructions = 0;

  private methods: CompiledMethod[] = [];
  private methodByKey = new Map<string, CompiledMethod>();

  private globals: GlobalVar[] = [];
  private globalByName = new Map<string, GlobalVar>();
  private globalByQualified = new Map<string, GlobalVar>();

  private strings = new Map<string, number>();
  private stringData: number[] = [];

  private fn: FnState | null = null;
  private entryIndex = -1;

  constructor(program: Program) {
    this.program = program;
  }

  compile(): CompiledProgram {
    this.collectGlobals();
    this.collectMethods();

    const entry = findEntry(this.program);
    if (!entry) {
      this.error('No Main() entry point found', undefined, 'Add `static void Main()` to a class.');
    } else {
      const compiled = this.methodByKey.get(`${entry.name}/${entry.params.length}`);
      if (!compiled) {
        this.error('Main() could not be compiled', entry.line);
      } else {
        this.entryIndex = compiled.index;
      }
      if (entry.params.length > 1) {
        this.error('Main() can take at most one string[] parameter', entry.line);
      }
    }

    if (entry && this.entryIndex >= 0) {
      for (const method of flatMethods(this.program)) {
        const record = this.methodByKey.get(`${method.name}/${method.params.length}`);
        if (record) this.compileMethod(method, record);
      }
    }

    const code = Uint8Array.from(this.code);
    const strings = Uint8Array.from(this.stringData);
    if (code.length > MAX_CODE_BYTES) {
      this.error(
        `Bytecode is ${code.length} bytes but the kernel slot is ${MAX_CODE_BYTES} bytes`,
        undefined,
        'Shorten the program (fewer methods or simpler expressions).',
      );
    }

    return {
      code,
      strings,
      methods: this.methods,
      entryIndex: this.entryIndex,
      globalCount: this.globals.length,
      diagnostics: this.diagnostics,
      stats: {
        bytecodeBytes: code.length,
        stringBytes: strings.length,
        methods: this.methods.length,
        globals: this.globals.length,
        instructions: this.instructions,
      },
    };
  }

  // ------------------------------------------------------------ collection
  private collectGlobals(): void {
    for (const cls of this.program.classes) {
      for (const field of cls.fields) {
        const type = this.fieldType(field.type, field.line);
        if (!type) continue;
        const index = this.globals.length;
        if (index >= MAX_GLOBALS) {
          this.error(`Too many static fields (limit ${MAX_GLOBALS})`, field.line);
          continue;
        }
        const variable: GlobalVar = {
          name: field.name,
          className: cls.name,
          type,
          index,
          init: field.init,
          line: field.line,
        };
        this.globals.push(variable);
        const qualified = `${cls.name}.${field.name}`;
        this.globalByQualified.set(qualified, variable);
        if (this.globalByName.has(field.name)) {
          this.error(
            `Static field '${field.name}' is declared more than once`,
            field.line,
            'Use one field name across all classes of a SharpBoot program.',
          );
        } else {
          this.globalByName.set(field.name, variable);
        }
      }
    }
  }

  private collectMethods(): void {
    const methods = flatMethods(this.program);
    for (const method of methods) {
      const returnType = this.typeOf(method.returnType, method.line, 'return type');
      if (!returnType) continue;
      for (const param of method.params) {
        if (param.type === 'double') {
          this.error(
            `Parameter '${param.name}' uses double, which this 16-bit runtime cannot represent`,
            method.line,
            'Use int (whole numbers) or string.',
          );
        }
        if (param.type === 'string[]' && !(method.name === 'Main' && method.params.indexOf(param) === 0)) {
          this.error('Only Main(string[] args) may take a string[] parameter', method.line);
        }
      }
      if (method.params.length > 8) {
        this.error(`Method '${method.name}' has ${method.params.length} parameters; the kernel supports 8`, method.line);
      }
      const key = `${method.name}/${method.params.length}`;
      if (this.methodByKey.has(key)) {
        this.error(`Method '${method.name}' is defined more than once with ${method.params.length} parameter(s)`, method.line);
        continue;
      }
      const record: CompiledMethod = {
        name: method.name,
        index: this.methods.length,
        codeOffset: 0,
        locals: 0,
        params: method.params.length,
        returnType,
      };
      this.methods.push(record);
      this.methodByKey.set(key, record);
    }
  }

  private fieldType(type: TypeName, line: number): VType | null {
    if (type === 'void') {
      this.error('A field cannot have type void', line);
      return null;
    }
    return this.typeOf(type, line, 'field type');
  }

  private typeOf(type: TypeName, line: number, what: string): VType | null {
    if (type === 'double') {
      this.error(
        `${what[0].toUpperCase()}${what.slice(1)} 'double' is not supported on bare metal`,
        line,
        'Use int for whole numbers. Floating point and Math.Sin need a runtime this kernel does not have.',
      );
      return null;
    }
    if (type === 'char') return 'string';
    if (type === 'string[]') return 'string';
    if (type === 'var') return null;
    if (type === 'void') return 'void';
    return type;
  }

  // ------------------------------------------------------------ methods
  private compileMethod(method: MethodDecl, record: CompiledMethod): void {
    if (method.returnType === 'double') return;
    const returnType = this.typeOf(method.returnType, method.line, 'return type') ?? 'int';
    const isEntry = record.index === this.entryIndex;
    const state: FnState = {
      method,
      nextSlot: 0,
      scopes: [new Map()],
      breaks: [],
      continues: [],
      returnType,
      isEntry,
    };
    const saved = this.fn;
    this.fn = state;
    record.codeOffset = this.here();

    for (const param of method.params) {
      const type = this.paramType(param.type);
      this.declareLocal(param.name, type);
    }

    if (isEntry) {
      // The kernel jumps straight into Main with BP at the top of the stack.
      for (let i = 0; i < method.params.length; i++) {
        this.emitDefault(this.paramType(method.params[i].type));
        this.emitStore(i);
      }
      // Static field initializers run before the body.
      for (const field of this.globals) {
        if (!field.init) continue;
        const initType = this.compileExpr(field.init);
        this.coerce(initType, field.type, field.line);
        this.emit(Op.STOREG);
        this.emitWord(field.index);
      }
    }

    this.compileStatements(method.body);

    if (isEntry) {
      // Main is entered directly by the kernel, so there is no caller frame:
      // finish with HALT instead of RET.
      this.emit(Op.HALT);
    } else {
      // Other methods return normally; the kernel always expects a value.
      if (returnType === 'void') this.emitWord(Op.PUSHI, 0);
      else this.emitDefault(returnType);
      this.emit(Op.RET);
    }

    record.locals = state.nextSlot;
    record.returnType = returnType;
    this.fn = saved;
  }

  private paramType(type: TypeName): VType {
    if (type === 'double') return 'int';
    if (type === 'char' || type === 'string[]') return 'string';
    if (type === 'void') return 'int';
    return type === 'var' ? 'int' : type;
  }

  private compileStatements(stmts: Stmt[]): void {
    for (const stmt of stmts) this.compileStatement(stmt);
  }

  private compileStatement(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'block':
        this.pushScope();
        this.compileStatements(stmt.body);
        this.popScope();
        return;

      case 'empty':
        return;

      case 'var': {
        const hasInit = stmt.init !== undefined;
        let type: VType;
        if (stmt.type === 'var') {
          if (hasInit) {
            type = this.compileExpr(stmt.init as Expr);
            if (type === 'void') {
              this.error('Cannot store a void expression in a variable', stmt.line);
              type = 'int';
              this.emitWord(Op.PUSHI, 0);
            }
          } else {
            type = 'int';
            this.emitWord(Op.PUSHI, 0);
          }
        } else {
          const mapped = this.typeOf(stmt.type, stmt.line, 'variable type');
          if (!mapped || mapped === 'void') {
            type = 'int';
            if (hasInit) this.compileExpr(stmt.init as Expr);
            else this.emitWord(Op.PUSHI, 0);
          } else {
            type = mapped;
            if (hasInit) {
              const initType = this.compileExpr(stmt.init as Expr);
              this.coerce(initType, type, stmt.line);
            } else {
              this.emitDefault(type);
            }
          }
        }
        const slot = this.declareLocal(stmt.name, type);
        this.emitStore(slot);
        return;
      }

      case 'expr': {
        const type = this.compileExpr(stmt.expr);
        if (type !== 'void') this.emit(Op.POP);
        return;
      }

      case 'if': {
        const cond = this.compileExpr(stmt.cond);
        if (cond === 'void') this.emitWord(Op.PUSHI, 0);
        const elseJump = this.emitJump(Op.JZ);
        this.pushScope();
        this.compileStatements(stmt.then);
        this.popScope();
        if (stmt.otherwise) {
          const endJump = this.emitJump(Op.JMP);
          this.patchToHere(elseJump);
          this.pushScope();
          this.compileStatements(stmt.otherwise);
          this.popScope();
          this.patchToHere(endJump);
        } else {
          this.patchToHere(elseJump);
        }
        return;
      }

      case 'while': {
        const start = this.here();
        const cond = this.compileExpr(stmt.cond);
        if (cond === 'void') this.emitWord(Op.PUSHI, 0);
        const endJump = this.emitJump(Op.JZ);
        this.fn?.breaks.push([]);
        this.fn?.continues.push([]);
        this.pushScope();
        this.compileStatements(stmt.body);
        this.popScope();
        this.patchTo(this.emitJump(Op.JMP), start);
        const breaks = this.fn?.breaks.pop() ?? [];
        const continues = this.fn?.continues.pop() ?? [];
        for (const pos of continues) this.patchTo(pos, start);
        for (const pos of breaks) this.patchToHere(pos);
        this.patchToHere(endJump);
        return;
      }

      case 'do': {
        const start = this.here();
        this.fn?.breaks.push([]);
        this.fn?.continues.push([]);
        this.pushScope();
        this.compileStatements(stmt.body);
        this.popScope();
        const condLabel = this.here();
        const cond = this.compileExpr(stmt.cond);
        if (cond === 'void') this.emitWord(Op.PUSHI, 0);
        this.patchTo(this.emitJump(Op.JNZ), start);
        const breaks = this.fn?.breaks.pop() ?? [];
        const continues = this.fn?.continues.pop() ?? [];
        for (const pos of continues) this.patchTo(pos, condLabel);
        for (const pos of breaks) this.patchToHere(pos);
        return;
      }

      case 'for': {
        this.pushScope();
        if (stmt.init) this.compileStatement(stmt.init);
        const start = this.here();
        let endJump = -1;
        if (stmt.cond) {
          const cond = this.compileExpr(stmt.cond);
          if (cond === 'void') this.emitWord(Op.PUSHI, 0);
          endJump = this.emitJump(Op.JZ);
        }
        this.fn?.breaks.push([]);
        this.fn?.continues.push([]);
        this.pushScope();
        this.compileStatements(stmt.body);
        this.popScope();
        const updateLabel = this.here();
        if (stmt.update) this.compileStatement(stmt.update);
        this.patchTo(this.emitJump(Op.JMP), start);
        const breaks = this.fn?.breaks.pop() ?? [];
        const continues = this.fn?.continues.pop() ?? [];
        for (const pos of continues) this.patchTo(pos, updateLabel);
        for (const pos of breaks) this.patchToHere(pos);
        if (endJump >= 0) this.patchToHere(endJump);
        this.popScope();
        return;
      }

      case 'break':
      case 'continue': {
        const stack = stmt.kind === 'break' ? this.fn?.breaks : this.fn?.continues;
        if (!stack || stack.length === 0) {
          this.error(`'${stmt.kind}' outside a loop is not supported`, stmt.line);
          return;
        }
        stack[stack.length - 1].push(this.emitJump(Op.JMP));
        return;
      }

      case 'return': {
        if (this.fn?.isEntry) {
          // Main returns to the kernel: HALT rather than popping a fake frame.
          if (stmt.value) {
            const type = this.compileExpr(stmt.value);
            if (type !== 'void') this.emit(Op.POP);
          }
          this.emit(Op.HALT);
          return;
        }
        const expected = this.fn?.returnType ?? 'int';
        if (stmt.value) {
          const type = this.compileExpr(stmt.value);
          this.coerce(type, expected === 'void' ? 'int' : expected, stmt.line);
        } else {
          this.emitWord(Op.PUSHI, 0);
        }
        this.emit(Op.RET);
        return;
      }

      default:
        this.error('This statement is not supported by the SharpBoot compiler', undefined);
    }
  }

  // ------------------------------------------------------------ expressions
  private compileExpr(expr: Expr): VType {
    switch (expr.kind) {
      case 'num': {
        if (!expr.isInt) {
          this.error(
            'Floating-point literals are not supported on bare metal',
            expr.line,
            'Use whole numbers (int).',
          );
          this.emitWord(Op.PUSHI, 0);
          return 'int';
        }
        const value = Math.trunc(expr.value);
        if (value < -32768 || value > 32767) {
          this.error(
            `Literal ${value} does not fit in the kernel's 16-bit signed int`,
            expr.line,
            'Keep integer literals between -32768 and 32767.',
          );
        }
        this.emitWord(Op.PUSHI, value & 0xffff);
        return 'int';
      }

      case 'str':
        this.emitString(expr.value);
        return 'string';

      case 'char':
        this.emitString(expr.value.charAt(0));
        return 'string';

      case 'bool':
        this.emitWord(Op.PUSHI, expr.value ? 1 : 0);
        return 'bool';

      case 'null':
        this.emitString('');
        return 'string';

      case 'interp': {
        let parts = 0;
        for (const part of expr.parts) {
          if (typeof part === 'string') {
            if (part.length === 0 && expr.parts.length > 1) continue;
            this.emitString(part);
          } else {
            const type = this.compileExpr(part);
            this.coerce(type, 'string', expr.line);
          }
          parts++;
        }
        if (parts === 0) {
          this.emitString('');
          return 'string';
        }
        while (parts > 1) {
          this.emit(Op.CONCAT);
          parts--;
        }
        return 'string';
      }

      case 'ident': {
        const local = this.lookupLocal(expr.name);
        if (local) {
          this.emitWord(Op.LOAD, local.slot);
          return local.type;
        }
        const global = this.globalByName.get(expr.name);
        if (global) {
          this.emitWord(Op.LOADG, global.index);
          return global.type;
        }
        this.error(
          `Identifier '${expr.name}' is not declared`,
          expr.line,
          'Declare the variable before using it, or check the spelling.',
        );
        this.emitWord(Op.PUSHI, 0);
        return 'int';
      }

      case 'binary':
        return this.compileBinary(expr);

      case 'unary': {
        if (expr.op === '+' ) {
          const type = this.compileExpr(expr.expr);
          if (type === 'void') this.emitWord(Op.PUSHI, 0);
          return type === 'void' ? 'int' : type;
        }
        const type = this.compileExpr(expr.expr);
        if (type === 'void') this.emitWord(Op.PUSHI, 0);
        if (expr.op === '-') {
          this.emit(Op.NEG);
          return 'int';
        }
        this.emit(Op.NOT);
        return 'bool';
      }

      case 'update': {
        const target = expr.target;
        if (target.kind === 'ident') {
          const local = this.lookupLocal(target.name);
          if (local) {
            this.emitWord(Op.LOAD, local.slot);
            if (expr.prefix) {
              this.emitWord(Op.PUSHI, 1);
              this.emit(expr.op === '++' ? Op.ADD : Op.SUB);
              this.emit(Op.DUP);
              this.emitStore(local.slot);
            } else {
              this.emit(Op.DUP);
              this.emitWord(Op.PUSHI, 1);
              this.emit(expr.op === '++' ? Op.ADD : Op.SUB);
              this.emitStore(local.slot);
            }
            return local.type;
          }
          const global = this.globalByName.get(target.name);
          if (global) {
            this.emitWord(Op.LOADG, global.index);
            if (expr.prefix) {
              this.emitWord(Op.PUSHI, 1);
              this.emit(expr.op === '++' ? Op.ADD : Op.SUB);
              this.emit(Op.DUP);
              this.emit(Op.STOREG);
              this.emitWord(global.index);
            } else {
              this.emit(Op.DUP);
              this.emitWord(Op.PUSHI, 1);
              this.emit(expr.op === '++' ? Op.ADD : Op.SUB);
              this.emit(Op.STOREG);
              this.emitWord(global.index);
            }
            return global.type;
          }
        }
        this.error(`'${expr.op}' needs a variable target`, expr.line);
        this.emitWord(Op.PUSHI, 0);
        return 'int';
      }

      case 'assign':
        return this.compileAssign(expr);

      case 'call':
        return this.compileCall(expr);

      case 'member':
        return this.compileMember(expr);

      case 'index':
        this.error(
          'String and array indexing is not supported by the 16-bit kernel',
          expr.line,
          'Use .Length with a loop over ReadLine input, or build the value you need directly.',
        );
        this.emitWord(Op.PUSHI, 0);
        return 'int';

      case 'cond': {
        const cond = this.compileExpr(expr.cond);
        if (cond === 'void') this.emitWord(Op.PUSHI, 0);
        const elseJump = this.emitJump(Op.JZ);
        const aType = this.compileExpr(expr.a);
        const endJump = this.emitJump(Op.JMP);
        this.patchToHere(elseJump);
        const bType = this.compileExpr(expr.b);
        this.patchToHere(endJump);
        return aType === bType ? aType : 'int';
      }

      case 'cast': {
        const type = this.compileExpr(expr.expr);
        if (expr.type === 'string' || expr.type === 'char') {
          this.coerce(type, 'string', expr.line);
          return 'string';
        }
        if (expr.type === 'bool') {
          this.coerce(type, 'bool', expr.line);
          return 'bool';
        }
        this.coerce(type, 'int', expr.line);
        return 'int';
      }

      case 'new':
        this.error(
          '`new string(...)` is not available in this kernel',
          expr.line,
          'Assign a string literal or build the text with + / concatenation.',
        );
        this.emitString('');
        return 'string';

      default:
        this.error('Unsupported expression');
        this.emitWord(Op.PUSHI, 0);
        return 'int';
    }
  }

  private compileBinary(expr: Expr & { kind: 'binary' }): VType {
    if (expr.op === '&&' || expr.op === '||') {
      const shortCircuit = expr.op === '&&' ? Op.JZ : Op.JNZ;
      const left = this.compileExpr(expr.left);
      if (left === 'void') this.emitWord(Op.PUSHI, 0);
      const endJump = this.emitJump(shortCircuit);
      const right = this.compileExpr(expr.right);
      if (right === 'void') this.emitWord(Op.PUSHI, 0);
      const endJump2 = this.emitJump(shortCircuit);
      this.emitWord(Op.PUSHI, expr.op === '&&' ? 1 : 0);
      const done = this.emitJump(Op.JMP);
      this.patchToHere(endJump);
      this.patchToHere(endJump2);
      this.emitWord(Op.PUSHI, expr.op === '&&' ? 0 : 1);
      this.patchToHere(done);
      return 'bool';
    }

    if (expr.op === '==' || expr.op === '!=') {
      const leftType = this.compileExpr(expr.left);
      const rightType = this.compileExpr(expr.right);
      if (leftType === 'void' || rightType === 'void') {
        this.error('Cannot compare a void expression', expr.line);
      }
      this.emit(expr.op === '==' ? Op.EQ : Op.NE);
      return 'bool';
    }

    if (expr.op === '<' || expr.op === '<=' || expr.op === '>' || expr.op === '>=') {
      const leftType = this.compileExpr(expr.left);
      const rightType = this.compileExpr(expr.right);
      if (leftType === 'string' || rightType === 'string') {
        this.error(
          'String ordering is not supported on bare metal',
          expr.line,
          'Compare string lengths or characters instead.',
        );
      }
      this.emit(
        expr.op === '<' ? Op.LT : expr.op === '<=' ? Op.LE : expr.op === '>' ? Op.GT : Op.GE,
      );
      return 'bool';
    }

    const leftType = this.compileExpr(expr.left);
    const rightType = this.compileExpr(expr.right);
    if (leftType === 'void' || rightType === 'void') {
      this.error('A void expression cannot be used in arithmetic', expr.line);
      this.emitWord(Op.PUSHI, 0);
      return 'int';
    }

    if (expr.op === '+') {
      if (leftType === 'string' || rightType === 'string') {
        this.coerce(leftType, 'string', expr.line);
        this.coerce(rightType, 'string', expr.line);
        this.emit(Op.CONCAT);
        return 'string';
      }
      this.emit(Op.ADD);
      return 'int';
    }

    switch (expr.op) {
      case '-': this.emit(Op.SUB); return 'int';
      case '*': this.emit(Op.MUL); return 'int';
      case '/': this.emit(Op.DIV); return 'int';
      case '%': this.emit(Op.MOD); return 'int';
      default:
        this.error(`Operator '${expr.op}' is not supported`, expr.line);
        this.emitWord(Op.PUSHI, 0);
        return 'int';
    }
  }

  private compileAssign(expr: Expr & { kind: 'assign' }): VType {
    if (expr.target.kind === 'ident') {
      const local = this.lookupLocal(expr.target.name);
      const global = local ? undefined : this.globalByName.get(expr.target.name);
      if (!local && !global) {
        this.error(`Cannot assign to '${expr.target.name}': it is not declared`, expr.line);
        this.compileExpr(expr.value);
        return 'int';
      }
      const targetType = local ? local.type : global?.type ?? 'int';
      if (expr.op === '=') {
        const valueType = this.compileExpr(expr.value);
        this.coerce(valueType, targetType, expr.line);
      } else {
        if (local) this.emitWord(Op.LOAD, local.slot);
        else this.emitWord(Op.LOADG, global?.index ?? 0);
        const valueType = this.compileExpr(expr.value);
        const op = expr.op.slice(0, -1);
        if (op === '+' && (targetType === 'string' || valueType === 'string')) {
          this.coerce(targetType, 'string', expr.line);
          this.coerce(valueType, 'string', expr.line);
          this.emit(Op.CONCAT);
        } else {
          this.coerce(valueType, 'int', expr.line);
          if (op === '+') this.emit(Op.ADD);
          else if (op === '-') this.emit(Op.SUB);
          else if (op === '*') this.emit(Op.MUL);
          else if (op === '/') this.emit(Op.DIV);
          else if (op === '%') this.emit(Op.MOD);
          else this.error(`Assignment operator '${expr.op}' is not supported`, expr.line);
        }
      }
      this.emit(Op.DUP);
      if (local) this.emitStore(local.slot);
      else {
        this.emit(Op.STOREG);
        this.emitWord(global?.index ?? 0);
      }
      return targetType;
    }

    if (expr.target.kind === 'member' && expr.target.object.kind === 'ident') {
      const owner = expr.target.object.name;
      const field = this.globalByQualified.get(`${owner}.${expr.target.name}`);
      if (field) {
        if (expr.op === '=') {
          const valueType = this.compileExpr(expr.value);
          this.coerce(valueType, field.type, expr.line);
        } else {
          this.emitWord(Op.LOADG, field.index);
          const valueType = this.compileExpr(expr.value);
          const op = expr.op.slice(0, -1);
          if (op === '+' && (field.type === 'string' || valueType === 'string')) {
            this.coerce(field.type, 'string', expr.line);
            this.coerce(valueType, 'string', expr.line);
            this.emit(Op.CONCAT);
          } else {
            this.coerce(valueType, 'int', expr.line);
            if (op === '+') this.emit(Op.ADD);
            else if (op === '-') this.emit(Op.SUB);
            else if (op === '*') this.emit(Op.MUL);
            else if (op === '/') this.emit(Op.DIV);
            else this.emit(Op.MOD);
          }
        }
        this.emit(Op.DUP);
        this.emit(Op.STOREG);
        this.emitWord(field.index);
        return field.type;
      }
    }

    this.error('Assignment target is not a supported variable or static field', expr.line);
    this.compileExpr(expr.value);
    return 'int';
  }

  private compileCall(call: Expr & { kind: 'call' }): VType {
    const callee = call.callee;

    if (callee.kind === 'member') {
      const owner = callee.object.kind === 'ident' ? callee.object.name : '';
      if (owner === 'Console') return this.consoleCall(callee.name, call.args, call.line);
      if (owner === 'Graphics') return this.graphicsCall(callee.name, call.args, call.line);
      if (owner === 'Math') return this.mathCall(callee.name, call.args, call.line);
      if (owner === 'int' || owner === 'Int32') return this.intCall(callee.name, call.args, call.line);
      if (owner === 'string' || owner === 'String') return this.stringCall(callee.name, call.args, call.line);
      if (owner === 'Convert') return this.convertCall(callee.name, call.args, call.line);
      if (owner && this.globalByQualified.has(`${owner}.${callee.name}`)) {
        this.error(`Static field '${callee.name}' is not a method`, call.line);
      }
      if (owner && this.methodByKey.has(`${callee.name}/${call.args.length}`)) {
        return this.userCall(callee.name, call.args, call.line);
      }

      const objectType = this.compileExpr(callee.object);
      if (callee.name === 'ToString') {
        this.coerce(objectType, 'string', call.line);
        this.emit(Op.TOSTR);
        return 'string';
      }
      if (callee.name === 'ToUpper' || callee.name === 'ToLower') {
        this.coerce(objectType, 'string', call.line);
        this.emit(callee.name === 'ToUpper' ? Op.UPPER : Op.LOWER);
        return 'string';
      }
      this.error(
        `Method '${callee.name}()' is not supported on this value`,
        call.line,
        'Supported string methods: ToString, ToUpper, ToLower.',
      );
      this.emitString('');
      return 'string';
    }

    if (callee.kind === 'ident') return this.userCall(callee.name, call.args, call.line);

    this.error('Unsupported call expression', call.line);
    this.emitWord(Op.PUSHI, 0);
    return 'int';
  }

  private consoleCall(name: string, args: Expr[], line: number): VType {
    if (name === 'Clear') {
      this.emit(Op.CLEAR);
      return 'void';
    }
    if (name === 'ReadLine') {
      this.emit(Op.READLINE);
      return 'string';
    }
    if (name === 'ReadKey') {
      this.emit(Op.READKEY);
      return 'int';
    }
    if (name === 'Write' || name === 'WriteLine') {
      if (args.length === 0) {
        this.emit(Op.NEWLINE);
        return 'void';
      }
      for (let i = 0; i < args.length; i++) {
        const type = this.compileExpr(args[i]);
        if (type === 'void') {
          this.error('Cannot print a void expression', line);
          this.emitString('');
        }
        const last = i === args.length - 1;
        this.emit(last && name === 'WriteLine' ? Op.PRINTLN : Op.PRINT);
      }
      return 'void';
    }
    if (name === 'Title') return 'void';
    this.error(`Console.${name} is not supported`, line, 'Use Write, WriteLine, ReadLine, ReadKey or Clear.');
    return 'void';
  }

  private graphicsCall(name: string, args: Expr[], line: number): VType {
    if (name === 'Init' || name === 'End') {
      if (args.length !== 0) this.error(`Graphics.${name} takes no arguments`, line);
      this.emit(name === 'Init' ? Op.GINIT : Op.GEND);
      return 'void';
    }
    if (name === 'Width' || name === 'Height') {
      if (args.length !== 0) this.error(`Graphics.${name} takes no arguments`, line);
      this.emitWord(Op.PUSHI, name === 'Width' ? GRAPHICS_WIDTH : GRAPHICS_HEIGHT);
      return 'int';
    }
    if (name === 'Rgb') {
      if (args.length !== 3) {
        this.error('Graphics.Rgb expects red, green and blue (0..255)', line);
        this.emitWord(Op.PUSHI, 0);
        return 'int';
      }
      for (const arg of args) this.coerce(this.compileExpr(arg), 'int', line);
      this.emit(Op.RGB);
      return 'int';
    }

    const arity = name === 'Clear' ? 1
      : name === 'SetPixel' ? 3
      : name === 'FillRect' || name === 'Rect' || name === 'Line' ? 5
      : name === 'FillCircle' || name === 'Circle' ? 4
      : -1;
    if (arity < 0) {
      this.error(
        `Graphics.${name} is not supported`,
        line,
        'Use Init, End, Clear, SetPixel, FillRect, Rect, Line, FillCircle, Circle, Rgb, Width or Height.',
      );
      return 'void';
    }
    if (args.length !== arity) {
      this.error(`Graphics.${name} expects ${arity} argument${arity === 1 ? '' : 's'}`, line);
    }
    for (let i = 0; i < arity; i++) {
      if (args[i]) this.coerce(this.compileExpr(args[i]), 'int', line);
      else this.emitWord(Op.PUSHI, 0);
    }
    const opcode = name === 'Clear' ? Op.GCLEAR
      : name === 'SetPixel' ? Op.GPIXEL
      : name === 'FillRect' ? Op.GFILLRECT
      : name === 'Rect' ? Op.GRECT
      : name === 'Line' ? Op.GLINE
      : name === 'FillCircle' ? Op.GFILLCIRCLE
      : Op.GCIRCLE;
    this.emit(opcode);
    return 'void';
  }

  private mathCall(name: string, args: Expr[], line: number): VType {
    if (args.length !== 2 && name !== 'Abs') {
      this.error(`Math.${name} expects 2 arguments`, line);
    }
    if (name === 'Abs' || name === 'Min' || name === 'Max') {
      if (args.length === 0) {
        this.error(`Math.${name} expects an argument`, line);
        this.emitWord(Op.PUSHI, 0);
        return 'int';
      }
      this.coerce(this.compileExpr(args[0]), 'int', line);
      if (name !== 'Abs') {
        if (args[1]) this.coerce(this.compileExpr(args[1]), 'int', line);
        else this.emitWord(Op.PUSHI, 0);
        this.emit(name === 'Min' ? Op.MIN : Op.MAX);
      } else {
        this.emit(Op.ABS);
      }
      return 'int';
    }
    this.error(`Math.${name} needs floating point, which this kernel does not have`, line, 'Use int arithmetic.');
    return 'int';
  }

  private intCall(name: string, args: Expr[], line: number): VType {
    if (name === 'Parse') {
      if (args[0]) this.compileExpr(args[0]);
      else this.emitString('');
      this.emit(Op.PARSE);
      return 'int';
    }
    this.error(`int.${name} is not supported`, line);
    this.emitWord(Op.PUSHI, 0);
    return 'int';
  }

  private stringCall(name: string, args: Expr[], line: number): VType {
    if (name === 'Concat') {
      if (args.length === 0) {
        this.emitString('');
        return 'string';
      }
      let count = 0;
      for (const arg of args) {
        const type = this.compileExpr(arg);
        this.coerce(type, 'string', line);
        count++;
      }
      while (count > 1) {
        this.emit(Op.CONCAT);
        count--;
      }
      return 'string';
    }
    if (name === 'IsNullOrEmpty' || name === 'IsNullOrWhiteSpace') {
      if (args[0]) this.compileExpr(args[0]);
      else this.emitString('');
      this.emit(Op.LEN);
      this.emitWord(Op.PUSHI, 0);
      this.emit(Op.EQ);
      return 'bool';
    }
    if (name === 'Empty') {
      this.emitString('');
      return 'string';
    }
    this.error(`string.${name} is not supported`, line);
    this.emitString('');
    return 'string';
  }

  private convertCall(name: string, args: Expr[], line: number): VType {
    const type = args[0] ? this.compileExpr(args[0]) : 'int';
    if (name === 'ToInt32') {
      this.coerce(type, 'int', line);
      return 'int';
    }
    if (name === 'ToString') {
      this.coerce(type, 'string', line);
      this.emit(Op.TOSTR);
      return 'string';
    }
    if (name === 'ToBoolean') {
      this.coerce(type, 'bool', line);
      return 'bool';
    }
    this.error(`Convert.${name} is not supported`, line);
    return 'int';
  }

  private userCall(name: string, args: Expr[], line: number): VType {
    const record = this.methodByKey.get(`${name}/${args.length}`);
    if (!record) {
      const alternatives = this.methods.filter((method) => method.name === name);
      if (alternatives.length > 0) {
        this.error(
          `${name}() takes ${alternatives[0].params} argument(s), but ${args.length} were supplied`,
          line,
        );
      } else {
        this.error(`Unknown method '${name}()'`, line, 'Declare it as a static method in the file.');
      }
      this.emitWord(Op.PUSHI, 0);
      return 'int';
    }
    const declaration = flatMethods(this.program).find(
      (method) => method.name === name && method.params.length === args.length,
    );
    // Push right-to-left so arg0 ends up in the lowest frame slot.
    for (let i = args.length - 1; i >= 0; i--) {
      const valueType = this.compileExpr(args[i]);
      const paramType = declaration ? this.paramType(declaration.params[i].type) : 'int';
      this.coerce(valueType, paramType, line);
    }
    this.emit(Op.CALL);
    this.emitWord(record.index);
    this.emitWord(args.length);
    return record.returnType;
  }

  private compileMember(expr: Expr & { kind: 'member' }): VType {
    if (expr.object.kind === 'ident') {
      const field = this.globalByQualified.get(`${expr.object.name}.${expr.name}`);
      if (field) {
        this.emitWord(Op.LOADG, field.index);
        return field.type;
      }
      if ((expr.object.name === 'string' || expr.object.name === 'String') && expr.name === 'Empty') {
        this.emitString('');
        return 'string';
      }
    }
    if (expr.name === 'KeyChar' || expr.name === 'Key') {
      return this.compileExpr(expr.object);
    }
    const objectType = this.compileExpr(expr.object);
    if (expr.name === 'Length') {
      this.coerce(objectType, 'string', expr.line);
      this.emit(Op.LEN);
      return 'int';
    }
    this.error(`Member '${expr.name}' is not supported`, expr.line);
    this.emitWord(Op.PUSHI, 0);
    return 'int';
  }

  // ------------------------------------------------------------ helpers
  private emit(op: Op): void {
    this.code.push(op);
    this.instructions++;
  }

  /** With one argument: emit a data word. With two: emit an opcode followed by its word operand. */
  private emitWord(first: number, operand?: number): void {
    if (operand === undefined) {
      this.code.push(first & 0xff, (first >> 8) & 0xff);
      return;
    }
    this.emit(first as Op);
    this.code.push(operand & 0xff, (operand >> 8) & 0xff);
  }

  private emitPair(op: Op, value: number): void {
    this.emit(op);
    this.emitWord(value);
  }

  private here(): number {
    return CODE_START + this.code.length;
  }

  private emitJump(op: Op): number {
    this.emit(op);
    const pos = this.code.length;
    this.emitWord(0);
    return pos;
  }

  private patchTo(pos: number, target: number): void {
    this.code[pos] = target & 0xff;
    this.code[pos + 1] = (target >> 8) & 0xff;
  }

  private patchToHere(pos: number): void {
    this.patchTo(pos, this.here());
  }

  private emitString(value: string): void {
    let offset = this.strings.get(value);
    if (offset === undefined) {
      offset = STRING_START + this.stringData.length;
      this.strings.set(value, offset);
      const bytes: number[] = [];
      for (const ch of Array.from(value)) {
        const code = ch.codePointAt(0) ?? 0;
        bytes.push(code & 0xff);
      }
      this.stringData.push(bytes.length & 0xff, (bytes.length >> 8) & 0xff, ...bytes);
      if (this.stringData.length > MAX_STRING_BYTES) {
        this.error(
          `String data is ${this.stringData.length} bytes but the static string area is ${MAX_STRING_BYTES} bytes`,
          undefined,
          'Use shorter literals or fewer unique strings.',
        );
      }
    }
    this.emitPair(Op.PUSHS, offset);
  }

  private emitDefault(type: VType): void {
    if (type === 'string') this.emitString(DEFAULT_TEXT);
    else this.emitWord(Op.PUSHI, 0);
  }

  private emitStore(slot: number): void {
    this.emitPair(Op.STORE, slot);
  }

  private declareLocal(name: string, type: VType): number {
    const state = this.fn;
    if (!state) return 0;
    const scope = state.scopes[state.scopes.length - 1];
    if (scope.has(name)) {
      this.error(`Variable '${name}' is already declared in this scope`, undefined);
    }
    if (state.nextSlot >= 64) {
      this.error('A method may use at most 64 local slots', state.method.line);
    }
    const slot = state.nextSlot++;
    scope.set(name, { slot, type });
    return slot;
  }

  private lookupLocal(name: string): { slot: number; type: VType } | undefined {
    const state = this.fn;
    if (!state) return undefined;
    for (let i = state.scopes.length - 1; i >= 0; i--) {
      const found = state.scopes[i].get(name);
      if (found) return found;
    }
    return undefined;
  }

  private pushScope(): void {
    this.fn?.scopes.push(new Map());
  }

  private popScope(): void {
    this.fn?.scopes.pop();
  }

  private coerce(from: VType, to: VType, line: number): void {
    if (from === to) return;
    if (to === 'void') {
      this.error('A void expression cannot be used as a value', line);
      return;
    }
    if (to === 'string') {
      if (from === 'int' || from === 'bool') this.emit(Op.TOSTR);
      else if (from === 'string') return;
      else this.error('Cannot convert this expression to a string', line);
      return;
    }
    if (to === 'int') {
      if (from === 'string') this.emit(Op.PARSE);
      else if (from === 'int' || from === 'bool') return;
      else this.error('Cannot convert this expression to an int', line);
      return;
    }
    if (to === 'bool') {
      if (from === 'int' || from === 'bool') return;
      if (from === 'string') {
        this.emitString('');
        this.emit(Op.NE);
        return;
      }
    }
  }

  private error(message: string, line?: number, hint?: string): void {
    this.diagnostics.push({ severity: 'error', message, line, hint });
  }
}
