/** Emits the boot sector, packs the VM kernel and bytecode payload into a 1.44 MB floppy image. */

import { assemble } from './asm.ts';
import { KERNEL_ORIGIN, KERNEL_SOURCE, CODE_START, STRING_START } from './kernel.ts';
import type { CompiledProgram } from './compiler.ts';

export const IMAGE_SIZE = 1474560;
export const BOOT_SECTOR_SIZE = 512;
export const KERNEL_OFFSET = KERNEL_ORIGIN;
export const SECTORS_TO_LOAD = 120;
export const PAYLOAD_BYTES = SECTORS_TO_LOAD * BOOT_SECTOR_SIZE;

type FixupKind = 'rel8' | 'abs16';

interface Fixup {
  pos: number;
  label: string;
  kind: FixupKind;
}

class Code {
  bytes: number[] = [];
  labels = new Map<string, number>();
  fixups: Fixup[] = [];
  org: number;

  constructor(org: number) {
    this.org = org;
  }

  db(...values: number[]): void {
    for (const value of values) this.bytes.push(value & 0xff);
  }

  label(name: string): void {
    this.labels.set(name, this.org + this.bytes.length);
  }

  private rel8(label: string): void {
    this.fixups.push({ pos: this.bytes.length, label, kind: 'rel8' });
    this.bytes.push(0);
  }

  private abs16(label: string): void {
    this.fixups.push({ pos: this.bytes.length, label, kind: 'abs16' });
    this.bytes.push(0, 0);
  }

  movAxImm(value: number): void {
    this.db(0xb8, value, value >> 8);
  }

  movAhImm(value: number): void {
    this.db(0xb4, value);
  }

  movAlImm(value: number): void {
    this.db(0xb0, value);
  }

  movCxImm(value: number): void {
    this.db(0xb9, value, value >> 8);
  }

  movChImm(value: number): void {
    this.db(0xb5, value);
  }

  movClImm(value: number): void {
    this.db(0xb1, value);
  }

  movDhImm(value: number): void {
    this.db(0xb6, value);
  }

  movDlImm(value: number): void {
    this.db(0xb2, value);
  }

  movDiImm(value: number): void {
    this.db(0xbf, value, value >> 8);
  }

  movEsAx(): void {
    this.db(0x8e, 0xc0);
  }

  movDsAx(): void {
    this.db(0x8e, 0xd8);
  }

  movAlMem(label: string): void {
    this.db(0xa0);
    this.abs16(label);
  }

  movMemDl(label: string): void {
    this.db(0x88, 0x16);
    this.abs16(label);
  }

  movDlMem(label: string): void {
    this.db(0x8a, 0x16);
    this.abs16(label);
  }

  xorBxBx(): void {
    this.db(0x31, 0xdb);
  }

  xorDhImm(value: number): void {
    this.db(0x80, 0xf6, value);
  }

  incCl(): void {
    this.db(0xfe, 0xc1);
  }

  incCh(): void {
    this.db(0xfe, 0xc5);
  }

  decDi(): void {
    this.db(0x4f);
  }

  addBxImm(value: number): void {
    this.db(0x81, 0xc3, value, value >> 8);
  }

  cmpClImm(value: number): void {
    this.db(0x80, 0xf9, value);
  }

  int(vector: number): void {
    this.db(0xcd, vector);
  }

  cli(): void {
    this.db(0xfa);
  }

  hlt(): void {
    this.db(0xf4);
  }

  jmpShort(label: string): void {
    this.db(0xeb);
    this.rel8(label);
  }

  jcc(opcode: number, label: string): void {
    this.db(opcode);
    this.rel8(label);
  }

  jmpFar(segment: number, offset: number): void {
    this.db(0xea, offset, offset >> 8, segment, segment >> 8);
  }

  assemble(): Uint8Array {
    for (const fixup of this.fixups) {
      const target = this.labels.get(fixup.label);
      if (target === undefined) throw new Error(`Unknown label '${fixup.label}'`);
      if (fixup.kind === 'abs16') {
        this.bytes[fixup.pos] = target & 0xff;
        this.bytes[fixup.pos + 1] = (target >> 8) & 0xff;
        continue;
      }
      const relative = target - (this.org + fixup.pos + 1);
      if (relative < -128 || relative > 127) {
        throw new Error(`Short jump to '${fixup.label}' is out of range (${relative})`);
      }
      this.bytes[fixup.pos] = relative & 0xff;
    }
    return Uint8Array.from(this.bytes);
  }
}

export function buildBootSector(): Uint8Array {
  const c = new Code(0x7c00);

  // Labels are absolute 0x7c00 offsets, so DS must be zero.
  c.movAxImm(0x0000);
  c.movDsAx();
  c.movAxImm(0x1000);
  c.movEsAx();
  c.xorBxBx();
  c.movMemDl('drive');
  c.movChImm(0);
  c.movClImm(2);
  c.movDhImm(0);
  c.movDiImm(SECTORS_TO_LOAD);

  c.label('readLoop');
  c.movDlMem('drive');
  c.movAxImm(0x0201);
  c.int(0x13);
  c.jcc(0x72, 'fail');
  c.addBxImm(0x0200);
  c.incCl();
  c.cmpClImm(19);
  c.jcc(0x75, 'noWrap');
  c.movClImm(1);
  c.xorDhImm(1);
  c.jcc(0x75, 'noWrap');
  c.incCh();
  c.label('noWrap');
  c.decDi();
  c.jcc(0x75, 'readLoop');
  c.jmpFar(0x1000, KERNEL_OFFSET);

  c.label('fail');
  c.movAhImm(0x0e);
  c.movAlImm('!'.charCodeAt(0));
  c.int(0x10);
  c.cli();
  c.label('failHalt');
  c.hlt();
  c.jmpShort('failHalt');

  c.label('drive');
  c.db(0);

  const code = c.assemble();
  if (code.length > BOOT_SECTOR_SIZE - 2) {
    throw new Error(`Boot sector overflow: ${code.length} bytes`);
  }

  const sector = new Uint8Array(BOOT_SECTOR_SIZE);
  sector.set(code, 0);
  sector[510] = 0x55;
  sector[511] = 0xaa;
  return sector;
}

export interface ImageLayout {
  image: Uint8Array;
  bootBytes: number;
  kernelBytes: number;
  codeBytes: number;
  stringBytes: number;
  methodCount: number;
  globalCount: number;
  sectorCount: number;
}

function writeWord(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
}

export function buildImage(compiled: CompiledProgram): ImageLayout {
  const kernel = assemble(KERNEL_SOURCE, KERNEL_ORIGIN).bytes;
  if (kernel.length > CODE_START - KERNEL_OFFSET) {
    throw new Error(`Kernel is ${kernel.length} bytes but only ${CODE_START - KERNEL_OFFSET} fit`);
  }
  if (compiled.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    throw new Error('Cannot link a program with compile errors');
  }
  if (compiled.methods.length === 0) throw new Error('Cannot link a program with no methods');
  if (compiled.entryIndex < 0) throw new Error('Cannot link a program without Main()');
  if (compiled.methods.length > 124) throw new Error('Too many methods for the header method table');

  const boot = buildBootSector();
  const data = new Uint8Array(PAYLOAD_BYTES);

  data[0] = 'S'.charCodeAt(0);
  data[1] = 'B'.charCodeAt(0);
  data[2] = 2;
  data[3] = 0;
  writeWord(data, 0x0004, compiled.entryIndex);
  writeWord(data, 0x0006, compiled.methods.length);
  writeWord(data, 0x0008, CODE_START);
  writeWord(data, 0x000a, CODE_START + compiled.code.length);
  writeWord(data, 0x000c, compiled.globalCount);
  writeWord(data, 0x000e, STRING_START);

  compiled.methods.forEach((method, index) => {
    writeWord(data, 0x0010 + index * 4, method.codeOffset);
    writeWord(data, 0x0012 + index * 4, method.locals);
  });

  if (kernel.length + KERNEL_OFFSET > data.length) throw new Error('Kernel does not fit in the payload');
  data.set(kernel, KERNEL_OFFSET);

  if (CODE_START + compiled.code.length > data.length) throw new Error('Bytecode does not fit in the payload');
  data.set(compiled.code, CODE_START);

  if (STRING_START + compiled.strings.length > data.length) throw new Error('Static strings do not fit in the payload');
  data.set(compiled.strings, STRING_START);

  const image = new Uint8Array(IMAGE_SIZE);
  image.set(boot, 0);
  image.set(data, BOOT_SECTOR_SIZE);

  return {
    image,
    bootBytes: boot.length,
    kernelBytes: kernel.length,
    codeBytes: compiled.code.length,
    stringBytes: compiled.strings.length,
    methodCount: compiled.methods.length,
    globalCount: compiled.globalCount,
    sectorCount: SECTORS_TO_LOAD,
  };
}

export function describeLayout(layout: ImageLayout): { label: string; value: string }[] {
  return [
    { label: 'boot sector', value: '512 B @ 0x7c00' },
    { label: 'kernel', value: `${layout.kernelBytes} B @ 0x1000:0200` },
    { label: 'bytecode', value: `${layout.codeBytes} B · ${layout.methodCount} methods` },
    { label: 'static strings', value: `${layout.stringBytes} B @ 0x1000:${STRING_START.toString(16).padStart(4, '0')}` },
    { label: 'image', value: `1.44 MB · ${layout.sectorCount} sectors read` },
  ];
}
