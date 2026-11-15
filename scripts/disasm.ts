import { parse } from '../src/core/parser.ts';
import { compileToBytecode, Op } from '../src/core/compiler.ts';

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
    }
}
`;

const parsed = parse(source);
if (!parsed.program) throw new Error('parse failed');
const compiled = compileToBytecode(parsed.program);
const names = Object.fromEntries(Object.entries(Op).map(([name, value]) => [value, name])) as Record<number, string>;
const wordOps = new Set<number>([
  Op.PUSHI, Op.PUSHS, Op.LOAD, Op.STORE, Op.LOADG, Op.STOREG,
  Op.JMP, Op.JZ, Op.JNZ,
]);
let pc = 0x1800;
while (pc < 0x1800 + compiled.code.length) {
  const offset = pc - 0x1800;
  const op = compiled.code[offset];
  const name = names[op] ?? `?${op}`;
  if (op === Op.CALL) {
    const idx = compiled.code[offset + 1] | (compiled.code[offset + 2] << 8);
    const argc = compiled.code[offset + 3] | (compiled.code[offset + 4] << 8);
    console.log(`${pc.toString(16)}  ${name} ${idx} argc=${argc}`);
    pc += 5;
    continue;
  }
  if (wordOps.has(op)) {
    const value = compiled.code[offset + 1] | (compiled.code[offset + 2] << 8);
    console.log(`${pc.toString(16)}  ${name} ${value.toString(16)}`);
    pc += 3;
    continue;
  }
  console.log(`${pc.toString(16)}  ${name}`);
  pc += 1;
}
console.log('methods', compiled.methods);
