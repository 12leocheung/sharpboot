/** TypeScript twin of the 16-bit kernel: runs SharpBoot bytecode for the live preview. */

import { CODE_START, STRING_START } from './kernel.ts';
import type { CompiledProgram } from './compiler.ts';
import { Op } from './compiler.ts';
import {
  FONT_8X8,
  GRAPHICS_HEIGHT,
  GRAPHICS_PIXELS,
  GRAPHICS_WIDTH,
  palettePresetColor,
  rgbIndex,
  spriteColor,
} from './graphics.ts';

export type VmState = 'running' | 'waiting-line' | 'waiting-key' | 'halted' | 'error';

export interface VmCell {
  ch: string;
  attr: number;
}

interface ArrayVal {
  kind: 'int' | 'string' | 'bool';
  items: Val[];
}

type Val =
  | { t: 0; v: number }
  | { t: 1; v: string }
  | { t: 2; v: number }
  | { t: 3; v: ArrayVal };

interface Frame {
  returnPc: number;
  callerBp: number;
  spEnd: number;
}

const int = (value: number): Val => ({ t: 0, v: int16(value) });
const bool = (value: boolean): Val => ({ t: 2, v: value ? 1 : 0 });
const str = (value: string): Val => ({ t: 1, v: value });

function int16(value: number): number {
  const wrapped = ((value + 32768) % 65536 + 65536) % 65536 - 32768;
  return wrapped | 0;
}

function toNum(value: Val): number {
  if (value.t === 1) {
    const parsed = parseIntString(value.v);
    return parsed ?? 0;
  }
  if (value.t === 3) return 0;
  return value.v | 0;
}

function toStr(value: Val): string {
  if (value.t === 1) return value.v;
  if (value.t === 2) return value.v !== 0 ? 'True' : 'False';
  if (value.t === 3) return `System.${value.v.kind === 'int' ? 'Int32' : value.v.kind === 'bool' ? 'Boolean' : 'String'}[]`;
  return String(value.v | 0);
}

function truthy(value: Val): boolean {
  if (value.t === 1) return value.v.length > 0;
  if (value.t === 3) return value.v.items.length > 0;
  return value.v !== 0;
}

function parseIntString(text: string): number | null {
  let i = 0;
  while (i < text.length && text[i] === ' ') i++;
  let sign = 1;
  if (text[i] === '+' || text[i] === '-') {
    if (text[i] === '-') sign = -1;
    i++;
  }
  let value = 0;
  let digits = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) break;
    value = int16(value * 10 + (code - 48));
    digits++;
    i++;
  }
  if (digits === 0) return null;
  return int16(value * sign);
}

const CP437_ATTR = { normal: 0x0f, warn: 0x0e, dim: 0x08 };

class VmScreen {
  chars = new Array<string>(80 * 25).fill(' ');
  attrs = new Uint8Array(80 * 25).fill(CP437_ATTR.normal);
  row = 0;
  col = 0;

  clear(): void {
    this.chars.fill(' ');
    this.attrs.fill(CP437_ATTR.normal);
    this.row = 0;
    this.col = 0;
  }

  private scroll(): void {
    this.chars.splice(0, 80);
    this.chars.push(...new Array<string>(80).fill(' '));
    this.attrs.copyWithin(0, 80);
    this.attrs.fill(CP437_ATTR.normal, (25 - 1) * 80);
    this.chars.length = 80 * 25;
  }

  private newline(): void {
    this.col = 0;
    this.row++;
    if (this.row >= 25) {
      this.scroll();
      this.row = 24;
    }
  }

  putChar(ch: string, attr = CP437_ATTR.normal): void {
    if (ch === '\n') {
      this.newline();
      return;
    }
    if (ch === '\r') {
      this.col = 0;
      return;
    }
    if (ch === '\b') {
      if (this.col > 0) this.col--;
      const i = this.row * 80 + this.col;
      this.chars[i] = ' ';
      this.attrs[i] = attr;
      return;
    }
    const code = ch.charCodeAt(0);
    const out = code >= 32 && code < 127 ? ch : code === 9 ? ' ' : '?';
    const i = this.row * 80 + this.col;
    this.chars[i] = out;
    this.attrs[i] = attr;
    this.col++;
    if (this.col >= 80) this.newline();
  }

  write(text: string, attr = CP437_ATTR.normal): void {
    for (const ch of text) this.putChar(ch, attr);
  }

  cells(): VmCell[] {
    const out: VmCell[] = new Array(80 * 25);
    for (let i = 0; i < 80 * 25; i++) out[i] = { ch: this.chars[i], attr: this.attrs[i] };
    return out;
  }
}

export class BytecodeVm {
  private program: CompiledProgram;
  private code: Uint8Array;
  private methods: CompiledProgram['methods'];
  private globals: Val[];
  private stringByOffset = new Map<number, string>();

  private screen = new VmScreen();
  private gfxMode = false;
  private gfx = new Uint8Array(GRAPHICS_PIXELS);
  private back = new Uint8Array(GRAPHICS_PIXELS);
  private buffered = false;
  private fontBytes: number[] = FONT_8X8.slice();
  private paletteBytes = new Uint8Array(256 * 3);
  private slots: Val[] = [];
  private bp = 1024;
  private sp = 1024;
  private pc = 0;
  private frames: Frame[] = [];

  private lineQueue: string[] = [];
  private keyQueue: string[] = [];

  state: VmState = 'running';
  errorMessage = '';
  steps = 0;
  totalSteps = 0;

  constructor(program: CompiledProgram) {
    this.program = program;
    this.code = program.code;
    this.methods = program.methods;
    this.globals = Array.from({ length: program.globalCount }, () => int(0));
    this.readStrings();

    for (let i = 0; i < 4096; i++) this.slots.push(int(0));
    this.resetPalette();

    this.writeText('\nSharpBoot 2.0 / 16-bit C# runtime\n\n');

    const entry = program.methods[program.entryIndex];
    if (!entry) {
      this.fail('No entry method in the compiled program');
      return;
    }
    this.bp = 1024;
    this.sp = 1024;
    for (let i = 0; i < entry.locals; i++) this.slots[this.bp + i] = int(0);
    this.pc = entry.codeOffset;
  }

  screenCells(): VmCell[] {
    return this.screen.cells();
  }

  graphicsActive(): boolean {
    return this.gfxMode;
  }

  graphicsPixels(): Uint8Array {
    return this.gfx.slice();
  }

  palette(): Uint8Array {
    return this.paletteBytes;
  }

  private resetPalette(preset = 0): void {
    for (let index = 0; index < 256; index++) {
      const [red, green, blue] = palettePresetColor(preset, index);
      this.paletteBytes[index * 3] = red;
      this.paletteBytes[index * 3 + 1] = green;
      this.paletteBytes[index * 3 + 2] = blue;
    }
  }

  private gfxText(x: number, y: number, text: string, color: number): void {
    // Font data is a custom 95-glyph table or the built-in ASCII 32..126 table.
    let cx = x;
    let cy = y;
    for (const raw of text) {
      if (raw === '\n') {
        cx = x;
        cy += 8;
        continue;
      }
      if (raw === '\r') continue;
      let code = raw.charCodeAt(0);
      if (code < 32 || code > 126) code = 63;
      const glyph = (code - 32) * 8;
      for (let row = 0; row < 8; row++) {
        const bits = this.fontBytes[glyph + row] ?? 0;
        for (let bit = 0; bit < 8; bit++) {
          if (bits & (0x80 >> bit)) this.gfxPixel(cx + bit, cy + row, color);
        }
      }
      cx += 8;
    }
  }

  private gfxSprite(x: number, y: number, data: string, width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const ch = data.charAt(row * width + col);
        if (!ch) return;
        const color = spriteColor(ch);
        if (color >= 0) this.gfxPixel(x + col, y + row, color);
      }
    }
  }

  private gfxSpriteScale(x: number, y: number, data: string, width: number, height: number, scale: number): void {
    if (width <= 0 || height <= 0 || scale <= 0 || scale > 8) return;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const ch = data.charAt(row * width + col);
        if (!ch) return;
        const color = spriteColor(ch);
        if (color < 0) continue;
        for (let ry = 0; ry < scale; ry++) {
          for (let rx = 0; rx < scale; rx++) {
            this.gfxPixel(x + col * scale + rx, y + row * scale + ry, color);
          }
        }
      }
    }
  }

  private gfxSpriteRotate(x: number, y: number, data: string, width: number, height: number, rotation: number): void {
    if (width <= 0 || height <= 0) return;
    const turn = ((rotation % 4) + 4) % 4;
    if (turn === 0) {
      this.gfxSprite(x, y, data, width, height);
      return;
    }
    const dw = turn % 2 === 1 ? height : width;
    const dh = turn % 2 === 1 ? width : height;
    for (let dy = 0; dy < dh; dy++) {
      for (let dx = 0; dx < dw; dx++) {
        let sx = 0;
        let sy = 0;
        if (turn === 1) {
          sx = dy;
          sy = height - 1 - dx;
        } else if (turn === 2) {
          sx = width - 1 - dx;
          sy = height - 1 - dy;
        } else {
          sx = width - 1 - dy;
          sy = dx;
        }
        const index = sy * width + sx;
        if (index < 0 || index >= data.length) continue;
        const color = spriteColor(data.charAt(index));
        if (color >= 0) this.gfxPixel(x + dx, y + dy, color);
      }
    }
  }

  private writeText(text: string, attr = CP437_ATTR.normal): void {
    if (!this.gfxMode) this.screen.write(text, attr);
  }

  private gfxEnsure(): void {
    if (this.gfxMode) return;
    this.gfxMode = true;
    this.gfx.fill(0);
  }

  private gfxClear(color: number): void {
    (this.buffered ? this.back : this.gfx).fill(color & 0xff);
  }

  private gfxPixel(x: number, y: number, color: number): void {
    if (x < 0 || x >= GRAPHICS_WIDTH || y < 0 || y >= GRAPHICS_HEIGHT) return;
    const target = this.buffered ? this.back : this.gfx;
    target[y * GRAPHICS_WIDTH + x] = color & 0xff;
  }

  private gfxHLine(x: number, y: number, w: number, color: number): void {
    if (w <= 0 || y < 0 || y >= GRAPHICS_HEIGHT) return;
    if (x < 0) {
      w += x;
      x = 0;
    }
    if (w <= 0 || x >= GRAPHICS_WIDTH) return;
    if (x + w > GRAPHICS_WIDTH) w = GRAPHICS_WIDTH - x;
    this.gfx.fill(color & 0xff, y * GRAPHICS_WIDTH + x, y * GRAPHICS_WIDTH + x + w);
  }

  private gfxVLine(x: number, y: number, h: number, color: number): void {
    if (h <= 0 || x < 0 || x >= GRAPHICS_WIDTH) return;
    if (y < 0) {
      h += y;
      y = 0;
    }
    if (h <= 0 || y >= GRAPHICS_HEIGHT) return;
    if (y + h > GRAPHICS_HEIGHT) h = GRAPHICS_HEIGHT - y;
    for (let row = 0; row < h; row++) {
      this.gfx[(y + row) * GRAPHICS_WIDTH + x] = color & 0xff;
    }
  }

  private gfxFillRect(x: number, y: number, w: number, h: number, color: number): void {
    if (h <= 0) return;
    if (y < 0) {
      h += y;
      y = 0;
    }
    if (h <= 0 || y >= GRAPHICS_HEIGHT) return;
    if (y + h > GRAPHICS_HEIGHT) h = GRAPHICS_HEIGHT - y;
    for (let row = 0; row < h; row++) this.gfxHLine(x, y + row, w, color);
  }

  private gfxRect(x: number, y: number, w: number, h: number, color: number): void {
    if (w <= 0 || h <= 0) return;
    this.gfxHLine(x, y, w, color);
    this.gfxHLine(x, y + h - 1, w, color);
    this.gfxVLine(x, y, h, color);
    this.gfxVLine(x + w - 1, y, h, color);
  }

  private gfxLine(x1: number, y1: number, x2: number, y2: number, color: number): void {
    const dx = Math.abs(x2 - x1);
    const sx = x1 < x2 ? 1 : -1;
    const dy = -Math.abs(y2 - y1);
    const sy = y1 < y2 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.gfxPixel(x1, y1, color);
      if (x1 === x2 && y1 === y2) return;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x1 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y1 += sy;
      }
    }
  }

  private gfxPlot8(cx: number, cy: number, x: number, y: number, color: number): void {
    this.gfxPixel(cx + x, cy + y, color);
    this.gfxPixel(cx + x, cy - y, color);
    this.gfxPixel(cx - x, cy + y, color);
    this.gfxPixel(cx - x, cy - y, color);
    this.gfxPixel(cx + y, cy + x, color);
    this.gfxPixel(cx + y, cy - x, color);
    this.gfxPixel(cx - y, cy + x, color);
    this.gfxPixel(cx - y, cy - x, color);
  }

  private gfxCircle(cx: number, cy: number, r: number, color: number): void {
    if (r < 0) return;
    let x = r;
    let y = 0;
    let err = 1 - r;
    while (x >= y) {
      this.gfxPlot8(cx, cy, x, y, color);
      y++;
      if (err < 0) {
        err += 2 * y + 1;
      } else {
        x--;
        err += 2 * (y - x) + 1;
      }
    }
  }

  private gfxFillCircle(cx: number, cy: number, r: number, color: number): void {
    if (r < 0) return;
    let x = r;
    let y = 0;
    let err = 1 - r;
    while (x >= y) {
      this.gfxHLine(cx - x, cy + y, 2 * x + 1, color);
      this.gfxHLine(cx - x, cy - y, 2 * x + 1, color);
      this.gfxHLine(cx - y, cy + x, 2 * y + 1, color);
      this.gfxHLine(cx - y, cy - x, 2 * y + 1, color);
      y++;
      if (err < 0) {
        err += 2 * y + 1;
      } else {
        x--;
        err += 2 * (y - x) + 1;
      }
    }
  }

  feedLine(text: string): void {
    this.lineQueue.push(text);
  }

  feedKey(ch: string): void {
    this.keyQueue.push(ch);
  }

  run(maxSteps = 400_000): VmState {
    if (this.state === 'halted' || this.state === 'error') return this.state;
    this.state = 'running';
    const budget = this.totalSteps + maxSteps;
    while (this.state === 'running') {
      if (this.totalSteps++ > budget) {
        this.writeText('\n[runtime paused after 400,000 VM steps]\n', CP437_ATTR.warn);
        this.state = 'error';
        this.errorMessage = 'step budget exceeded (possible endless loop)';
        return this.state;
      }
      this.execute();
    }
    return this.state;
  }

  private readStrings(): void {
    let cursor = 0;
    while (cursor + 2 <= this.program.strings.length) {
      const length = this.program.strings[cursor] | (this.program.strings[cursor + 1] << 8);
      const start = cursor + 2;
      let text = '';
      for (let i = 0; i < length && start + i < this.program.strings.length; i++) {
        text += String.fromCharCode(this.program.strings[start + i]);
      }
      this.stringByOffset.set(STRING_START + cursor, text);
      cursor = start + length;
    }
  }

  private fail(message: string): void {
    this.state = 'error';
    this.errorMessage = message;
    this.writeText(`\n[fatal] ${message}\n`, CP437_ATTR.warn);
  }

  private warn(text: string): void {
    this.writeText(`\n[repair] ${text}\n`, CP437_ATTR.warn);
  }

  private push(value: Val): void {
    if (this.sp <= 0) {
      this.fail('VM stack overflow');
      return;
    }
    this.slots[--this.sp] = value;
  }

  private pop(): Val {
    if (this.sp >= this.slots.length) {
      this.fail('VM stack underflow');
      return int(0);
    }
    return this.slots[this.sp++] ?? int(0);
  }

  private fetch8(): number {
    if (this.pc < CODE_START || this.pc >= CODE_START + this.code.length) {
      this.fail('bytecode overrun');
      return 0;
    }
    return this.code[this.pc++ - CODE_START];
  }

  private fetch16(): number {
    const lo = this.fetch8();
    const hi = this.fetch8();
    return lo | (hi << 8);
  }

  private execute(): void {
    const opcode = this.fetch8();
    if (this.state !== 'running') return;

    switch (opcode) {
      case Op.HALT:
        this.writeText('\n[program halted]', CP437_ATTR.dim);
        this.state = 'halted';
        return;

      case Op.PUSHI:
        this.push(int(this.fetch16()));
        return;
      case Op.PUSHS: {
        const offset = this.fetch16();
        this.push(str(this.stringByOffset.get(offset) ?? ''));
        return;
      }
      case Op.LOAD: {
        const slot = this.fetch16();
        this.push(this.slots[this.bp + slot] ?? int(0));
        return;
      }
      case Op.STORE: {
        const slot = this.fetch16();
        this.slots[this.bp + slot] = this.pop();
        return;
      }
      case Op.LOADG: {
        const index = this.fetch16();
        this.push(this.globals[index] ?? int(0));
        return;
      }
      case Op.STOREG: {
        const index = this.fetch16();
        this.globals[index] = this.pop();
        return;
      }
      case Op.DUP: {
        const value = this.pop();
        this.push(value);
        this.push(value);
        return;
      }
      case Op.POP:
        this.pop();
        return;

      case Op.ADD: {
        const b = this.pop();
        const a = this.pop();
        if (a.t === 1 || b.t === 1) {
          this.push(str(toStr(a) + toStr(b)));
        } else {
          this.push(int(toNum(a) + toNum(b)));
        }
        return;
      }
      case Op.SUB: {
        const b = this.pop();
        const a = this.pop();
        this.push(int(toNum(a) - toNum(b)));
        return;
      }
      case Op.MUL: {
        const b = this.pop();
        const a = this.pop();
        this.push(int(toNum(a) * toNum(b)));
        return;
      }
      case Op.DIV: {
        const b = this.pop();
        const a = this.pop();
        if (toNum(b) === 0) {
          this.warn('division by zero -> 0');
          this.push(int(0));
        } else {
          this.push(int(Math.trunc(toNum(a) / toNum(b))));
        }
        return;
      }
      case Op.MOD: {
        const b = this.pop();
        const a = this.pop();
        if (toNum(b) === 0) {
          this.warn('modulo by zero -> 0');
          this.push(int(0));
        } else {
          this.push(int(toNum(a) % toNum(b)));
        }
        return;
      }
      case Op.NEG:
        this.push(int(-toNum(this.pop())));
        return;

      case Op.EQ:
      case Op.NE: {
        const b = this.pop();
        const a = this.pop();
        let equal: boolean;
        if (a.t === 3 || b.t === 3) equal = a.t === 3 && b.t === 3 && a.v === b.v;
        else if (a.t === 1 || b.t === 1) equal = toStr(a) === toStr(b);
        else equal = toNum(a) === toNum(b);
        this.push(bool(opcode === Op.EQ ? equal : !equal));
        return;
      }
      case Op.LT:
      case Op.LE:
      case Op.GT:
      case Op.GE: {
        const b = this.pop();
        const a = this.pop();
        if (a.t === 1 || b.t === 1) {
          this.warn('string ordering is unsupported -> false');
          this.push(bool(false));
          return;
        }
        const x = toNum(a);
        const y = toNum(b);
        this.push(bool(
          opcode === Op.LT ? x < y
            : opcode === Op.LE ? x <= y
            : opcode === Op.GT ? x > y
            : x >= y,
        ));
        return;
      }
      case Op.AND: {
        const b = this.pop();
        const a = this.pop();
        this.push(bool(truthy(a) && truthy(b)));
        return;
      }
      case Op.OR: {
        const b = this.pop();
        const a = this.pop();
        this.push(bool(truthy(a) || truthy(b)));
        return;
      }
      case Op.NOT:
        this.push(bool(!truthy(this.pop())));
        return;

      case Op.CONCAT: {
        const b = this.pop();
        const a = this.pop();
        this.push(str(toStr(a) + toStr(b)));
        return;
      }

      case Op.PRINT: {
        const value = this.pop();
        this.writeText(toStr(value));
        return;
      }
      case Op.PRINTLN: {
        const value = this.pop();
        this.writeText(toStr(value));
        this.writeText('\n');
        return;
      }
      case Op.NEWLINE:
        this.writeText('\n');
        return;
      case Op.CLEAR:
        this.screen.clear();
        return;

      case Op.JMP:
        this.pc = this.fetch16();
        return;
      case Op.JZ: {
        const target = this.fetch16();
        if (!truthy(this.pop())) this.pc = target;
        return;
      }
      case Op.JNZ: {
        const target = this.fetch16();
        if (truthy(this.pop())) this.pc = target;
        return;
      }

      case Op.CALL: {
        const index = this.fetch16();
        const argc = this.fetch16();
        const method = this.methods[index];
        if (!method) {
          this.fail('bad method index');
          return;
        }
        const oldSp = this.sp;
        const newBp = oldSp - method.locals;
        if (newBp < 0) {
          this.fail('VM stack overflow');
          return;
        }
        for (let i = 0; i < argc; i++) this.slots[newBp + i] = this.slots[oldSp + i] ?? int(0);
        for (let i = argc; i < method.locals; i++) this.slots[newBp + i] = int(0);
        this.frames.push({ returnPc: this.pc, callerBp: this.bp, spEnd: oldSp + argc });
        this.bp = newBp;
        this.sp = newBp;
        this.pc = method.codeOffset;
        return;
      }
      case Op.RET: {
        const value = this.pop();
        const frame = this.frames.pop();
        if (!frame) {
          this.fail('RET without a caller');
          return;
        }
        this.sp = frame.spEnd;
        this.bp = frame.callerBp;
        this.pc = frame.returnPc;
        this.push(value);
        return;
      }

      case Op.READLINE: {
        const line = this.lineQueue.shift();
        if (line === undefined) {
          this.pc--;
          this.state = 'waiting-line';
          return;
        }
        this.writeText(line);
        this.writeText('\n');
        this.push(str(line));
        return;
      }
      case Op.READKEY: {
        const key = this.keyQueue.shift();
        if (key === undefined) {
          this.pc--;
          this.state = 'waiting-key';
          return;
        }
        const code = key.charCodeAt(0) & 0xff;
        if (code >= 32 && code < 127) this.writeText(key);
        this.push(int(code));
        return;
      }

      case Op.TOSTR:
        this.push(str(toStr(this.pop())));
        return;
      case Op.LEN: {
        const value = this.pop();
        if (value.t === 1) {
          this.push(int(value.v.length));
        } else if (value.t === 3) {
          this.push(int(value.v.items.length));
        } else {
          this.warn('wrong value type -> 0');
          this.push(int(0));
        }
        return;
      }

      case Op.NEWARR: {
        const elementType = this.fetch16();
        const count = toNum(this.pop());
        if (count < 0 || count > 7000) {
          this.fail('array allocation error');
          return;
        }
        const kind = elementType === 1 ? 'string' : elementType === 2 ? 'bool' : 'int';
        const make = (): Val => kind === 'string' ? str('') : kind === 'bool' ? bool(false) : int(0);
        const items: Val[] = [];
        for (let i = 0; i < count; i++) items.push(make());
        this.push({ t: 3, v: { kind, items } });
        return;
      }
      case Op.AGET: {
        const index = toNum(this.pop());
        const array = this.pop();
        if (array.t !== 3) {
          this.fail('array index on a non-array value');
          return;
        }
        if (index < 0 || index >= array.v.items.length) {
          this.fail('array index out of bounds');
          return;
        }
        this.push(array.v.items[index]);
        return;
      }
      case Op.ASET: {
        const value = this.pop();
        const index = toNum(this.pop());
        const array = this.pop();
        if (array.t !== 3) {
          this.fail('array assignment on a non-array value');
          return;
        }
        if (index < 0 || index >= array.v.items.length) {
          this.fail('array index out of bounds');
          return;
        }
        array.v.items[index] = value;
        this.push(value);
        return;
      }
      case Op.PARSE: {
        const value = this.pop();
        if (value.t !== 1) {
          this.warn('unreadable number -> 0');
          this.push(int(0));
          return;
        }
        const parsed = parseIntString(String(value.v));
        if (parsed === null) {
          this.warn('unreadable number -> 0');
          this.push(int(0));
        } else {
          this.push(int(parsed));
        }
        return;
      }
      case Op.ABS: {
        const value = toNum(this.pop());
        this.push(int(Math.abs(value)));
        return;
      }
      case Op.MIN: {
        const b = toNum(this.pop());
        const a = toNum(this.pop());
        this.push(int(Math.min(a, b)));
        return;
      }
      case Op.MAX: {
        const b = toNum(this.pop());
        const a = toNum(this.pop());
        this.push(int(Math.max(a, b)));
        return;
      }
      case Op.UPPER:
      case Op.LOWER: {
        const value = this.pop();
        if (value.t !== 1) {
          this.warn('wrong value type -> 0');
          this.push(str(''));
          return;
        }
        const text = String(value.v);
        let out = '';
        for (const ch of text) {
          const code = ch.charCodeAt(0);
          if (opcode === Op.UPPER && code >= 97 && code <= 122) out += String.fromCharCode(code - 32);
          else if (opcode === Op.LOWER && code >= 65 && code <= 90) out += String.fromCharCode(code + 32);
          else out += ch;
        }
        this.push(str(out));
        return;
      }

      case Op.GINIT:
        this.gfxMode = true;
        this.gfx.fill(0);
        this.buffered = false;
        this.fontBytes = FONT_8X8.slice();
        this.resetPalette();
        return;

      case Op.GEND:
        this.gfxMode = false;
        this.buffered = false;
        this.screen.clear();
        return;

      case Op.GBEGIN:
        this.gfxEnsure();
        this.back.fill(0);
        this.buffered = true;
        return;

      case Op.GPRESENT:
        if (this.buffered) this.gfx.set(this.back);
        return;

      case Op.GENDBUF:
        this.buffered = false;
        return;

      case Op.GPALETTEPRESET: {
        const preset = toNum(this.pop());
        this.resetPalette(preset);
        return;
      }

      case Op.GSETFONT: {
        const font = this.pop();
        if (font.t !== 1 || font.v.length < 760) {
          this.warn('custom font needs 760 characters -> ignored');
          return;
        }
        this.fontBytes = Array.from(font.v.slice(0, 760)).map((ch) => ch.charCodeAt(0) & 0xff);
        return;
      }

      case Op.GCLEAR: {
        const color = toNum(this.pop());
        this.gfxEnsure();
        this.gfxClear(color);
        return;
      }

      case Op.GPIXEL: {
        const color = toNum(this.pop());
        const y = toNum(this.pop());
        const x = toNum(this.pop());
        this.gfxEnsure();
        this.gfxPixel(x, y, color);
        return;
      }

      case Op.GFILLRECT: {
        const color = toNum(this.pop());
        const h = toNum(this.pop());
        const w = toNum(this.pop());
        const y = toNum(this.pop());
        const x = toNum(this.pop());
        this.gfxEnsure();
        this.gfxFillRect(x, y, w, h, color);
        return;
      }

      case Op.GRECT: {
        const color = toNum(this.pop());
        const h = toNum(this.pop());
        const w = toNum(this.pop());
        const y = toNum(this.pop());
        const x = toNum(this.pop());
        this.gfxEnsure();
        this.gfxRect(x, y, w, h, color);
        return;
      }

      case Op.GLINE: {
        const color = toNum(this.pop());
        const y2 = toNum(this.pop());
        const x2 = toNum(this.pop());
        const y1 = toNum(this.pop());
        const x1 = toNum(this.pop());
        this.gfxEnsure();
        this.gfxLine(x1, y1, x2, y2, color);
        return;
      }

      case Op.GFILLCIRCLE: {
        const color = toNum(this.pop());
        const r = toNum(this.pop());
        const cy = toNum(this.pop());
        const cx = toNum(this.pop());
        this.gfxEnsure();
        this.gfxFillCircle(cx, cy, r, color);
        return;
      }

      case Op.GCIRCLE: {
        const color = toNum(this.pop());
        const r = toNum(this.pop());
        const cy = toNum(this.pop());
        const cx = toNum(this.pop());
        this.gfxEnsure();
        this.gfxCircle(cx, cy, r, color);
        return;
      }

      case Op.RGB: {
        const b = toNum(this.pop());
        const g = toNum(this.pop());
        const r = toNum(this.pop());
        this.push(int(rgbIndex(r, g, b)));
        return;
      }

      case Op.GPALETTE: {
        const b = toNum(this.pop());
        const g = toNum(this.pop());
        const r = toNum(this.pop());
        const index = toNum(this.pop());
        if (index >= 0 && index < 256) {
          this.paletteBytes[index * 3] = r & 0xff;
          this.paletteBytes[index * 3 + 1] = g & 0xff;
          this.paletteBytes[index * 3 + 2] = b & 0xff;
        }
        return;
      }

      case Op.GSPRITE: {
        const height = toNum(this.pop());
        const width = toNum(this.pop());
        const data = this.pop();
        const y = toNum(this.pop());
        const x = toNum(this.pop());
        if (data.t !== 1) {
          this.warn('sprite data is not a string -> skipped');
          return;
        }
        this.gfxEnsure();
        this.gfxSprite(x, y, data.v, width, height);
        return;
      }

      case Op.GTEXT: {
        const color = toNum(this.pop());
        const text = this.pop();
        const y = toNum(this.pop());
        const x = toNum(this.pop());
        if (text.t !== 1) {
          this.warn('bitmap text is not a string -> skipped');
          return;
        }
        this.gfxEnsure();
        this.gfxText(x, y, text.v, color);
        return;
      }

      case Op.GSPRITESCALE: {
        const scale = toNum(this.pop());
        const height = toNum(this.pop());
        const width = toNum(this.pop());
        const data = this.pop();
        const y = toNum(this.pop());
        const x = toNum(this.pop());
        if (data.t !== 1) {
          this.warn('scaled sprite data is not a string -> skipped');
          return;
        }
        this.gfxEnsure();
        this.gfxSpriteScale(x, y, data.v, width, height, scale);
        return;
      }

      case Op.GSPRITEROT: {
        const rotation = toNum(this.pop());
        const height = toNum(this.pop());
        const width = toNum(this.pop());
        const data = this.pop();
        const y = toNum(this.pop());
        const x = toNum(this.pop());
        if (data.t !== 1) {
          this.warn('rotated sprite data is not a string -> skipped');
          return;
        }
        this.gfxEnsure();
        this.gfxSpriteRotate(x, y, data.v, width, height, rotation);
        return;
      }

      case Op.ACOPY: {
        const count = toNum(this.pop());
        const destIndex = toNum(this.pop());
        const dest = this.pop();
        const sourceIndex = toNum(this.pop());
        const source = this.pop();
        if (source.t !== 3 || dest.t !== 3 || count < 0 || sourceIndex < 0 || destIndex < 0) {
          this.warn('Array.Copy needs two arrays and non-negative indexes');
          return;
        }
        const n = Math.min(count, source.v.items.length - sourceIndex, dest.v.items.length - destIndex);
        if (source === dest && destIndex > sourceIndex && destIndex < sourceIndex + n) {
          for (let i = n - 1; i >= 0; i--) dest.v.items[destIndex + i] = source.v.items[sourceIndex + i];
        } else {
          for (let i = 0; i < n; i++) dest.v.items[destIndex + i] = source.v.items[sourceIndex + i];
        }
        return;
      }

      default:
        this.fail(`unknown opcode ${opcode}`);
        return;
    }
  }
}

