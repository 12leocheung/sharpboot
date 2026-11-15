/** Build the downloadable floppy image and its checksum for a tagged release. */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileProgram } from '../src/core/pipeline.ts';

const source = `using System;

class Program
{
    static int Total(int[] values)
    {
        int total = 0;
        foreach (int value in values) total += value;
        return total;
    }

    static void Main()
    {
        int[] values = new int[] { 3, 1, 4, 1, 5 };
        Console.WriteLine("SharpBoot release image");
        Console.WriteLine("total=" + Total(values));
        Console.WriteLine("Press any key to halt.");
        Console.ReadKey();
    }
}
`;

const build = compileProgram(source, 'release.cs');
if (!build.ok || !build.image) {
  throw new Error(`release image failed to build: ${build.diagnostics.map((diag) => diag.message).join('; ')}`);
}

const outDir = resolve('.release');
mkdirSync(outDir, { recursive: true });
const imagePath = resolve(outDir, 'sharpboot.img');
writeFileSync(imagePath, build.image);
const digest = createHash('sha256').update(build.image).digest('hex');
writeFileSync(resolve(outDir, 'SHA256SUMS'), `${digest}  sharpboot.img\n`);
console.log(`release image: ${imagePath}`);
console.log(`sha256: ${digest}`);
console.log(`kernel: ${build.stats.kernelBytes} B · bytecode: ${build.stats.bytecodeBytes} B`);
