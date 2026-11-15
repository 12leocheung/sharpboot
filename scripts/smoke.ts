/**
 * Bare-metal boot test.
 *
 * Builds a real 1.44 MB floppy image, boots it on the 8086 emulator (BIOS int 13h
 * disk reads, int 10h console, int 16h keyboard), feeds keys, and compares the
 * resulting VGA text buffer and mode 13h framebuffer with the TypeScript bytecode VM.
 */

import { compileProgram } from '../src/core/pipeline.ts';
import type { BuildResult } from '../src/core/pipeline.ts';
import { BytecodeVm } from '../src/core/vm.ts';
import type { VmState } from '../src/core/vm.ts';
import { IMAGE_SIZE, SECTORS_TO_LOAD } from '../src/core/image.ts';
import { SAMPLES } from '../src/core/samples.ts';
import { X86, WaitingForKey, Halted } from './x86.ts';

const failures: string[] = [];
const check = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};

interface BootResult {
  cpu: X86;
  state: 'halted' | 'waiting';
}

function boot(result: BuildResult, keys: string): BootResult {
  if (!result.image) throw new Error('no boot image was generated');
  const cpu = new X86(result.image);
  for (const ch of keys) cpu.pushKey(ch.charCodeAt(0));
  try {
    cpu.run();
    return { cpu, state: 'halted' };
  } catch (err) {
    if (err instanceof WaitingForKey) return { cpu, state: 'waiting' };
    if (err instanceof Halted) return { cpu, state: 'halted' };
    throw err;
  }
}

function hardwareRows(cpu: X86): string[] {
  const video = cpu.video();
  const rows: string[] = [];
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 80; col++) {
      line += String.fromCharCode(video[(row * 80 + col) * 2]);
    }
    rows.push(line.replace(/\s+$/, ''));
  }
  return rows;
}

function vmRows(vm: BytecodeVm): string[] {
  const cells = vm.screenCells();
  const rows: string[] = [];
  for (let row = 0; row < 25; row++) {
    rows.push(cells.slice(row * 80, row * 80 + 80).map((cell) => cell.ch).join('').replace(/\s+$/, ''));
  }
  return rows;
}

function runVm(result: BuildResult, lines: string[], keys: string[]): { vm: BytecodeVm; state: VmState } {
  if (!result.compiled) throw new Error('no compiled program');
  const vm = new BytecodeVm(result.compiled);
  let state = vm.run();
  for (const line of lines) {
    vm.feedLine(line);
    state = vm.run();
  }
  for (const key of keys) {
    vm.feedKey(key);
    state = vm.run();
  }
  return { vm, state };
}

function compareGraphics(cpu: X86, vm: BytecodeVm, label: string): void {
  const hardware = cpu.graphics();
  const virtual = vm.graphicsPixels();
  let firstDiff = -1;
  let mismatches = 0;
  for (let index = 0; index < hardware.length; index++) {
    if (hardware[index] !== virtual[index]) {
      if (firstDiff < 0) firstDiff = index;
      mismatches++;
    }
  }
  if (mismatches > 0) {
    const at = firstDiff;
    console.log(`  first pixel difference at (${at % 320}, ${Math.floor(at / 320)}): hw=${hardware[at]} vm=${virtual[at]}`);
  }
  check(
    mismatches === 0,
    `${label}: hardware/VGA framebuffer differs on ${mismatches} pixel(s)`,
  );
  check(cpu.videoMode === 0x13, `${label}: VGA is not in mode 13h`);
  check(vm.graphicsActive(), `${label}: VM is not in graphics mode`);
  console.log(
    `  ${label}: ${mismatches === 0 ? '320x200 framebuffer matches the VM' : `${mismatches} pixel(s) differ`}`,
  );
}

function compareScreens(cpu: X86, vm: BytecodeVm, label: string): void {
  const hardware = hardwareRows(cpu);
  const virtual = vmRows(vm);
  let mismatches = 0;
  for (let row = 0; row < 25; row++) {
    if (hardware[row] !== virtual[row]) {
      mismatches++;
      if (mismatches <= 3) {
        console.log(`  row ${row}:`);
        console.log(`    hw: ${JSON.stringify(hardware[row])}`);
        console.log(`    vm: ${JSON.stringify(virtual[row])}`);
      }
    }
  }
  check(mismatches === 0, `${label}: hardware/VGA screen differs on ${mismatches} row(s)`);
  console.log(`  ${label}: ${mismatches === 0 ? 'VGA screen matches the VM' : `${mismatches} row(s) differ`}`);
}

function screenHas(cpu: X86, text: string): boolean {
  return hardwareRows(cpu).some((row) => row.includes(text));
}

console.log('=== boot image structure ===');
const interactive = compileProgram(SAMPLES[0].source, SAMPLES[0].filename);
check(interactive.ok, `interactive sample failed to build: ${interactive.diagnostics.map((d) => d.message).join('; ')}`);
check((interactive.image?.length ?? 0) === IMAGE_SIZE, 'boot image is not 1.44 MB');
check(interactive.image?.[510] === 0x55 && interactive.image?.[511] === 0xaa, 'boot signature is missing');
check((interactive.stats.kernelBytes ?? 0) > 0, 'kernel was not assembled');
check((interactive.stats.kernelBytes ?? 0) < 11776, 'kernel overflows its 0x0200-0x2fff slot');
check(interactive.stats.sectorCount === SECTORS_TO_LOAD, 'boot sector does not load the expected payload');
console.log(
  `  image ${interactive.image?.length ?? 0} B · kernel ${interactive.stats.kernelBytes} B · bytecode ${interactive.stats.bytecodeBytes} B · ${interactive.stats.methods} methods`,
);

console.log('\n=== interactive program on bare metal ===');
if (interactive.image && interactive.compiled) {
  const hw = boot(interactive, 'Ada\rZ');
  check(hw.state === 'halted', 'interactive: program did not halt after keyboard input');
  const expected = [
    'hello from bytecode',
    'sum=15',
    'twice=30',
    'name? Ada',
    'hi Ada',
    'key? Z',
    'code=90',
    '[program halted]',
  ];
  for (const line of expected) {
    check(screenHas(hw.cpu, line), `interactive: missing hardware output "${line}"`);
  }
  const vm = runVm(interactive, ['Ada'], ['Z']);
  check(vm.state === 'halted', `interactive: VM ended in ${vm.state}`);
  compareScreens(hw.cpu, vm.vm, 'interactive');
  console.log('  keys fed: Ada\\r then Z');
}

console.log('\n=== loop + line input on bare metal ===');
const lineLoopSource = `using System;

class Program
{
    static void Main()
    {
        Console.WriteLine("line counter");
        int lines = 0;
        while (true)
        {
            Console.Write("> ");
            string line = Console.ReadLine();
            if (line == "quit") break;
            lines++;
            Console.WriteLine("got " + line);
        }
        Console.WriteLine("lines=" + lines);
    }
}
`;
const lineLoop = compileProgram(lineLoopSource, 'line-loop.cs');
check(lineLoop.ok, `line loop failed to build: ${lineLoop.diagnostics.map((d) => d.message).join('; ')}`);
if (lineLoop.image && lineLoop.compiled) {
  const hw = boot(lineLoop, 'one\rtwo\rquit\r');
  check(hw.state === 'halted', 'line loop did not halt after quit');
  check(screenHas(hw.cpu, 'got one'), 'line loop: first line was not processed');
  check(screenHas(hw.cpu, 'got two'), 'line loop: second line was not processed');
  check(screenHas(hw.cpu, 'lines=2'), 'line loop: loop variable is wrong');
  const vm = runVm(lineLoop, ['one', 'two', 'quit'], []);
  check(vm.state === 'halted', `line loop VM ended in ${vm.state}`);
  compareScreens(hw.cpu, vm.vm, 'line loop');
}

console.log('\n=== graphics mode 13h on bare metal ===');
const graphicsSample = SAMPLES.find((sample) => sample.id === 'graphics');
check(Boolean(graphicsSample), 'graphics sample is missing');
if (graphicsSample) {
  const graphics = compileProgram(graphicsSample.source, graphicsSample.filename);
  check(graphics.ok, `graphics sample failed to build: ${graphics.diagnostics.map((d) => d.message).join('; ')}`);
  if (graphics.image && graphics.compiled) {
    const hw = boot(graphics, '');
    check(hw.state === 'waiting', 'graphics: program did not wait for a key');
    const vm = new BytecodeVm(graphics.compiled);
    let vmState = vm.run();
    check(vmState === 'waiting-key', `graphics: VM ended in ${vmState} instead of waiting for a key`);
    compareGraphics(hw.cpu, vm, 'graphics');

    hw.cpu.pushKey('z'.charCodeAt(0));
    try {
      hw.cpu.run();
    } catch (err) {
      if (!(err instanceof Halted)) throw err;
    }
    vm.feedKey('z');
    vmState = vm.run();
    check(vmState === 'halted', `graphics: VM ended in ${vmState} after the key`);
    check(hw.cpu.videoMode === 0x03, 'graphics: hardware did not return to text mode');
    check(screenHas(hw.cpu, 'graphics demo complete'), 'graphics: hardware did not print the completion line');
    check(screenHas(hw.cpu, 'key=122'), 'graphics: hardware did not read the key');
    compareScreens(hw.cpu, vm, 'graphics after End()');
  }
}

console.log('\n=== arrays and heap reuse on bare metal ===');
const arraysSample = SAMPLES.find((sample) => sample.id === 'arrays');
check(Boolean(arraysSample), 'arrays sample is missing');
if (arraysSample) {
  const arrays = compileProgram(arraysSample.source, arraysSample.filename);
  check(arrays.ok, `arrays sample failed to build: ${arrays.diagnostics.map((d) => d.message).join('; ')}`);
  if (arrays.image && arrays.compiled) {
    const hw = boot(arrays, '');
    check(hw.state === 'halted', 'arrays: program did not halt');
    for (const line of ['scores total=210', 'scores length=6', 'first=Ada', 'last=Linus', 'heap reuse ok']) {
      check(screenHas(hw.cpu, line), `arrays: missing hardware output "${line}"`);
    }
    const vm = runVm(arrays, [], []);
    check(vm.state === 'halted', `arrays: VM ended in ${vm.state}`);
    compareScreens(hw.cpu, vm.vm, 'arrays');
    console.log('  indexed int/string arrays, helper parameter and 40 KB of recycled heap blocks');
  }
}

console.log('\n=== array initializers, foreach and Array.Copy on bare metal ===');
const arrayFeatureSource = `using System;

class Program
{
    static int Sum(int[] values)
    {
        int total = 0;
        foreach (int value in values) total += value;
        return total;
    }

    static void Main()
    {
        int[] numbers = new int[] { 3, 1, 4, 1, 5 };
        Console.WriteLine("total=" + Sum(numbers));
        double[] ratios = new double[] { 1, 2, 3 };
        Console.WriteLine("ratios=" + ratios[0] + ratios[2]);
        char[] letters = new char[] { 'a', 'b', 'c' };
        Console.WriteLine("letters=" + letters[0] + letters[1] + letters[2]);
        string[] copy = new string[3];
        Array.Copy(new string[] { "x", "y", "z" }, 0, copy, 0, 3);
        Console.WriteLine("copy=" + copy[0] + copy[1] + copy[2]);
        int[] dest = new int[4];
        Array.Copy(numbers, 1, dest, 1, 3);
        Console.WriteLine("dest=" + dest[0] + "," + dest[1] + "," + dest[2] + "," + dest[3]);
        string[] shift = new string[] { "a", "b", "c", "" };
        Array.Copy(shift, 0, shift, 1, 3);
        Console.WriteLine("shift=" + shift[0] + shift[1] + shift[2] + shift[3]);
        int sum = 0;
        foreach (int n in numbers)
        {
            if (n == 4) continue;
            sum += n;
        }
        Console.WriteLine("foreach=" + sum);
    }
}
`;
const arrayFeature = compileProgram(arrayFeatureSource, 'array-features.cs');
check(arrayFeature.ok, `array features failed to build: ${arrayFeature.diagnostics.map((d) => d.message).join('; ')}`);
if (arrayFeature.image && arrayFeature.compiled) {
  const hw = boot(arrayFeature, '');
  check(hw.state === 'halted', 'array features did not halt');
  for (const line of ['total=14', 'ratios=13', 'letters=abc', 'copy=xyz', 'dest=0,1,4,1', 'shift=aabc', 'foreach=10']) {
    check(screenHas(hw.cpu, line), `array features: missing hardware output "${line}"`);
  }
  const vm = runVm(arrayFeature, [], []);
  check(vm.state === 'halted', `array features: VM ended in ${vm.state}`);
  compareScreens(hw.cpu, vm.vm, 'array features');
  console.log('  initializers, double[]/char[] aliases, foreach and Array.Copy match the VM');
}

console.log('\n=== buffers, presets, transformed sprites and custom fonts ===');
const customFont = 'A'.repeat(760);
const graphicsFeatureSource = `using System;

class Program
{
    static void Main()
    {
        Graphics.Init();
        Graphics.BeginBuffer();
        Graphics.PalettePreset(2);
        Graphics.Clear(1);
        Graphics.SpriteScaled(10, 10, "0123456789ABCDEF", 4, 4, 3);
        Graphics.SpriteRotate(80, 10, "0123456789ABCDEF", 4, 4, 1);
        Graphics.SetFont("${customFont}");
        Graphics.Text(0, 150, "lowercase abc", 10);
        Graphics.Present();
        Graphics.EndBuffer();
        int key = Console.ReadKey();
        Graphics.End();
        Console.WriteLine("gfx2 key=" + key);
    }
}
`;
const graphicsFeature = compileProgram(graphicsFeatureSource, 'graphics-features.cs');
check(graphicsFeature.ok, `graphics features failed to build: ${graphicsFeature.diagnostics.map((d) => d.message).join('; ')}`);
if (graphicsFeature.image && graphicsFeature.compiled) {
  const hw = boot(graphicsFeature, '');
  check(hw.state === 'waiting', 'graphics features did not wait for a key');
  const vm = new BytecodeVm(graphicsFeature.compiled);
  let vmState = vm.run();
  check(vmState === 'waiting-key', `graphics features: VM ended in ${vmState} instead of waiting for a key`);
  check(vm.palette()[0] === 0 && vm.palette()[1] === 0 && vm.palette()[2] === 255, 'graphics features: sunset palette preset was not applied');
  compareGraphics(hw.cpu, vm, 'graphics features');

  hw.cpu.pushKey('q'.charCodeAt(0));
  try {
    hw.cpu.run();
  } catch (err) {
    if (!(err instanceof Halted)) throw err;
  }
  vm.feedKey('q');
  vmState = vm.run();
  check(vmState === 'halted', `graphics features VM ended in ${vmState}`);
  check(hw.cpu.videoMode === 0x03, 'graphics features: hardware did not return to text mode');
  check(screenHas(hw.cpu, 'gfx2 key=113'), 'graphics features: key was not read');
  compareScreens(hw.cpu, vm, 'graphics features after End()');
  console.log('  double buffer, palette preset, scaled/rotated sprites and SetFont match the VM');
}

console.log('\n=== repair engine still feeds the linker ===');
const repairSample = SAMPLES.find((sample) => sample.id === 'repair');
check(Boolean(repairSample), 'repair sample is missing');
if (repairSample) {
  const repaired = compileProgram(repairSample.source, repairSample.filename);
  const sourceRepairs = repaired.repairs.filter((repair) => repair.phase === 'source').length;
  check(sourceRepairs >= 4, `repair demo: expected source repairs, got ${sourceRepairs}`);
  check(repaired.ok, `repair demo failed after repairs: ${repaired.diagnostics.map((d) => d.message).join('; ')}`);
  if (repaired.image) {
    const hw = boot(repaired, '');
    check(hw.state === 'halted', 'repair demo did not halt');
    check(screenHas(hw.cpu, 'Sum 1..10'), 'repair demo: repaired program did not run');
    check(screenHas(hw.cpu, '[repair] division by zero'), 'repair demo: division-by-zero guard did not run');
    console.log(`  ${sourceRepairs} source repairs · ${repaired.repairs.length} total engine entries · image boots`);
  }
}

console.log('\n=== sample programs still compile ===');
for (const sample of SAMPLES) {
  const built = compileProgram(sample.source, sample.filename);
  check(built.ok, `sample "${sample.id}" failed: ${built.diagnostics.map((d) => d.message).join('; ')}`);
  if (built.ok) console.log(`  ${sample.id}: ok (${built.stats.bytecodeBytes} B bytecode)`);
}

if (failures.length > 0) {
  console.error(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nAll bare-metal checks passed.');
}
