import { parse } from '../src/core/parser.ts';
import { compileToBytecode } from '../src/core/compiler.ts';
import { BytecodeVm } from '../src/core/vm.ts';

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
if (!parsed.program) {
  console.error(parsed.error);
  process.exit(1);
}
const compiled = compileToBytecode(parsed.program);
console.log('diagnostics', JSON.stringify(compiled.diagnostics, null, 2));
console.log('stats', compiled.stats);
console.log('methods', compiled.methods.map((m) => `${m.name} @${m.codeOffset.toString(16)} locals=${m.locals} ret=${m.returnType}`));

const vm = new BytecodeVm(compiled);
console.log('state1', vm.run());
for (const row of screenRows(vm.screenCells())) if (row.trim()) console.log('|' + row.replace(/\s+$/, ''));
vm.feedLine('Ada');
console.log('state2', vm.run());
vm.feedLine('Z');
console.log('state3', vm.run());
for (const row of screenRows(vm.screenCells())) if (row.trim()) console.log('|' + row.replace(/\s+$/, ''));

function screenRows(cells: { ch: string }[]): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 25; r++) {
    let line = '';
    for (let c = 0; c < 80; c++) line += cells[r * 80 + c].ch;
    rows.push(line);
  }
  return rows;
}
