/**
 * Boot the generated floppy image in QEMU and check the BIOS console over the
 * serial graphics adapter. This is the external-check counterpart to the
 * bundled 8086 emulator in scripts/x86.ts.
 *
 * QEMU is optional for local development:
 *   node scripts/qemu.ts            # skips when QEMU is not installed
 *   node scripts/qemu.ts --require  # fails when QEMU is not installed
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileProgram } from '../src/core/pipeline.ts';
import { SAMPLES } from '../src/core/samples.ts';

const requireQemu = process.argv.includes('--require');
const candidates = process.platform === 'win32'
  ? ['qemu-system-i386.exe', 'qemu-system-i386', 'qemu-system-x86_64.exe', 'qemu-system-x86_64']
  : ['qemu-system-i386', 'qemu-system-x86_64'];

const qemu = candidates.find((candidate) => {
  const probe = spawnSync(candidate, ['-version'], { encoding: 'utf8' });
  return probe.status === 0;
});

if (!qemu) {
  const message = 'QEMU was not found; skipping the external boot check.';
  if (requireQemu) {
    console.error(message);
    process.exitCode = 1;
  } else {
    console.log(message);
  }
} else {
  const sample = SAMPLES.find((entry) => entry.id === 'fizzbuzz');
  if (!sample) throw new Error('fizzbuzz sample is missing');
  const build = compileProgram(sample.source, sample.filename);
  if (!build.ok || !build.image) {
    throw new Error(`fizzbuzz failed to build: ${build.diagnostics.map((diag) => diag.message).join('; ')}`);
  }

  const outDir = resolve('.tmp/qemu');
  mkdirSync(outDir, { recursive: true });
  const imagePath = resolve(outDir, 'sharpboot.img');
  writeFileSync(imagePath, build.image);

  const proc = spawn(qemu, [
    '-m', '16',
    '-drive', `file=${imagePath},format=raw,if=floppy`,
    '-boot', 'a',
    '-display', 'none',
    '-device', 'sga',
    '-serial', 'stdio',
    '-monitor', 'none',
    '-no-reboot',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let output = '';
  const collect = (chunk: Buffer | string): void => {
    output += chunk.toString();
  };
  proc.stdout?.on('data', collect);
  proc.stderr?.on('data', collect);

  const timer = setTimeout(() => {
    proc.kill('SIGKILL');
  }, 12_000);

  proc.on('error', (error) => {
    clearTimeout(timer);
    console.error(`QEMU could not start: ${error.message}`);
    process.exitCode = 1;
  });

  proc.on('close', () => {
    clearTimeout(timer);
    const sawBanner = output.includes('SharpBoot 2.0');
    const sawProgram = output.includes('FizzBuzz') && output.includes('[program halted]');
    if (sawBanner && sawProgram) {
      console.log('QEMU boot check passed: serial BIOS console showed SharpBoot and the FizzBuzz program.');
      return;
    }
    console.error('QEMU boot check failed.');
    if (!sawBanner) console.error('  missing SharpBoot banner');
    if (!sawProgram) console.error('  missing FizzBuzz output or [program halted]');
    console.error('--- serial output ---');
    console.error(output.slice(-4000));
    process.exitCode = 1;
  });
}
