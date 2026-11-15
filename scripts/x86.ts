/**
 * Small 8086 real-mode interpreter used by the smoke test. It implements the
 * instructions the boot sector and the SharpBoot VM kernel execute, plus BIOS
 * stubs for int 10h (video), int 13h (disk) and int 16h (keyboard), so the
 * emitted floppy image can be booted and driven without QEMU.
 */

export class WaitingForKey extends Error {}
export class Halted extends Error {}

interface Registers {
  ax: number;
  bx: number;
  cx: number;
  dx: number;
  si: number;
  di: number;
  bp: number;
  sp: number;
  cs: number;
  ds: number;
  es: number;
  ss: number;
  ip: number;
  cf: boolean;
  zf: boolean;
  sf: boolean;
  of: boolean;
  df: boolean;
}

interface ModRM {
  mod: number;
  reg: number;
  rm: number;
  isReg: boolean;
  addr: number;
}

export class X86 {
  mem = new Uint8Array(0x100000);
  regs: Registers;
  disk: Uint8Array;
  keys: number[] = [];
  steps = 0;
  maxSteps = 8_000_000;
  halted = false;
  waiting = false;
  cursorRow = 0;
  cursorCol = 0;
  videoMode = 0x03;
  teletype: string[] = [];
  trace: ((cs: number, ip: number, op: number) => void) | null = null;
  diskTrace: string[] = [];
  private segOverride: number | null = null;

  constructor(disk: Uint8Array) {
    this.disk = disk;
    this.mem.set(disk.subarray(0, 512), 0x7c00);
    this.regs = {
      ax: 0,
      bx: 0,
      cx: 0,
      dx: 0,
      si: 0,
      di: 0,
      bp: 0,
      sp: 0x7c00,
      cs: 0,
      ds: 0,
      es: 0,
      ss: 0,
      ip: 0x7c00,
      cf: false,
      zf: false,
      sf: false,
      of: false,
      df: false,
    };
  }

  video(): Uint8Array {
    return this.mem.slice(0xb8000, 0xb8000 + 4000);
  }

  graphics(): Uint8Array {
    return this.mem.slice(0xa0000, 0xa0000 + 320 * 200);
  }

  pushKey(ascii: number, scan = 0x39): void {
    this.keys.push((scan << 8) | (ascii & 0xff));
  }

  run(): void {
    while (!this.halted) {
      if (++this.steps > this.maxSteps) {
        throw new Error(
          `Instruction budget exceeded at ${this.regs.cs.toString(16)}:${this.regs.ip.toString(16)}`,
        );
      }
      this.waiting = false;
      this.step();
    }
    throw new Halted();
  }

  // ------------------------------------------------------------ memory helpers
  private readMem(addr: number): number {
    return this.mem[addr & 0xfffff];
  }

  private writeMem(addr: number, value: number): void {
    this.mem[addr & 0xfffff] = value & 0xff;
  }

  private readWord(addr: number): number {
    return this.readMem(addr) | (this.readMem(addr + 1) << 8);
  }

  private writeWord(addr: number, value: number): void {
    this.writeMem(addr, value);
    this.writeMem(addr + 1, value >> 8);
  }

  private fetch8(): number {
    const value = this.readMem(this.regs.cs * 16 + this.regs.ip);
    this.regs.ip = (this.regs.ip + 1) & 0xffff;
    return value;
  }

  private fetch16(): number {
    const lo = this.fetch8();
    return lo | (this.fetch8() << 8);
  }

  // ------------------------------------------------------------ registers
  private get16(index: number): number {
    switch (index) {
      case 0: return this.regs.ax;
      case 1: return this.regs.cx;
      case 2: return this.regs.dx;
      case 3: return this.regs.bx;
      case 4: return this.regs.sp;
      case 5: return this.regs.bp;
      case 6: return this.regs.si;
      default: return this.regs.di;
    }
  }

  private set16(index: number, value: number): void {
    const v = value & 0xffff;
    switch (index) {
      case 0: this.regs.ax = v; break;
      case 1: this.regs.cx = v; break;
      case 2: this.regs.dx = v; break;
      case 3: this.regs.bx = v; break;
      case 4: this.regs.sp = v; break;
      case 5: this.regs.bp = v; break;
      case 6: this.regs.si = v; break;
      default: this.regs.di = v; break;
    }
  }

  private get8(index: number): number {
    switch (index) {
      case 0: return this.regs.ax & 0xff;
      case 1: return this.regs.cx & 0xff;
      case 2: return this.regs.dx & 0xff;
      case 3: return this.regs.bx & 0xff;
      case 4: return (this.regs.ax >> 8) & 0xff;
      case 5: return (this.regs.cx >> 8) & 0xff;
      case 6: return (this.regs.dx >> 8) & 0xff;
      default: return (this.regs.bx >> 8) & 0xff;
    }
  }

  private set8(index: number, value: number): void {
    const v = value & 0xff;
    switch (index) {
      case 0: this.regs.ax = (this.regs.ax & 0xff00) | v; break;
      case 1: this.regs.cx = (this.regs.cx & 0xff00) | v; break;
      case 2: this.regs.dx = (this.regs.dx & 0xff00) | v; break;
      case 3: this.regs.bx = (this.regs.bx & 0xff00) | v; break;
      case 4: this.regs.ax = (this.regs.ax & 0x00ff) | (v << 8); break;
      case 5: this.regs.cx = (this.regs.cx & 0x00ff) | (v << 8); break;
      case 6: this.regs.dx = (this.regs.dx & 0x00ff) | (v << 8); break;
      default: this.regs.bx = (this.regs.bx & 0x00ff) | (v << 8); break;
    }
  }

  private regRead(index: number, width: 8 | 16): number {
    return width === 16 ? this.get16(index) : this.get8(index);
  }

  private regWrite(index: number, width: 8 | 16, value: number): void {
    if (width === 16) this.set16(index, value);
    else this.set8(index, value);
  }

  // ------------------------------------------------------------ modrm / memory
  private modrm(): ModRM {
    const byte = this.fetch8();
    const mod = (byte >> 6) & 3;
    const reg = (byte >> 3) & 7;
    const rm = byte & 7;
    if (mod === 3) return { mod, reg, rm, isReg: true, addr: 0 };

    let base: number | null = null;
    let index: number | null = null;
    let baseUsesBp = false;
    let direct = false;
    let disp = 0;

    switch (rm) {
      case 0: base = this.regs.bx; index = this.regs.si; break;
      case 1: base = this.regs.bx; index = this.regs.di; break;
      case 2: base = this.regs.bp; baseUsesBp = true; index = this.regs.si; break;
      case 3: base = this.regs.bp; baseUsesBp = true; index = this.regs.di; break;
      case 4: index = this.regs.si; break;
      case 5: index = this.regs.di; break;
      case 6:
        if (mod === 0) {
          direct = true;
          disp = this.fetch16();
        } else {
          base = this.regs.bp;
          baseUsesBp = true;
        }
        break;
      default:
        base = this.regs.bx;
        break;
    }

    if (!direct && mod === 1) disp = this.fetch8();
    else if (!direct && mod === 2) disp = this.fetch16();
    if (disp & 0x8000) disp -= 0x10000;

    const defaultSegment = baseUsesBp ? this.regs.ss : this.regs.ds;
    const segment = this.segOverride ?? defaultSegment;
    let offset = (base ?? 0) + (index ?? 0) + (direct ? 0 : disp);
    if (direct) offset = disp;
    const addr = (segment * 16 + (offset & 0xffff)) & 0xfffff;
    return { mod, reg, rm, isReg: false, addr };
  }

  private rmRead(d: ModRM, width: 8 | 16): number {
    if (d.isReg) return this.regRead(d.rm, width);
    return width === 16 ? this.readWord(d.addr) : this.readMem(d.addr);
  }

  private rmWrite(d: ModRM, width: 8 | 16, value: number): void {
    if (d.isReg) this.regWrite(d.rm, width, value);
    else if (width === 16) this.writeWord(d.addr, value);
    else this.writeMem(d.addr, value);
  }

  // ------------------------------------------------------------ flags / alu
  private setLogicFlags(result: number, width: 8 | 16): void {
    const mask = width === 16 ? 0xffff : 0xff;
    const sign = width === 16 ? 0x8000 : 0x80;
    this.regs.zf = (result & mask) === 0;
    this.regs.sf = (result & sign) !== 0;
    this.regs.cf = false;
    this.regs.of = false;
  }

  private alu(op: number, a: number, b: number, width: 8 | 16): number {
    const mask = width === 16 ? 0xffff : 0xff;
    const sign = width === 16 ? 0x8000 : 0x80;
    a &= mask;
    b &= mask;
    if (op === 0 || op === 2) {
      const carry = op === 2 && this.regs.cf ? 1 : 0;
      const sum = a + b + carry;
      const result = sum & mask;
      this.regs.cf = sum > mask;
      this.regs.of = ((a ^ result) & (b ^ result) & sign) !== 0;
      this.regs.zf = result === 0;
      this.regs.sf = (result & sign) !== 0;
      return result;
    }
    if (op === 5 || op === 3 || op === 7) {
      const borrow = op === 3 && this.regs.cf ? 1 : 0;
      const diff = a - b - borrow;
      const result = diff & mask;
      this.regs.cf = diff < 0;
      this.regs.of = ((a ^ b) & (a ^ result) & sign) !== 0;
      this.regs.zf = result === 0;
      this.regs.sf = (result & sign) !== 0;
      // CMP only sets flags; it must leave its destination unchanged.
      return op === 7 ? a & mask : result;
    }
    let result: number;
    if (op === 1) result = a | b;
    else if (op === 4) result = a & b;
    else result = a ^ b;
    result &= mask;
    this.setLogicFlags(result, width);
    return result;
  }

  private push16(value: number): void {
    this.regs.sp = (this.regs.sp - 2) & 0xffff;
    this.writeWord(this.regs.ss * 16 + this.regs.sp, value);
  }

  private pop16(): number {
    const value = this.readWord(this.regs.ss * 16 + this.regs.sp);
    this.regs.sp = (this.regs.sp + 2) & 0xffff;
    return value;
  }

  private signed(value: number, width: 8 | 16): number {
    const sign = width === 16 ? 0x8000 : 0x80;
    const mask = width === 16 ? 0xffff : 0xff;
    const v = value & mask;
    return (v & sign) ? v - (mask + 1) : v;
  }

  private condition(code: number): boolean {
    switch (code & 0x0f) {
      case 0x0: return this.regs.of;
      case 0x1: return !this.regs.of;
      case 0x2: return this.regs.cf;
      case 0x3: return !this.regs.cf;
      case 0x4: return this.regs.zf;
      case 0x5: return !this.regs.zf;
      case 0x6: return this.regs.cf || this.regs.zf;
      case 0x7: return !this.regs.cf && !this.regs.zf;
      case 0x8: return this.regs.sf;
      case 0x9: return !this.regs.sf;
      case 0xa: return false;
      case 0xb: return true;
      case 0xc: return this.regs.sf !== this.regs.of;
      case 0xd: return this.regs.sf === this.regs.of;
      case 0xe: return this.regs.zf || this.regs.sf !== this.regs.of;
      default: return !this.regs.zf && this.regs.sf === this.regs.of;
    }
  }

  private shift(group: number, value: number, count: number, width: 8 | 16): number {
    const mask = width === 16 ? 0xffff : 0xff;
    const sign = width === 16 ? 0x8000 : 0x80;
    let v = value & mask;
    let cf = this.regs.cf;
    let of = this.regs.of;
    for (let i = 0; i < count; i++) {
      if (group === 4) {
        cf = (v & sign) !== 0;
        const next = (v << 1) & mask;
        of = ((next & sign) !== 0) !== cf;
        v = next;
      } else if (group === 5) {
        cf = (v & 1) !== 0;
        of = (v & sign) !== 0;
        v = (v >> 1) & mask;
      } else if (group === 7) {
        cf = (v & 1) !== 0;
        v = ((v >> 1) | (v & sign)) & mask;
      } else if (group === 0) {
        const high = (v & sign) !== 0;
        v = ((v << 1) | (cf ? 1 : 0)) & mask;
        cf = high;
      } else {
        throw new Error(`Unsupported shift group ${group}`);
      }
    }
    this.regs.cf = cf;
    this.regs.of = of;
    this.regs.zf = v === 0;
    this.regs.sf = (v & sign) !== 0;
    return v;
  }

  // ------------------------------------------------------------ instruction
  private step(): void {
    this.segOverride = null;
    let rep = false;
    let op = this.fetch8();
    for (;;) {
      if (op === 0x26) { this.segOverride = this.regs.es; op = this.fetch8(); continue; }
      if (op === 0x2e) { this.segOverride = this.regs.cs; op = this.fetch8(); continue; }
      if (op === 0x36) { this.segOverride = this.regs.ss; op = this.fetch8(); continue; }
      if (op === 0x3e) { this.segOverride = this.regs.ds; op = this.fetch8(); continue; }
      if (op === 0xf2 || op === 0xf3) { rep = true; op = this.fetch8(); continue; }
      break;
    }
    this.trace?.(this.regs.cs, this.regs.ip - 1, op);

    // ALU block: add/or/adc/sbb/and/sub/xor/cmp, all six operand forms.
    if (op < 0x40 && (op & 7) <= 5) {
      const group = op >> 3;
      const form = op & 7;
      if (form === 0 || form === 1) {
        const width: 8 | 16 = form === 1 ? 16 : 8;
        const d = this.modrm();
        const a = this.rmRead(d, width);
        const b = this.regRead(d.reg, width);
        this.rmWrite(d, width, this.alu(group, a, b, width));
        return;
      }
      if (form === 2 || form === 3) {
        const width: 8 | 16 = form === 3 ? 16 : 8;
        const d = this.modrm();
        const a = this.regRead(d.reg, width);
        const b = this.rmRead(d, width);
        this.regWrite(d.reg, width, this.alu(group, a, b, width));
        return;
      }
      const width: 8 | 16 = form === 5 ? 16 : 8;
      const a = width === 16 ? this.regs.ax : (this.regs.ax & 0xff);
      const b = width === 16 ? this.fetch16() : this.fetch8();
      const result = this.alu(group, a, b, width);
      if (width === 16) this.regs.ax = result;
      else this.regs.ax = (this.regs.ax & 0xff00) | result;
      return;
    }

    switch (op) {
      case 0x06: this.push16(this.regs.es); return;
      case 0x07: this.regs.es = this.pop16(); return;
      case 0x0e: this.push16(this.regs.cs); return;
      case 0x16: this.push16(this.regs.ss); return;
      case 0x17: this.regs.ss = this.pop16(); return;
      case 0x1e: this.push16(this.regs.ds); return;
      case 0x1f: this.regs.ds = this.pop16(); return;

      case 0x0f: {
        const second = this.fetch8();
        if (second >= 0x80 && second <= 0x8f) {
          const rel = this.signed(this.fetch16(), 16);
          if (this.condition(second)) this.regs.ip = (this.regs.ip + rel) & 0xffff;
          return;
        }
        throw new Error(`Unsupported 0x0F opcode 0x${second.toString(16)}`);
      }

      case 0x40: case 0x41: case 0x42: case 0x43:
      case 0x44: case 0x45: case 0x46: case 0x47: {
        const index = op & 7;
        const cf = this.regs.cf;
        this.set16(index, this.alu(0, this.get16(index), 1, 16));
        this.regs.cf = cf;
        return;
      }
      case 0x48: case 0x49: case 0x4a: case 0x4b:
      case 0x4c: case 0x4d: case 0x4e: case 0x4f: {
        const index = op & 7;
        const cf = this.regs.cf;
        this.set16(index, this.alu(5, this.get16(index), 1, 16));
        this.regs.cf = cf;
        return;
      }

      case 0x50: case 0x51: case 0x52: case 0x53:
      case 0x54: case 0x55: case 0x56: case 0x57:
        this.push16(this.get16(op & 7));
        return;
      case 0x58: case 0x59: case 0x5a: case 0x5b:
      case 0x5c: case 0x5d: case 0x5e: case 0x5f:
        this.set16(op & 7, this.pop16());
        return;

      case 0x68: this.push16(this.fetch16()); return;
      case 0x6a: this.push16(this.signed(this.fetch8(), 8) & 0xffff); return;

      case 0x70: case 0x71: case 0x72: case 0x73:
      case 0x74: case 0x75: case 0x76: case 0x77:
      case 0x78: case 0x79: case 0x7a: case 0x7b:
      case 0x7c: case 0x7d: case 0x7e: case 0x7f: {
        const rel = this.signed(this.fetch8(), 8);
        if (this.condition(op & 0x0f)) this.regs.ip = (this.regs.ip + rel) & 0xffff;
        return;
      }

      case 0x80: case 0x81: case 0x82: case 0x83: {
        const width: 8 | 16 = op === 0x80 || op === 0x82 ? 8 : 16;
        const d = this.modrm();
        let immediate = width === 16 ? this.fetch16() : this.fetch8();
        if (op === 0x83) immediate = this.signed(immediate, 8) & 0xffff;
        const a = this.rmRead(d, width);
        this.rmWrite(d, width, this.alu(d.reg, a, immediate, width));
        return;
      }

      case 0x84: case 0x85: {
        const width: 8 | 16 = op === 0x85 ? 16 : 8;
        const d = this.modrm();
        this.setLogicFlags(this.rmRead(d, width) & this.regRead(d.reg, width), width);
        return;
      }

      case 0x86: case 0x87: {
        const width: 8 | 16 = op === 0x87 ? 16 : 8;
        const d = this.modrm();
        const a = this.rmRead(d, width);
        const b = this.regRead(d.reg, width);
        this.rmWrite(d, width, b);
        this.regWrite(d.reg, width, a);
        return;
      }

      case 0x88: case 0x89: {
        const width: 8 | 16 = op === 0x89 ? 16 : 8;
        const d = this.modrm();
        this.rmWrite(d, width, this.regRead(d.reg, width));
        return;
      }
      case 0x8a: case 0x8b: {
        const width: 8 | 16 = op === 0x8b ? 16 : 8;
        const d = this.modrm();
        this.regWrite(d.reg, width, this.rmRead(d, width));
        return;
      }
      case 0x8c: {
        const d = this.modrm();
        const value = d.reg === 0 ? this.regs.es
          : d.reg === 1 ? this.regs.cs
          : d.reg === 2 ? this.regs.ss
          : d.reg === 3 ? this.regs.ds : 0;
        this.rmWrite(d, 16, value);
        return;
      }
      case 0x8e: {
        const d = this.modrm();
        const value = this.rmRead(d, 16);
        if (d.reg === 0) this.regs.es = value;
        else if (d.reg === 2) this.regs.ss = value;
        else if (d.reg === 3) this.regs.ds = value;
        else throw new Error(`Unsupported segment register ${d.reg}`);
        return;
      }

      case 0x90: return;
      case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: {
        const value = this.get16(op & 7);
        this.set16(op & 7, this.regs.ax);
        this.regs.ax = value;
        return;
      }

      case 0x98: {
        const al = this.regs.ax & 0xff;
        this.regs.ax = al & 0x80 ? al | 0xff00 : al;
        return;
      }
      case 0x99:
        this.regs.dx = (this.regs.ax & 0x8000) ? 0xffff : 0;
        return;

      case 0xa0: this.regs.ax = (this.regs.ax & 0xff00) | this.readMem(this.regs.ds * 16 + this.fetch16()); return;
      case 0xa1: this.regs.ax = this.readWord(this.regs.ds * 16 + this.fetch16()); return;
      case 0xa2: this.writeMem(this.regs.ds * 16 + this.fetch16(), this.regs.ax & 0xff); return;
      case 0xa3: this.writeWord(this.regs.ds * 16 + this.fetch16(), this.regs.ax); return;

      case 0xa4: case 0xa5: case 0xa6: case 0xa7:
      case 0xaa: case 0xab: case 0xac: case 0xad:
      case 0xae: case 0xaf:
        this.stringOp(op, rep);
        return;

      case 0xa8: case 0xa9: {
        const width: 8 | 16 = op === 0xa9 ? 16 : 8;
        const immediate = width === 16 ? this.fetch16() : this.fetch8();
        const a = width === 16 ? this.regs.ax : this.regs.ax & 0xff;
        this.setLogicFlags(a & immediate, width);
        return;
      }

      case 0xb0: case 0xb1: case 0xb2: case 0xb3:
      case 0xb4: case 0xb5: case 0xb6: case 0xb7:
        this.set8(op & 7, this.fetch8());
        return;
      case 0xb8: case 0xb9: case 0xba: case 0xbb:
      case 0xbc: case 0xbd: case 0xbe: case 0xbf:
        this.set16(op & 7, this.fetch16());
        return;

      case 0xc0: case 0xc1: {
        const width: 8 | 16 = op === 0xc1 ? 16 : 8;
        const d = this.modrm();
        const count = this.fetch8() & 0x1f;
        this.rmWrite(d, width, this.shift(d.reg, this.rmRead(d, width), count, width));
        return;
      }

      case 0xc2: {
        const extra = this.fetch16();
        this.regs.ip = this.pop16();
        this.regs.sp = (this.regs.sp + extra) & 0xffff;
        return;
      }
      case 0xc3:
        this.regs.ip = this.pop16();
        return;

      case 0xc6: case 0xc7: {
        const width: 8 | 16 = op === 0xc7 ? 16 : 8;
        const d = this.modrm();
        const value = width === 16 ? this.fetch16() : this.fetch8();
        this.rmWrite(d, width, value);
        return;
      }

      case 0xcc:
        throw new Error('int3');
      case 0xcd:
        this.interrupt(this.fetch8());
        return;

      case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        const width: 8 | 16 = op === 0xd1 || op === 0xd3 ? 16 : 8;
        const d = this.modrm();
        const count = op === 0xd0 || op === 0xd1 ? 1 : this.regs.cx & 0xff;
        this.rmWrite(d, width, this.shift(d.reg, this.rmRead(d, width), count & 0x1f, width));
        return;
      }

      case 0xe8: {
        const rel = this.signed(this.fetch16(), 16);
        const next = this.regs.ip;
        this.push16(next);
        this.regs.ip = (next + rel) & 0xffff;
        return;
      }
      case 0xe9: {
        const rel = this.signed(this.fetch16(), 16);
        this.regs.ip = (this.regs.ip + rel) & 0xffff;
        return;
      }
      case 0xea: {
        const offset = this.fetch16();
        const segment = this.fetch16();
        this.regs.cs = segment;
        this.regs.ip = offset;
        return;
      }
      case 0xeb: {
        const rel = this.signed(this.fetch8(), 8);
        this.regs.ip = (this.regs.ip + rel) & 0xffff;
        return;
      }

      case 0xf4:
        this.halted = true;
        return;
      case 0xf5:
        this.regs.cf = !this.regs.cf;
        return;
      case 0xf8: this.regs.cf = false; return;
      case 0xf9: this.regs.cf = true; return;
      case 0xfa: case 0xfb: return;
      case 0xfc: this.regs.df = false; return;
      case 0xfd: this.regs.df = true; return;

      case 0xf6: case 0xf7: {
        const width: 8 | 16 = op === 0xf7 ? 16 : 8;
        const d = this.modrm();
        if (d.reg === 0) {
          const immediate = width === 16 ? this.fetch16() : this.fetch8();
          this.setLogicFlags(this.rmRead(d, width) & immediate, width);
          return;
        }
        this.group3(d, this.rmRead(d, width), width);
        return;
      }

      case 0xfe: {
        const d = this.modrm();
        const current = this.rmRead(d, 8);
        const cf = this.regs.cf;
        this.rmWrite(d, 8, this.alu(d.reg === 0 ? 0 : 5, current, 1, 8));
        this.regs.cf = cf;
        return;
      }
      case 0xff: {
        const d = this.modrm();
        if (d.reg === 0 || d.reg === 1) {
          const current = this.rmRead(d, 16);
          const cf = this.regs.cf;
          this.rmWrite(d, 16, this.alu(d.reg === 0 ? 0 : 5, current, 1, 16));
          this.regs.cf = cf;
          return;
        }
        if (d.reg === 2) {
          const target = this.rmRead(d, 16);
          this.push16(this.regs.ip);
          this.regs.ip = target;
          return;
        }
        if (d.reg === 4) {
          this.regs.ip = this.rmRead(d, 16);
          return;
        }
        if (d.reg === 6) {
          this.push16(this.rmRead(d, 16));
          return;
        }
        throw new Error(`Unsupported FF group ${d.reg}`);
      }

      default:
        throw new Error(
          `Unsupported opcode 0x${op.toString(16)} at ${this.regs.cs.toString(16)}:${(this.regs.ip - 1).toString(16)}`,
        );
    }
  }

  private group3(d: ModRM, value: number, width: 8 | 16): void {
    const group = d.reg;
    const mask = width === 16 ? 0xffff : 0xff;
    if (group === 2) {
      this.rmWrite(d, width, (~value) & mask);
      return;
    }
    if (group === 3) {
      const result = (-value) & mask;
      this.regs.cf = value !== 0;
      this.regs.zf = result === 0;
      this.regs.sf = (result & (width === 16 ? 0x8000 : 0x80)) !== 0;
      this.regs.of = value === (width === 16 ? 0x8000 : 0x80);
      this.rmWrite(d, width, result);
      return;
    }

    if (group === 4 || group === 5) {
      const signedMul = group === 5;
      if (width === 16) {
        const a = signedMul ? this.signed(this.regs.ax, 16) : this.regs.ax;
        const b = signedMul ? this.signed(value, 16) : value;
        const product = a * b;
        const low = product & 0xffff;
        const high = Math.floor(product / 0x10000) & 0xffff;
        this.regs.ax = low;
        this.regs.dx = high;
        const fits = signedMul
          ? product >= -32768 && product <= 32767
          : high === 0;
        this.regs.cf = !fits;
        this.regs.of = !fits;
      } else {
        const a = signedMul ? this.signed(this.regs.ax & 0xff, 8) : this.regs.ax & 0xff;
        const b = signedMul ? this.signed(value, 8) : value & 0xff;
        const product = a * b;
        this.regs.ax = product & 0xffff;
        const fits = signedMul ? product >= -128 && product <= 127 : product <= 0xff;
        this.regs.cf = !fits;
        this.regs.of = !fits;
      }
      return;
    }

    if (group === 6) {
      if (value === 0) throw new Error('divide error: divisor is zero');
      if (width === 16) {
        const dividend = this.regs.dx * 0x10000 + this.regs.ax;
        const quotient = Math.floor(dividend / value);
        if (quotient > 0xffff) throw new Error('divide error: quotient overflow');
        this.regs.ax = quotient & 0xffff;
        this.regs.dx = dividend - quotient * value;
      } else {
        const dividend = this.regs.ax;
        const quotient = Math.floor(dividend / value);
        if (quotient > 0xff) throw new Error('divide error: quotient overflow');
        this.regs.ax = ((dividend - quotient * value) << 8) | quotient;
      }
      return;
    }

    if (group === 7) {
      if (value === 0) throw new Error('divide error: divisor is zero');
      if (width === 16) {
        const raw = this.regs.dx * 0x10000 + this.regs.ax;
        const dividend = raw >= 0x80000000 ? raw - 0x100000000 : raw;
        const divisor = this.signed(value, 16);
        const quotient = Math.trunc(dividend / divisor);
        if (quotient < -32768 || quotient > 32767) throw new Error('divide error: quotient overflow');
        const remainder = dividend - quotient * divisor;
        this.regs.ax = quotient & 0xffff;
        this.regs.dx = remainder & 0xffff;
      } else {
        const dividend = this.signed(this.regs.ax, 16);
        const divisor = this.signed(value, 8);
        const quotient = Math.trunc(dividend / divisor);
        if (quotient < -128 || quotient > 127) throw new Error('divide error: quotient overflow');
        const remainder = dividend - quotient * divisor;
        this.regs.ax = ((remainder & 0xff) << 8) | (quotient & 0xff);
      }
      return;
    }

    throw new Error(`Unsupported F7 group ${group}`);
  }

  private stringOp(op: number, rep: boolean): void {
    const delta = this.regs.df ? -1 : 1;
    const count = rep ? this.regs.cx : 1;
    if (rep) this.regs.cx = 0;
    for (let i = 0; i < count; i++) {
      if (op === 0xa4 || op === 0xa5) {
        const width: 8 | 16 = op === 0xa5 ? 16 : 8;
        const value = width === 16
          ? this.readWord(this.regs.ds * 16 + this.regs.si)
          : this.readMem(this.regs.ds * 16 + this.regs.si);
        if (width === 16) this.writeWord(this.regs.es * 16 + this.regs.di, value);
        else this.writeMem(this.regs.es * 16 + this.regs.di, value);
        this.regs.si = (this.regs.si + delta * (width === 16 ? 2 : 1)) & 0xffff;
        this.regs.di = (this.regs.di + delta * (width === 16 ? 2 : 1)) & 0xffff;
      } else if (op === 0xaa || op === 0xab) {
        const width: 8 | 16 = op === 0xab ? 16 : 8;
        if (width === 16) this.writeWord(this.regs.es * 16 + this.regs.di, this.regs.ax);
        else this.writeMem(this.regs.es * 16 + this.regs.di, this.regs.ax & 0xff);
        this.regs.di = (this.regs.di + delta * (width === 16 ? 2 : 1)) & 0xffff;
      } else if (op === 0xac || op === 0xad) {
        const width: 8 | 16 = op === 0xad ? 16 : 8;
        if (width === 16) this.regs.ax = this.readWord(this.regs.ds * 16 + this.regs.si);
        else this.regs.ax = (this.regs.ax & 0xff00) | this.readMem(this.regs.ds * 16 + this.regs.si);
        this.regs.si = (this.regs.si + delta * (width === 16 ? 2 : 1)) & 0xffff;
      } else if (op === 0xa6 || op === 0xa7) {
        const width: 8 | 16 = op === 0xa7 ? 16 : 8;
        const a = width === 16
          ? this.readWord(this.regs.ds * 16 + this.regs.si)
          : this.readMem(this.regs.ds * 16 + this.regs.si);
        const b = width === 16
          ? this.readWord(this.regs.es * 16 + this.regs.di)
          : this.readMem(this.regs.es * 16 + this.regs.di);
        this.alu(7, a, b, width);
        this.regs.si = (this.regs.si + delta * (width === 16 ? 2 : 1)) & 0xffff;
        this.regs.di = (this.regs.di + delta * (width === 16 ? 2 : 1)) & 0xffff;
      } else if (op === 0xae || op === 0xaf) {
        const width: 8 | 16 = op === 0xaf ? 16 : 8;
        const a = width === 16 ? this.regs.ax : this.regs.ax & 0xff;
        const b = width === 16
          ? this.readWord(this.regs.es * 16 + this.regs.di)
          : this.readMem(this.regs.es * 16 + this.regs.di);
        this.alu(7, a, b, width);
        this.regs.di = (this.regs.di + delta * (width === 16 ? 2 : 1)) & 0xffff;
      } else {
        throw new Error(`Unsupported string op 0x${op.toString(16)}`);
      }
    }
  }

  private interrupt(vector: number): void {
    if (vector === 0x10) {
      const ah = (this.regs.ax >> 8) & 0xff;
      const al = this.regs.ax & 0xff;
      if (ah === 0x00) {
        this.videoMode = al;
        return;
      }
      if (ah === 0x10) {
        // Palette programming through the BIOS; the framebuffer is still the same.
        return;
      }
      if (ah === 0x02) {
        this.cursorRow = (this.regs.dx >> 8) & 0xff;
        this.cursorCol = this.regs.dx & 0xff;
        return;
      }
      if (ah === 0x03) {
        this.regs.dx = (this.cursorRow << 8) | this.cursorCol;
        return;
      }
      if (ah === 0x0e) {
        if (al === 0x0d) {
          this.cursorCol = 0;
          return;
        }
        if (al === 0x0a) {
          this.cursorRow++;
          return;
        }
        if (al === 0x08) {
          if (this.cursorCol > 0) this.cursorCol--;
          return;
        }
        const index = this.cursorRow * 80 + this.cursorCol;
        if (index < 2000) {
          this.writeMem(0xb8000 + index * 2, al);
          this.writeMem(0xb8001 + index * 2, 0x07);
        }
        this.teletype.push(String.fromCharCode(al));
        this.cursorCol++;
        if (this.cursorCol >= 80) {
          this.cursorCol = 0;
          this.cursorRow++;
        }
        return;
      }
      return;
    }

    if (vector === 0x13) {
      const ah = (this.regs.ax >> 8) & 0xff;
      if (ah !== 0x02) throw new Error(`Unsupported disk function AH=0x${ah.toString(16)}`);
      const count = this.regs.ax & 0xff;
      const cylinder = this.regs.cx >> 8;
      const sector = this.regs.cx & 0x3f;
      const head = (this.regs.dx >> 8) & 0xff;
      const lba = (cylinder * 2 + head) * 18 + (sector - 1);
      const offset = lba * 512;
      if (offset + count * 512 > this.disk.length) {
        this.regs.cf = true;
        return;
      }
      const destination = this.regs.es * 16 + this.regs.bx;
      this.diskTrace.push(`cx=${this.regs.cx.toString(16)} dx=${this.regs.dx.toString(16)} cyl=${cylinder} sec=${sector} head=${head} lba=${lba} dest=${destination.toString(16)}`);
      for (let i = 0; i < count * 512; i++) {
        this.writeMem(destination + i, this.disk[offset + i]);
      }
      this.regs.cf = false;
      return;
    }

    if (vector === 0x16) {
      const ah = (this.regs.ax >> 8) & 0xff;
      if (ah !== 0x00) throw new Error(`Unsupported keyboard function AH=0x${ah.toString(16)}`);
      if (this.keys.length === 0) {
        // Re-execute the INT when the caller supplies a key.
        this.regs.ip = (this.regs.ip - 2) & 0xffff;
        this.waiting = true;
        throw new WaitingForKey();
      }
      this.regs.ax = this.keys.shift() ?? 0;
      return;
    }

    throw new Error(`Unsupported interrupt 0x${vector.toString(16)}`);
  }
}
