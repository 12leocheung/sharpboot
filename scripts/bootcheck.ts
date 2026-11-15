import { parse } from '../src/core/parser.ts';
import { compileToBytecode } from '../src/core/compiler.ts';
import { buildImage } from '../src/core/image.ts';
import { BytecodeVm } from '../src/core/vm.ts';
import { X86, Halted } from './x86.ts';

const source = `
using System;

class Program
{
    static int Twice(int value)
    {
        return value * 2;
    }

    static void Main(string[] args)
    {
        Console.WriteLine("hello from bytecode");
        int total = 0;
        for (int i = 1; i <= 5; i++)
        {
            total += i;
        }
        Console.WriteLine("sum=" + total);
        Console.WriteLine("twice=" + Twice(total));
        Console.Write("name? ");
        string name = Console.ReadLine();
        Console.WriteLine("hi " + name);
        Console.Write("key? ");
        int key = Console.ReadKey().KeyChar;
        Console.WriteLine();
        Console.WriteLine("code=" + key);
    }
}
`;

const parsed = parse(source);
if (!parsed.program) throw new Error('parse failed');
const compiled = compileToBytecode(parsed.program);
console.log('diagnostics', compiled.diagnostics);
console.log('code bytes', Array.from(compiled.code).map((b) => b.toString(16).padStart(2, '0')).join(' '));
console.log('methods', compiled.methods);
const layout = buildImage(compiled);
console.log('layout', {
  boot: layout.bootBytes,
  kernel: layout.kernelBytes,
  code: layout.codeBytes,
  strings: layout.stringBytes,
  methods: layout.methodCount,
});

const x86 = new X86(layout.image);
const history: string[] = [];
const vmLog: string[] = [];
const leLog: string[] = [];
const psLog: string[] = [];
const callLog: string[] = [];
const rd16 = (addr: number): number => x86.mem[0x10000 + addr] | (x86.mem[0x10000 + addr + 1] << 8);
const slot = (addr: number): string => `t${x86.mem[0x10000 + addr]}:${rd16(addr + 2)}`;
x86.trace = (cs, ip, op) => {
  if (cs === 0x1000 && ip === 0xb0c) {
    const vsp = rd16(0xd95);
    callLog.push(`CALL m${rd16(x86.regs.si)} argc=${rd16(x86.regs.si + 2)} vsp=${vsp.toString(16)} arg=${slot(vsp)}`);
  }
  if (cs === 0x1000 && ip === 0xbc2) {
    const vsp = rd16(0xd95);
    callLog.push(`RET vsp=${vsp.toString(16)} top=${slot(vsp)} si=${x86.regs.si.toString(16)}`);
  }
  if (cs === 0x1000 && ip === 0xbee) {
    const vsp = rd16(0xd95);
    callLog.push(`TOSTR vsp=${vsp.toString(16)} top=${slot(vsp)}`);
  }
  if (cs === 0x1000 && ip === 0x7d8) {
    const vsp = rd16(0xd95);
    const idx = rd16(x86.regs.si);
    const addr = x86.regs.bp + idx * 4;
    callLog.push(`LOAD${idx} bp=${x86.regs.bp.toString(16)} at=${slot(addr)} vsp=${vsp.toString(16)}`);
  }
  if (cs === 0x1000 && (ip === 0x7e6 || ip === 0x7ea || ip === 0x7ee) && x86.regs.bp === 0x6ff4) {
    callLog.push(`@${ip.toString(16)} bx=${x86.regs.bx.toString(16)} bp=${x86.regs.bp.toString(16)} ds=${x86.regs.ds.toString(16)} dx=${x86.regs.dx} al=${x86.regs.ax & 0xff} raw=${Array.from(x86.mem.slice(0x16ff0, 0x16ff8)).map((v) => v.toString(16)).join(',')}`);
  }
  if (cs === 0x1000 && ip === 0x2b6 && x86.regs.bp === 0x6ff4) {
    callLog.push(`PUSHVAL dx=${x86.regs.dx} al=${x86.regs.ax & 0xff} vsp=${rd16(0xd95).toString(16)} bp=${x86.regs.bp.toString(16)}`);
  }
  if (cs === 0x1000 && ip === 0x7b8) {
    const vsp = rd16(0xd95);
    callLog.push(`PUSHI vsp=${vsp.toString(16)} atvsp=${slot(vsp)} next=${slot(vsp - 4)}`);
  }
  if (cs === 0x1000 && ip === 0x898) {
    const vsp = rd16(0xd95);
    callLog.push(`MUL vsp=${vsp.toString(16)} rhs=${slot(vsp)} lhs=${slot(vsp + 4)}`);
  }
  if (cs === 0x1000 && ip === 0x414) {
    const base = 0x1000 * 16;
    const di = x86.regs.di;
    const len = x86.mem[base + di] | (x86.mem[base + di + 1] << 8);
    let sample = '';
    for (let k = 0; k < 12 && k < len; k++) sample += String.fromCharCode(x86.mem[base + di + 2 + k] || 32);
    psLog.push(`len=${len}@${di.toString(16)}:${JSON.stringify(sample)}`);
  }
  if (cs === 0x1000 && ip === 0x9e1) {
    const base = 0x1000 * 16;
    const vsp = x86.mem[base + 0xd89] | (x86.mem[base + 0xd8a] << 8);
    const top = base + vsp - 4;
    const lhs = x86.mem[top - 4] | (x86.mem[top - 2] << 8);
    const rhs = x86.mem[top] | (x86.mem[top + 2] << 8);
    leLog.push(`[${lhs},${rhs}]vsp=${vsp.toString(16)}`);
  }
  history.push(`${cs.toString(16)}:${ip.toString(16)}:${op.toString(16)}`);
  if (history.length > 3000) history.shift();
  if (cs === 0x1000 && ip === 0x268) {
    const si = x86.regs.si;
    const at = 0x1000 * 16 + si;
    vmLog.push(`si=${si.toString(16)} op=${x86.mem[at].toString(16)}`);
  }
};
for (const ch of 'Ada\rZ') x86.pushKey(ch.charCodeAt(0));
try {
  x86.run();
} catch (err) {
  if (err instanceof Halted) {
    console.log('halted after', x86.steps, 'instructions');
  } else {
    console.log('cpu error', err instanceof Error ? err.message : err);
  }
}
console.log('disk-trace', x86.diskTrace.slice(0, 10), 'count', x86.diskTrace.length);
console.log('boot', Array.from(layout.image.slice(0, 32)).map((b) => b.toString(16).padStart(2, '0')).join(' '));
console.log('trace-first', history.slice(0, 20).join(' '));
const runAt = history.findIndex((entry) => entry.startsWith('1000:268:'));
console.log('run trace', runAt >= 0 ? history.slice(runAt, runAt + 80).join(' ') : 'run not found');
const leAt = history.findIndex((entry) => entry.startsWith('1000:9e1:'));
console.log('le trace', leAt >= 0 ? history.slice(leAt, leAt + 40).join(' ') : 'op_le not visited');
console.log('le values', leLog.slice(0, 16).join(' '), '... last', leLog.slice(-5).join(' '), 'count', leLog.length);
console.log('print-strings', psLog.slice(0, 12).join(' '));
console.log('print-strings-last', psLog.slice(-6).join(' '), 'count', psLog.length);
console.log('call-log', callLog.join(' | '));
console.log('vm-oplog-first', vmLog.slice(0, 40).join(' '));
console.log('vm-oplog-last', vmLog.slice(-40).join(' '));
console.log('trace-last', history.slice(-50).join(' '));
console.log('code@0x11800', Array.from(x86.mem.slice(0x11800, 0x11820)).map((b) => b.toString(16).padStart(2, '0')).join(' '));
const hex = (bytes: Uint8Array): string => Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
console.log('image@1024', hex(layout.image.slice(1024, 1024 + 24)));
console.log('mem@0x10000', hex(x86.mem.slice(0x10000, 0x10000 + 24)));
console.log('mem@0x10200', hex(x86.mem.slice(0x10200, 0x10200 + 24)));
console.log('mem@0x10400', hex(x86.mem.slice(0x10400, 0x10400 + 24)));
console.log('heap', hex(x86.mem.slice(0x18000, 0x18040)));
console.log('kernel-opload', hex(x86.mem.slice(0x107d8, 0x107f4)));
console.log('frame6ff4', hex(x86.mem.slice(0x16ff0, 0x17000)));
const bytes = x86.video();
const cells: { ch: string }[] = [];
for (let i = 0; i < 4000; i += 2) cells.push({ ch: String.fromCharCode(bytes[i]) });
const rows = screenRows(cells);
for (const row of rows) console.log('|' + row.replace(/\s+$/, ''));

const vm = new BytecodeVm(compiled);
vm.run();
vm.feedLine('Ada');
vm.run();
vm.feedKey('Z');
vm.run();
const vmRows = screenRows(vm.screenCells().map((cell) => ({ ch: cell.ch })));
let mismatches = 0;
for (let i = 0; i < 25; i++) {
  if (rows[i].replace(/\s+$/, '') !== vmRows[i].replace(/\s+$/, '')) {
    mismatches++;
    console.log(`row ${i} differs`);
    console.log('  hw:', JSON.stringify(rows[i].replace(/\s+$/, '')));
    console.log('  vm:', JSON.stringify(vmRows[i].replace(/\s+$/, '')));
  }
}
console.log(mismatches === 0 ? 'SCREEN MATCH' : `${mismatches} row mismatch(es)`);

function screenRows(cells: { ch: string }[]): string[] {
  const out: string[] = [];
  for (let r = 0; r < 25; r++) {
    let line = '';
    for (let c = 0; c < 80; c++) line += cells[r * 80 + c].ch;
    out.push(line);
  }
  return out;
}
