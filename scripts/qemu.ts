/**
 * Boot a generated floppy image in QEMU and verify the VGA mode 13h output.
 *
 * The test image clears the screen and fills a 20x10 rectangle with palette
 * index 28 (pure green in the default 3-3-2 palette). QEMU's monitor takes a
 * screendump of the emulated VGA card; the PPM is parsed here to prove the
 * kernel really reached graphics mode and wrote pixels through A000:0000.
 * It then sends keys and dumps VGA text memory to prove ReadKey and text output
 * also work outside the browser VM.
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
        Console.ReadKey();
        Graphics.End();
        Console.WriteLine("QEMU text ready");
        int key = Console.ReadKey();
        Console.WriteLine("key=" + key);
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
  let textPhase = false;

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
    if (finished || textPhase) return;
    if (!proc.stdin?.writable) return;
    proc.stdin.write(`screendump ${screenshotPath}\n`);
  };

  const sendMonitor = (command: string): void => {
    if (finished || !proc.stdin?.writable) return;
    proc.stdin.write(`${command}\n`);
  };

  const textDump = (): string => {
    const chars: number[] = [];
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s*[0-9a-fA-F]+:\s*(.*)$/.exec(line);
      if (!match) continue;
      const tokens = match[1].trim().split(/\s+/).filter((token) => /^(?:0x)?[0-9a-fA-F]{2}$/.test(token));
      for (let index = 0; index < tokens.length; index += 2) {
        chars.push(parseInt(tokens[index].replace(/^0x/i, ''), 16));
      }
    }
    return String.fromCharCode(...chars);
  };

  const finishTextCheck = (): void => {
    const text = textDump();
    const ready = text.includes('QEMU text ready');
    const key = text.includes('key=98');
    finish(
      ready && key,
      ready && key
        ? 'screendump + VGA text memory and sendkey input checks passed'
        : `VGA text memory check failed (ready=${ready}, key=${key})`,
    );
  };

  const startTextCheck = (): void => {
    if (finished || textPhase) return;
    textPhase = true;
    if (shotTimer) clearTimeout(shotTimer);
    if (pollTimer) clearInterval(pollTimer);
    sendMonitor('sendkey a');
    setTimeout(() => {
      sendMonitor('sendkey b');
      setTimeout(() => {
        sendMonitor('xp /2000xb 0xb8000');
        setTimeout(finishTextCheck, 1200);
      }, 900);
    }, 900);
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
        startTextCheck();
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
