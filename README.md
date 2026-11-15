# SharpBoot

C# source → bootable 16-bit x86 image.

**Live site:** https://12leocheung.github.io/sharpboot/

SharpBoot takes a C# file, repairs what it can, reports what it cannot, compiles the source to a compact bytecode, and links a real 1.44 MB floppy image. The image contains a hand-written boot sector, a real-mode x86 kernel and the program bytecode. It runs without COSMOS or the .NET runtime.

Loops, variables, methods, arrays, `ReadLine`, `ReadKey`, VGA text output and VGA mode 13h graphics all execute on the image. The browser console runs the same bytecode in a live virtual machine and renders its VGA text screen or `A000:0000` framebuffer.

## Arrays and memory

```csharp
int[] scores = new int[6];
scores[0] = 10;
string[] names = new string[3];
names[0] = "Ada";
Console.WriteLine(scores.Length + " " + names[0]);
```

`int[]`, `string[]` and `bool[]` are tagged heap blocks with a count word, bounds-checked `AGET`/`ASET` access and `.Length`. The bare-metal heap (`0x8000-0xF000`) has a free-list allocator with split/coalesce and a conservative mark/sweep collector; strings and arrays use the same blocks, so long-running allocation loops reuse memory instead of leaking.

## Graphics API

```csharp
Graphics.Init();
Graphics.Clear(Graphics.Rgb(4, 10, 30));
Graphics.FillRect(20, 20, 120, 60, Graphics.Rgb(20, 210, 160));
Graphics.Line(0, 199, 319, 0, Graphics.Rgb(255, 110, 40));
Graphics.FillCircle(235, 106, 54, Graphics.Rgb(255, 70, 120));

for (int i = 1; i < 16; i++)
{
    Graphics.SetPalette(i, i * 16, 210, 255 - i * 14);
}
string ship = "..1111.." + ".111111." + "11111111" + "11122111"
    + "11111111" + ".111111." + "..1..1.." + "..1..1..";
Graphics.Sprite(24, 108, ship, 8, 8);
Graphics.Text(24, 128, "SHARPBOOT SPRITE + BITMAP TEXT", 15);
Graphics.End();
```

Available calls: `Init`, `End`, `Rgb`, `Width`, `Height`, `Clear`, `SetPixel`, `FillRect`, `Rect`, `Line`, `FillCircle`, `Circle`, `SetPalette`, `Sprite`, `Text`.

`Sprite` takes a string of rows where space and `.` are transparent and `0-9`/`A-F` select palette entries 0-15. `Text` uses the built-in 8x8 bitmap font and accepts an 8-bit palette index.

Mode 13h is 320×200 with 256 colors and a 3-3-2 RGB palette. Coordinates start at the top-left. Text output is suppressed while graphics mode is active, so call `Graphics.End()` before printing. The full guide is on the [live site](https://12leocheung.github.io/sharpboot/#graphics-guide).

## Development

```bash
npm install
npm run dev
npm run build
npm test
```

`npm test` boots generated floppy images on the bundled 8086 emulator and compares VGA text and graphics output with the browser VM.

`npm run test:qemu` boots a generated image in QEMU and reads the BIOS console through the serial graphics adapter. It skips when QEMU is not installed; `npm run test:qemu -- --require` makes it fail instead.

`npm run build:pages` builds the site with the `/sharpboot/` base path for GitHub Pages.

The GitHub Actions workflow runs the smoke test, the QEMU check and the Pages build, then deploys `dist` to GitHub Pages on pushes to `main`.

## Layout

- `src/core/` — repair engine, lexer, parser, compiler, bytecode VM, assembler, kernel and boot-image linker
- `src/core/kernel.ts` — the real-mode x86 kernel, including VGA graphics routines
- `scripts/x86.ts` — BIOS/8086 emulator used by the bare-metal smoke test
- `scripts/smoke.ts` — boot, keyboard, array/heap, text and framebuffer checks
- `scripts/qemu.ts` — optional external QEMU boot check over serial
- `index.html` / `src/main.ts` — the converter and live console
