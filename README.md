# SharpBoot

C# source → bootable 16-bit x86 image.

**Live site:** https://12leocheung.github.io/sharpboot/

SharpBoot takes a C# file, repairs what it can, reports what it cannot, compiles the source to a compact bytecode, and links a real 1.44 MB floppy image. The image contains a hand-written boot sector, a real-mode x86 kernel and the program bytecode. It runs without COSMOS or the .NET runtime.

Loops, variables, methods, arrays, generic collections, `ReadLine`, `ReadKey`, VGA text output and VGA mode 13h graphics all execute on the image. The browser console runs the same bytecode in a live virtual machine and renders its VGA text screen or `A000:0000` framebuffer.

## Arrays and memory

```csharp
int[] scores = new int[] { 10, 20, 30 };
int total = 0;
foreach (int score in scores)
{
    total += score;
}
string[] names = new string[3];
names[0] = "Ada";
string[] copy = new string[3];
Array.Copy(names, 0, copy, 0, 3);
Console.WriteLine(total + " " + copy[0]);
```

`int[]`, `string[]` and `bool[]` are tagged heap blocks with a count word, bounds-checked `AGET`/`ASET` access and `.Length`. `foreach` walks an array without an index, and `Array.Copy(source, sourceIndex, destination, destinationIndex, count)` copies elements in place. `double[]` maps to `int[]` and `char[]` maps to `string[]` because bare-metal SharpBoot uses integer and string values only.

The bare-metal heap (`0x8000-0xF000`) has a free-list allocator with split/coalesce and a conservative mark/sweep collector; strings, arrays and collections use the same blocks, so long-running allocation loops reuse memory instead of leaking.

## Generic collections

```csharp
using System.Collections.Generic;

List<string> names = new List<string>();
names.Add("Ada");
names.Add("Linus");
names.RemoveAt(0);
Console.WriteLine(names.Count + " " + names[0]);

Dictionary<string,int> ages = new Dictionary<string,int>();
ages["Ada"] = 36;
ages["Ada"] = ages["Ada"] + 1;
Console.WriteLine(ages["Ada"] + " " + ages.ContainsKey("Ada"));

Queue<int> queue = new Queue<int>();
queue.Enqueue(1);
Stack<int> stack = new Stack<int>();
stack.Push(10);
```

`List<T>` supports `Add`, `RemoveAt`, `Clear`, `Contains`, `IndexOf`, `.Count`, `list[i]` and `foreach`. `Queue<T>` supports `Enqueue`, `Dequeue`, `Peek`, `Clear`, `Contains` and `.Count`; `Stack<T>` uses `Push`, `Pop` and `Peek` with the same backing store. `Dictionary<K,V>` stores entries in insertion order with linear key lookup and supports `Add`, `dict[key]`, `ContainsKey`, `Remove`, `Clear` and `.Count`. Reading a missing key is a runtime fault, like indexing outside an array.

Element types are `int`, `string` and `bool`; `double` maps to `int` and `char` maps to `string`, just like arrays. Dictionary keys must be scalar values. Collection objects and their backing arrays are heap blocks marked by the same GC, so lists and dictionaries can outlive helper calls and survive allocation pressure. `TryGetValue`, `IEnumerable<T>` and nested generic type arguments are not part of this subset.

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

Available calls: `Init`, `End`, `BeginBuffer`, `Present`, `EndBuffer`, `Rgb`, `Width`, `Height`, `Clear`, `SetPixel`, `FillRect`, `Rect`, `Line`, `FillCircle`, `Circle`, `SetPalette`, `PalettePreset`, `Sprite`, `SpriteScaled`, `SpriteRotate`, `Text`, `SetFont`.

`Sprite` takes a string of rows where space and `.` are transparent and `0-9`/`A-F` select palette entries 0-15. `SpriteScaled(x, y, rows, w, h, scale)` repeats each source pixel into a `scale × scale` block; `SpriteRotate(x, y, rows, w, h, quarterTurns)` rotates in 90° steps. `Text` uses the built-in 8x8 bitmap font (ASCII 32-126, including lowercase) and accepts an 8-bit palette index. `SetFont` accepts a 760-character table of 95 glyphs to replace that font.

`BeginBuffer()` switches drawing to an off-screen buffer at `2000:0000`; `Present()` copies it to the visible `A000:0000` framebuffer in one pass; `EndBuffer()` returns to direct drawing. `PalettePreset(0|1|2)` selects the default 3-3-2, grayscale or sunset palette.

Mode 13h is 320×200 with 256 colors and a 3-3-2 RGB palette. Coordinates start at the top-left. Text output is suppressed while graphics mode is active, so call `Graphics.End()` before printing. The full guide is on the [live site](https://12leocheung.github.io/sharpboot/#graphics-guide).

## Releases

Pushing a `v*` tag builds `sharpboot.img` and `SHA256SUMS` and attaches both to a GitHub release.

```bash
npm run release:image
```

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
- `scripts/smoke.ts` — boot, keyboard, array/collection/heap, text and framebuffer checks
- `scripts/qemu.ts` — optional external QEMU boot check over serial
- `index.html` / `src/main.ts` — the converter and live console
