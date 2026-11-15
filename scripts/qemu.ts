/**
 * Boot a generated floppy image in QEMU and verify the VGA mode 13h output.
 *
 * The test image clears the screen and fills a 20x10 rectangle with palette
 * index 28 (pure green in the default 3-3-2 palette). QEMU's monitor takes a
 * screendump of the emulated VGA card; the PPM is parsed here to prove the
 * kernel really reached graphics mode and wrote pixels through A000:0000.
 *
 * QEMU is optional for local development:
 *   node scripts/qemu.ts            # skips when QEMU is not installed
 *   node scripts/qemu.ts --require  # fails when QEMU is not installed
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileProgram } from '../src/core/pipeline.ts';

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
  const source = `using System;

class Program
{
    static void Main()
    {
        Graphics.Init();
        Graphics.Clear(0);
        Graphics.FillRect(10, 10, 20, 10, 28);
    }
}
`;
  const build = compileProgram(source, 'qemu-graphics.cs');
  if (!build.ok || !build.image) {
    throw new Error(`QEMU graphics image failed to build: ${build.diagnostics.map((diag) => diag.message).join('; ')}`);
  }

  const outDir = resolve('.tmp/qemu');
  mkdirSync(outDir, { recursive: true });
  const imagePath = resolve(outDir, 'graphics.img');
  const screenshotPath = resolve(outDir, 'screen.ppm');
  writeFileSync(imagePath, build.image);
  rmSync(screenshotPath, { force: true });

  const proc = spawn(qemu, [
    '-m', '16',
    '-drive', `file=${imagePath},format=raw,if=floppy`,
    '-boot', 'a',
    '-display', 'none',
    '-monitor', 'stdio',
    '-serial', 'none',
    '-no-reboot',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let output = '';
  const collect = (chunk: Buffer | string): void => {
    output += chunk.toString();
  };
  proc.stdout?.on('data', collect);
  proc.stderr?.on('data', collect);

  let finished = false;
  let attempts = 0;
  let shotTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;

  const finish = (ok: boolean, detail: string): void => {
    if (finished) return;
    finished = true;
    if (shotTimer) clearTimeout(shotTimer);
    if (pollTimer) clearInterval(pollTimer);
    proc.kill('SIGKILL');
    if (ok) {
      console.log(`QEMU boot check passed: ${detail}`);
    } else {
      console.error(`QEMU boot check failed: ${detail}`);
      console.error('--- QEMU output ---');
      console.error(output.slice(-3000));
      process.exitCode = 1;
    }
  };

  const takeShot = (): void => {
    if (finished) return;
    if (!proc.stdin?.writable) return;
    proc.stdin.write(`screendump ${screenshotPath}\n`);
  };

  const readGreenPixels = (): number | null => {
    if (!existsSync(screenshotPath)) return null;
    let data: Buffer;
    try {
      data = readFileSync(screenshotPath);
    } catch {
      return null;
    }
    const header = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(data.toString('latin1', 0, 64));
    if (!header) return null;
    const width = Number(header[1]);
    const height = Number(header[2]);
    const offset = header[0].length;
    let green = 0;
    for (let index = 0; index < width * height; index++) {
      const pixel = offset + index * 3;
      if (pixel + 2 >= data.length) break;
      if (data[pixel] < 80 && data[pixel + 1] > 160 && data[pixel + 2] < 80) green++;
    }
    return green;
  };

  proc.on('error', (error) => finish(false, `QEMU could not start: ${error.message}`));
  proc.on('close', (code) => {
    if (!finished) finish(false, `QEMU exited before a valid screendump (code ${code ?? 'unknown'})`);
  });

  shotTimer = setTimeout(() => {
    takeShot();
    pollTimer = setInterval(() => {
      attempts++;
      const green = readGreenPixels();
      if (green !== null && green > 100) {
        finish(true, `screendump contains ${green} green pixels from A000:0000`);
        return;
      }
      if (attempts >= 8) {
        finish(false, 'VGA screendump did not contain the expected green rectangle');
        return;
      }
      takeShot();
    }, 900);
  }, 2500);
}
