/**
 * Minimal two-pass 16-bit x86 assembler for the SharpBoot kernel.
 * Supports the instruction subset used by src/core/kernel.ts plus data directives.
 */

export interface Assembled {
  bytes: Uint8Array;
  labels: Map<string, number>;
}

type Operand =
  | { kind: 'reg8'; name: string; code: number }
  | { kind: 'reg16'; name: string; code: number }
  | { kind: 'sreg'; name: string; code: number }
  | { kind: 'imm'; expr: string }
  | { kind: 'mem'; seg?: string; base?: string; index?: string; disp: string; size?: 8 | 16 };

interface Line {
  mnemonic: string;
  operands: string[];
  raw: string;
  lineNo: number;
}

const REG8: Record<string, number> = { al: 0, cl: 1, dl: 2, bl: 3, ah: 4, ch: 5, dh: 6, bh: 7 };
const REG16: Record<string, number> = { ax: 0, cx: 1, dx: 2, bx: 3, sp: 4, bp: 5, si: 6, di: 7 };
const SREG: Record<string, number> = { es: 0, cs: 1, ss: 2, ds: 3 };

const JCC_NEAR: Record<string, number> = {
  jo: 0x80, jno: 0x81, jb: 0x82, jc: 0x82, jnae: 0x82,
  jae: 0x83, jnb: 0x83, jnc: 0x83, je: 0x84, jz: 0x84,
  jne: 0x85, jnz: 0x85, jbe: 0x86, jna: 0x86, ja: 0x87, jnbe: 0x87,
  js: 0x88, jns: 0x89, jp: 0x8a, jnp: 0x8b, jl: 0x8c, jnge: 0x8c,
  jge: 0x8d, jnl: 0x8d, jle: 0x8e, jng: 0x8e, jg: 0x8f, jnle: 0x8f,
};

const ALU_OPS: Record<string, number> = {
  add: 0, or: 1, adc: 2, sbb: 3, and: 4, sub: 5, xor: 6, cmp: 7,
};

const SHIFT_OPS: Record<string, number> = { shl: 4, sal: 4, shr: 5, sar: 7 };

function stripComment(text: string): string {
  let inString = false;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === ';') return text.slice(0, i);
  }
  return text;
}

function splitOperands(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  let inString = false;
  let quote = '';
  for (const ch of text) {
    if (inString) {
      current += ch;
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
}

function unquote(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseStringLiteral(text: string): number[] {
  const raw = unquote(text);
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    let ch = raw[i];
    if (ch === '\\') {
      const next = raw[++i];
      if (next === 'n') ch = '\n';
      else if (next === 'r') ch = '\r';
      else if (next === 't') ch = '\t';
      else if (next === '\\') ch = '\\';
      else if (next === '0') ch = '\0';
      else if (next === 'x') {
        const hex = raw.slice(i + 1, i + 3);
        i += 2;
        out.push(parseInt(hex, 16) & 0xff);
        continue;
      } else ch = next ?? '';
    }
    out.push(ch.charCodeAt(0) & 0xff);
  }
  return out;
}

function parseNumber(text: string): number {
  const trimmed = text.trim();
  if (/^0x[0-9a-f]+$/i.test(trimmed)) return parseInt(trimmed.slice(2), 16);
  if (/^\$[0-9a-f]+$/i.test(trimmed)) return parseInt(trimmed.slice(1), 16);
  if (/^-?[0-9]+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^'.'$/.test(trimmed)) return trimmed.charCodeAt(1);
  throw new Error(`Bad numeric literal '${text}'`);
}

class ExprEval {
  private text: string;
  private pos = 0;
  private labels: Map<string, number>;
  private here: number;
  private lenient: boolean;

  constructor(text: string, labels: Map<string, number>, here: number, lenient = false) {
    this.text = text;
    this.labels = labels;
    this.here = here;
    this.lenient = lenient;
  }

  evaluate(): number {
    const value = this.parseAdd();
    this.skipSpace();
    if (this.pos < this.text.length) {
      throw new Error(`Unexpected '${this.text.slice(this.pos)}' in expression '${this.text}'`);
    }
    return value;
  }

  private skipSpace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
  }

  private parseAdd(): number {
    let value = this.parseMul();
    for (;;) {
      this.skipSpace();
      const ch = this.text[this.pos];
      if (ch !== '+' && ch !== '-') break;
      this.pos++;
      const rhs = this.parseMul();
      value = ch === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  private parseMul(): number {
    let value = this.parseUnary();
    for (;;) {
      this.skipSpace();
      const ch = this.text[this.pos];
      if (ch !== '*' && ch !== '/') break;
      this.pos++;
      const rhs = this.parseUnary();
      value = ch === '*' ? value * rhs : Math.trunc(value / rhs);
    }
    return value;
  }

  private parseUnary(): number {
    this.skipSpace();
    const ch = this.text[this.pos];
    if (ch === '-') {
      this.pos++;
      return -this.parseUnary();
    }
    if (ch === '+') {
      this.pos++;
      return this.parseUnary();
    }
    if (ch === '(') {
      this.pos++;
      const value = this.parseAdd();
      this.skipSpace();
      if (this.text[this.pos] !== ')') throw new Error('Missing )');
      this.pos++;
      return value;
    }
    if (ch === '$') {
      this.pos++;
      return this.here;
    }
    if (ch === "'") {
      const end = this.text.indexOf("'", this.pos + 1);
      if (end < 0) throw new Error('Bad char literal');
      const value = this.text.charCodeAt(this.pos + 1);
      this.pos = end + 1;
      return value;
    }
    const match = /^(0x[0-9a-fA-F]+|[0-9]+|[A-Za-z_.][A-Za-z0-9_.]*)/.exec(this.text.slice(this.pos));
    if (!match) throw new Error(`Bad expression '${this.text}'`);
    this.pos += match[0].length;
    const token = match[0];
    if (/^0x/i.test(token) || /^[0-9]+$/.test(token)) return parseNumber(token);
    const value = this.labels.get(token);
    if (value === undefined) {
      if (this.lenient) return 0;
      throw new Error(`Unknown symbol '${token}'`);
    }
    return value;
  }
}

export function assemble(source: string, origin = 0): Assembled {
  const rawLines = source.split('\n');
  const lines: Line[] = [];
  const constants = new Map<string, number>();

  for (let i = 0; i < rawLines.length; i++) {
    let text = stripComment(rawLines[i]).trim();
    if (!text) continue;

    // constant: NAME equ EXPR
    const equ = /^([A-Za-z_.][\w.]*)\s+equ\s+(.+)$/i.exec(text);
    if (equ) {
      constants.set(equ[1], new ExprEval(equ[2], constants, 0).evaluate());
      continue;
    }

    // strip leading labels
    let label: string | null = null;
    const labelMatch = /^([A-Za-z_.][\w.]*):\s*(.*)$/.exec(text);
    if (labelMatch) {
      label = labelMatch[1];
      text = labelMatch[2];
      lines.push({ mnemonic: '__label', operands: [label], raw: '', lineNo: i + 1 });
      if (!text) continue;
    }

    const parts = text.split(/\s+/);
    const mnemonic = parts[0].toLowerCase();
    const rest = text.slice(parts[0].length).trim();
    lines.push({
      mnemonic,
      operands: rest ? splitOperands(rest) : [],
      raw: rest,
      lineNo: i + 1,
    });
  }

  // Pass 1: compute addresses/sizes.
  const labels = new Map<string, number>(constants);
  let pc = origin;
  const sizes: number[] = [];

  const parseOperand = (text: string): Operand => {
    let raw = text.trim();
    let size: 8 | 16 | undefined;
    if (/^byte\s+/i.test(raw)) {
      size = 8;
      raw = raw.replace(/^byte\s+/i, '');
    } else if (/^word\s+/i.test(raw)) {
      size = 16;
      raw = raw.replace(/^word\s+/i, '');
    }
    const lower = raw.toLowerCase();
    if (REG8[lower] !== undefined) return { kind: 'reg8', name: lower, code: REG8[lower] };
    if (REG16[lower] !== undefined) return { kind: 'reg16', name: lower, code: REG16[lower] };
    if (SREG[lower] !== undefined) return { kind: 'sreg', name: lower, code: SREG[lower] };
    if (raw.startsWith('[') && raw.endsWith(']')) {
      let inner = raw.slice(1, -1).trim();
      let seg: string | undefined;
      const segMatch = /^(es|ds|ss|cs)\s*:\s*/i.exec(inner);
      if (segMatch) {
        seg = segMatch[1].toLowerCase();
        inner = inner.slice(segMatch[0].length);
      }
      let base: string | undefined;
      let index: string | undefined;
      let disp = '0';
      const terms = inner.replace(/-/g, '+-').split('+').map((t) => t.trim()).filter(Boolean);
      const dispParts: string[] = [];
      for (const term of terms) {
        const t = term.toLowerCase();
        if (t === 'bx' || t === 'bp') base = t;
        else if (t === 'si' || t === 'di') index = t;
        else if (t.startsWith('-')) dispParts.push(term);
        else dispParts.push(term);
      }
      if (dispParts.length > 0) disp = dispParts.join('+').replace(/\+-/g, '-');
      return { kind: 'mem', seg, base, index, disp, size };
    }
    return { kind: 'imm', expr: raw };
  };

  let lenientEval = false;
  const evalExpr = (text: string, labelMap: Map<string, number>, here: number): number =>
    new ExprEval(text, labelMap, here, lenientEval).evaluate();

  const encode = (
    mnemonic: string,
    operandTexts: string[],
    labelMap: Map<string, number>,
    address: number,
    emit: (bytes: number[]) => void,
    lenient = false,
  ): void => {
    lenientEval = lenient;
    const out: number[] = [];
    const push = (...bytes: number[]): void => {
      for (const byte of bytes) out.push(byte & 0xff);
    };
    const operands = operandTexts.map(parseOperand);
    const m = mnemonic;
    const here = address;

    const rmReg = (regField: number, operand: Operand, _word: boolean): void => {
      if (operand.kind === 'reg8' || operand.kind === 'reg16') {
        push(0xc0 | (regField << 3) | operand.code);
        return;
      }
      if (operand.kind !== 'mem') throw new Error(`Expected register or memory for '${mnemonic}'`);
      if (operand.seg) throw new Error('Segment overrides are not supported');
      let mod = 0;
      let rm = 0;
      let dispBytes = 0;
      let disp = 0;
      if (!operand.base && !operand.index) {
        mod = 0;
        rm = 6;
        disp = evalExpr(operand.disp, labelMap, here);
        dispBytes = 2;
      } else {
        const base = operand.base;
        const index = operand.index;
        if (base === 'bx' && index === 'si') rm = 0;
        else if (base === 'bx' && index === 'di') rm = 1;
        else if (base === 'bp' && index === 'si') rm = 2;
        else if (base === 'bp' && index === 'di') rm = 3;
        else if (!base && index === 'si') rm = 4;
        else if (!base && index === 'di') rm = 5;
        else if (base === 'bx' && !index) rm = 7;
        else throw new Error(`Unsupported addressing mode '${operandTexts.join(', ')}'`);
        disp = evalExpr(operand.disp, labelMap, here);
        // Always use a 16-bit displacement: pass 1 cannot know forward label
        // values, and a variable-size encoding would shift every later label.
        mod = 2;
        dispBytes = 2;
      }
      push((mod << 6) | (regField << 3) | rm);
      if (dispBytes === 1) push(disp);
      if (dispBytes === 2) {
        push(disp);
        push(disp >> 8);
      }
    };

    const imm16 = (expr: string): void => {
      const value = evalExpr(expr, labelMap, here);
      push(value);
      push(value >> 8);
    };
    const imm8 = (expr: string): void => {
      push(evalExpr(expr, labelMap, here));
    };

    switch (m) {
      case 'db': {
        for (const text of operandTexts) {
          if (/^["']/.test(text.trim())) {
            push(...parseStringLiteral(text));
          } else {
            push(evalExpr(text, labelMap, here));
          }
        }
        break;
      }
      case 'dw': {
        for (const text of operandTexts) {
          const value = evalExpr(text, labelMap, here);
          push(value);
          push(value >> 8);
        }
        break;
      }
      case 'msg': {
        const bytes = parseStringLiteral(operandTexts[0] ?? '""');
        push(bytes.length);
        push(bytes.length >> 8);
        for (const byte of bytes) push(byte);
        break;
      }
      case 'resb': {
        const count = evalExpr(operandTexts[0] ?? '0', labelMap, here);
        for (let i = 0; i < count; i++) push(0);
        break;
      }
      case 'resw': {
        const count = evalExpr(operandTexts[0] ?? '0', labelMap, here);
        for (let i = 0; i < count * 2; i++) push(0);
        break;
      }
      case 'mov': {
        const dst = operands[0];
        const src = operands[1];
        if (!dst || !src) throw new Error('mov needs two operands');
        if (dst.kind === 'sreg' && src.kind === 'reg16') {
          push(0x8e, 0xc0 | (dst.code << 3) | src.code);
          break;
        }
        if (dst.kind === 'reg16' && src.kind === 'sreg') {
          push(0x8c, 0xc0 | (src.code << 3) | dst.code);
          break;
        }
        if (dst.kind === 'mem' && src.kind === 'sreg') {
          push(0x8e);
          rmReg(src.code, dst, true);
          break;
        }
        if (dst.kind === 'reg16' && src.kind === 'mem' && src.seg) {
          // handled by rmReg below
        }
        const word =
          dst.kind === 'reg16' || src.kind === 'reg16' ||
          (dst.kind === 'mem' && dst.size === 16) || (src.kind === 'mem' && src.size === 16);
        if (dst.kind === 'reg8' || dst.kind === 'reg16') {
          if (src.kind === 'reg8' || src.kind === 'reg16') {
            push(word ? 0x89 : 0x88);
            push(0xc0 | (src.code << 3) | dst.code);
          } else if (src.kind === 'imm') {
            if (word) push(0xb8 | dst.code);
            else push(0xb0 | dst.code);
            if (word) imm16(src.expr);
            else imm8(src.expr);
          } else if (src.kind === 'mem') {
            push(word ? 0x8b : 0x8a);
            rmReg(dst.code, src, word);
          } else {
            throw new Error('Unsupported mov operands');
          }
        } else if (dst.kind === 'mem') {
          if (src.kind === 'reg8' || src.kind === 'reg16') {
            push(word ? 0x89 : 0x88);
            rmReg(src.code, dst, word);
          } else if (src.kind === 'imm') {
            push(word ? 0xc7 : 0xc6);
            rmReg(0, dst, word);
            if (word) imm16(src.expr);
            else imm8(src.expr);
          } else {
            throw new Error('Unsupported mov operands');
          }
        } else {
          throw new Error('Unsupported mov operands');
        }
        break;
      }
      case 'add':
      case 'or':
      case 'adc':
      case 'sbb':
      case 'and':
      case 'sub':
      case 'xor':
      case 'cmp': {
        const op = ALU_OPS[m];
        const dst = operands[0];
        const src = operands[1];
        const word =
          dst.kind === 'reg16' || src.kind === 'reg16' ||
          (dst.kind === 'mem' && dst.size === 16) || (src.kind === 'mem' && src.size === 16);
        if (src.kind === 'imm') {
          if (word) push(0x81);
          else push(0x80);
          rmReg(op, dst, word);
          if (word) imm16(src.expr);
          else imm8(src.expr);
        } else if (dst.kind === 'reg8' || dst.kind === 'reg16') {
          if (src.kind !== 'reg8' && src.kind !== 'reg16' && src.kind !== 'mem') throw new Error('Bad ALU operand');
          push(op * 8 + (word ? 3 : 2));
          rmReg(dst.code, src, word);
        } else if (dst.kind === 'mem') {
          if (src.kind !== 'reg8' && src.kind !== 'reg16') throw new Error('Bad ALU operand');
          push(op * 8 + (word ? 1 : 0));
          rmReg(src.code, dst, word);
        } else {
          throw new Error('Bad ALU operands');
        }
        break;
      }
      case 'test': {
        const dst = operands[0];
        const src = operands[1];
        if (src.kind === 'imm') {
          const word = dst.kind === 'reg16' || (dst.kind === 'mem' && dst.size === 16);
          push(word ? 0xf7 : 0xf6);
          rmReg(0, dst, word);
          if (word) imm16(src.expr);
          else imm8(src.expr);
        } else {
          const word = dst.kind === 'reg16' || src.kind === 'reg16';
          push(word ? 0x85 : 0x84);
          rmReg((src as { code: number }).code, dst, word);
        }
        break;
      }
      case 'inc':
      case 'dec': {
        const dst = operands[0];
        const isInc = m === 'inc';
        if (dst.kind === 'reg16') {
          push((isInc ? 0x40 : 0x48) + dst.code);
        } else if (dst.kind === 'reg8') {
          push(0xfe, 0xc0 | ((isInc ? 0 : 1) << 3) | dst.code);
        } else {
          push(0xff);
          rmReg(isInc ? 0 : 1, dst, true);
        }
        break;
      }
      case 'push': {
        const src = operands[0];
        if (src.kind === 'reg16') push(0x50 + src.code);
        else if (src.kind === 'sreg') push(0x06 | (src.code << 3));
        else if (src.kind === 'imm') {
          push(0x68);
          imm16(src.expr);
        } else if (src.kind === 'mem') {
          push(0xff);
          rmReg(6, src, true);
        } else throw new Error('Bad push operand');
        break;
      }
      case 'pop': {
        const dst = operands[0];
        if (dst.kind === 'reg16') push(0x58 + dst.code);
        else if (dst.kind === 'sreg') push(0x07 | (dst.code << 3));
        else throw new Error('Bad pop operand');
        break;
      }
      case 'neg':
      case 'not': {
        const dst = operands[0];
        push(0xf7);
        rmReg(m === 'neg' ? 3 : 2, dst, true);
        break;
      }
      case 'imul':
      case 'mul':
      case 'idiv':
      case 'div': {
        const dst = operands[0];
        const group = m === 'imul' ? 5 : m === 'mul' ? 4 : m === 'idiv' ? 7 : 6;
        push(0xf7);
        rmReg(group, dst, true);
        break;
      }
      case 'shl':
      case 'sal':
      case 'shr':
      case 'sar': {
        const dst = operands[0];
        const amount = operands[1];
        const group = SHIFT_OPS[m];
        const word = dst.kind === 'reg16' || (dst.kind === 'mem' && dst.size === 16);
        if (amount && amount.kind === 'reg8' && amount.name === 'cl') {
          push(word ? 0xd3 : 0xd2);
          rmReg(group, dst, word);
        } else if (amount && amount.kind === 'imm' && evalExpr(amount.expr, labelMap, here) === 1) {
          push(word ? 0xd1 : 0xd0);
          rmReg(group, dst, word);
        } else if (amount && amount.kind === 'imm') {
          push(word ? 0xc1 : 0xc0);
          rmReg(group, dst, word);
          imm8(amount.expr);
        } else {
          throw new Error('Bad shift amount');
        }
        break;
      }
      case 'cwd': push(0x99); break;
      case 'cbw': push(0x98); break;
      case 'cli': push(0xfa); break;
      case 'sti': push(0xfb); break;
      case 'cld': push(0xfc); break;
      case 'std': push(0xfd); break;
      case 'hlt': push(0xf4); break;
      case 'nop': push(0x90); break;
      case 'iret': push(0xcf); break;
      case 'movsb': push(0xa4); break;
      case 'movsw': push(0xa5); break;
      case 'stosb': push(0xaa); break;
      case 'stosw': push(0xab); break;
      case 'lodsb': push(0xac); break;
      case 'lodsw': push(0xad); break;
      case 'rep': {
        const next = operandTexts[0]?.toLowerCase();
        if (next === 'movsb') push(0xf3, 0xa4);
        else if (next === 'movsw') push(0xf3, 0xa5);
        else if (next === 'stosb') push(0xf3, 0xaa);
        else if (next === 'stosw') push(0xf3, 0xab);
        else if (next === 'lodsb') push(0xf3, 0xac);
        else if (next === 'lodsw') push(0xf3, 0xad);
        else throw new Error(`Unsupported rep target '${next}'`);
        break;
      }
      case 'int': push(0xcd); imm8(operands[0].kind === 'imm' ? operands[0].expr : '0'); break;
      case 'ret': push(0xc3); break;
      case 'jmp': {
        const target = operands[0];
        if (target.kind === 'mem') {
          push(0xff);
          rmReg(4, target, true);
        } else if (target.kind === 'imm') {
          push(0xe9);
          const value = evalExpr(target.expr, labelMap, here) - (here + 3);
          push(value);
          push(value >> 8);
        } else throw new Error('Bad jmp operand');
        break;
      }
      case 'call': {
        const target = operands[0];
        if (target.kind !== 'imm') throw new Error('Bad call operand');
        push(0xe8);
        const value = evalExpr(target.expr, labelMap, here) - (here + 3);
        push(value);
        push(value >> 8);
        break;
      }
      default: {
        if (JCC_NEAR[m] !== undefined) {
          const target = operands[0];
          if (!target || target.kind !== 'imm') throw new Error('Bad jump target');
          push(0x0f, JCC_NEAR[m]);
          const value = evalExpr(target.expr, labelMap, here) - (here + 4);
          push(value);
          push(value >> 8);
          break;
        }
        throw new Error(`Unknown instruction '${mnemonic}'`);
      }
    }

    emit(out);
  };

  // Pass 1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.mnemonic === '__label') {
      labels.set(line.operands[0], pc);
      sizes.push(0);
      continue;
    }
    if (line.mnemonic === 'org') continue;
    encode(line.mnemonic, line.operands, labels, pc, (bytes) => {
      sizes.push(bytes.length);
      pc += bytes.length;
    }, true);
  }

  // Pass 2
  const bytes: number[] = [];
  pc = origin;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.mnemonic === '__label' || line.mnemonic === 'org') continue;
    encode(line.mnemonic, line.operands, labels, pc, (chunk) => {
      for (const byte of chunk) bytes.push(byte);
      pc += chunk.length;
    });
  }

  return { bytes: Uint8Array.from(bytes), labels };
}
