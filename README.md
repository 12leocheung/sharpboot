# SharpBoot

C# source → bootable 16-bit x86 image.

**Live site:** https://12leocheung.github.io/sharpboot/

SharpBoot takes a C# file, repairs what it can, reports what it cannot, compiles the source to a compact bytecode, and links a real 1.44 MB floppy image. The image contains a hand-written boot sector, a real-mode x86 kernel and the program bytecode. It runs without COSMOS or the .NET runtime.

Loops, variables, methods, `ReadLine`, `ReadKey`, VGA text output and VGA mode 13h graphics all execute on the image. The browser console runs the same bytecode in a live virtual machine and renders its VGA text screen or `A000:0000` framebuffer.

## Graphics API

```csharp
Graphics.Init();
Graphics.Clear(Graphics.Rgb(4, 10, 30));
Graphics.FillRect(20, 20, 120, 60, Graphics.Rgb(20, 210, 160));
Graphics.Line(0, 199, 319, 0, Graphics.Rgb(255, 110, 40));
Graphics.FillCircle(235, 106, 54, Graphics.Rgb(255, 70, 120));
Graphics.End();
```

Available calls: `Init`, `End`, `Rgb`, `Width`, `Height`, `Clear`, `SetPixel`, `FillRect`, `Rect`, `Line`, `FillCircle`, `Circle`.

Mode 13h is 320×200 with 256 colors and a 3-3-2 RGB palette. Coordinates start at the top-left. Text output is suppressed while graphics mode is active, so call `Graphics.End()` before printing. The full guide is on the [live site](https://12leocheung.github.io/sharpboot/#graphics-guide).

## Development

```bash
npm install
npm run dev
npm run build
npm test
```

`npm test` boots generated floppy images on the bundled 8086 emulator and compares VGA text and graphics output with the browser VM.

`npm run build:pages` builds the site with the `/sharpboot/` base path for GitHub Pages.

## Layout

- `src/core/` — repair engine, lexer, parser, compiler, bytecode VM, assembler, kernel and boot-image linker
- `src/core/kernel.ts` — the real-mode x86 kernel, including VGA graphics routines
- `scripts/x86.ts` — BIOS/8086 emulator used by the bare-metal smoke test
- `scripts/smoke.ts` — boot, keyboard, text and framebuffer checks
- `index.html` / `src/main.ts` — the converter and live console
