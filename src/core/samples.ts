export interface Sample {
  id: string;
  label: string;
  hint: string;
  filename: string;
  source: string;
}

export const SAMPLES: Sample[] = [
  {
    id: 'hello',
    label: 'Interactive boot',
    hint: 'loops, a helper method, ReadLine and ReadKey',
    filename: 'interactive.cs',
    source: `using System;

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
`,
  },
  {
    id: 'graphics',
    label: 'Graphics demo',
    hint: 'palette, sprites, bitmap text and ReadKey',
    filename: 'graphics.cs',
    source: `using System;

class Program
{
    static void Main()
    {
        Graphics.Init();
        Graphics.Clear(Graphics.Rgb(4, 10, 30));

        for (int band = 0; band < 8; band++)
        {
            Graphics.FillRect(0, band * 25, 320, 25, Graphics.Rgb(band * 32, 90, 255 - band * 32));
        }

        Graphics.FillRect(18, 18, 118, 62, Graphics.Rgb(20, 210, 160));
        Graphics.Rect(18, 18, 118, 62, Graphics.Rgb(255, 255, 255));
        Graphics.Line(0, 199, 319, 0, Graphics.Rgb(255, 110, 40));
        Graphics.Line(0, 0, 319, 199, Graphics.Rgb(70, 120, 255));
        Graphics.FillCircle(235, 106, 54, Graphics.Rgb(255, 70, 120));
        Graphics.Circle(235, 106, 72, Graphics.Rgb(255, 255, 255));
        Graphics.SetPixel(160, 100, 255);

        for (int i = 1; i < 16; i++)
        {
            Graphics.SetPalette(i, i * 16, 210, 255 - i * 14);
        }

        string ship = "..1111.." + ".111111." + "11111111" + "11122111"
            + "11111111" + ".111111." + "..1..1.." + "..1..1..";
        Graphics.Sprite(24, 108, ship, 8, 8);
        Graphics.Text(24, 128, "SHARPBOOT SPRITE + BITMAP TEXT", 15);

        int key = Console.ReadKey().KeyChar;
        Graphics.End();
        Console.WriteLine("graphics demo complete, key=" + key);
    }
}
`,
  },
  {
    id: 'graphics2',
    label: 'Buffered graphics',
    hint: 'double buffer, palette preset, scaled and rotated sprites',
    filename: 'buffered-graphics.cs',
    source: `using System;

class Program
{
    static void Main()
    {
        Graphics.Init();
        Graphics.BeginBuffer();
        Graphics.PalettePreset(2);
        Graphics.Clear(0);

        string ship = "..1111.." + ".111111." + "11111111" + "11122111"
            + "11111111" + ".111111." + "..1..1.." + "..1..1..";
        Graphics.SpriteScaled(24, 26, ship, 8, 8, 4);
        Graphics.SpriteRotate(160, 26, ship, 8, 8, 1);
        Graphics.Text(24, 100, "lowercase bitmap font in a double buffer", 15);

        Graphics.Present();
        int key = Console.ReadKey().KeyChar;
        Graphics.EndBuffer();
        Graphics.End();
        Console.WriteLine("buffered graphics complete, key=" + key);
    }
}
`,
  },
  {
    id: 'arrays',
    label: 'Arrays + GC',
    hint: 'initializers, foreach, Length, helper methods and heap reuse',
    filename: 'arrays.cs',
    source: `using System;

class Program
{
    static int Sum(int[] values)
    {
        int total = 0;
        foreach (int value in values)
        {
            total += value;
        }
        return total;
    }

    static void Main()
    {
        int[] scores = new int[] { 10, 20, 30, 40, 50, 60 };

        string[] names = new string[3];
        names[0] = "Ada";
        names[1] = "Grace";
        names[2] = "Linus";

        Console.WriteLine("scores total=" + Sum(scores));
        Console.WriteLine("scores length=" + scores.Length);
        Console.WriteLine("first=" + names[0]);
        Console.WriteLine("last=" + names[2]);

        for (int round = 0; round < 64; round++)
        {
            int[] block = new int[160];
            block[0] = round;
            block[159] = round;
            if (block[0] != block[159]) Console.WriteLine("heap check failed");
        }
        Console.WriteLine("heap reuse ok");
    }
}
`,
  },
  {
    id: 'fizzbuzz',
    label: 'FizzBuzz',
    hint: 'if/else chains and modulo arithmetic',
    filename: 'fizzbuzz.cs',
    source: `using System;

class Program
{
    static void Main()
    {
        Console.WriteLine("FizzBuzz, running on bare metal");
        Console.WriteLine("---------------------------------");

        for (int i = 1; i <= 24; i++)
        {
            if (i % 15 == 0) Console.WriteLine("FizzBuzz");
            else if (i % 3 == 0) Console.WriteLine("Fizz");
            else if (i % 5 == 0) Console.WriteLine("Buzz");
            else Console.WriteLine(i.ToString());
        }
    }
}
`,
  },
  {
    id: 'keys',
    label: 'Key echo',
    hint: 'ReadKey inside a while loop',
    filename: 'key-echo.cs',
    source: `using System;

class Program
{
    static void Main()
    {
        Console.WriteLine("key echo - press q (code 113) to quit");

        int count = 0;
        while (true)
        {
            Console.Write("key> ");
            int key = Console.ReadKey().KeyChar;
            Console.WriteLine();

            if (key == 113) break;

            count++;
            Console.WriteLine("code=" + key + " count=" + count);
        }

        Console.WriteLine("keys=" + count);
    }
}
`,
  },
  {
    id: 'repair',
    label: 'Repair demo',
    hint: 'deliberately broken — watch the engine fix it',
    filename: 'repair-demo.cs',
    source: `using System

class program
{
    static void main()
    {
        int total = 0
        int i = 1

        while (i <= 10)
        {
            total += i
            i++
        }

        console.writeline("Sum 1..10  = " + total)
        console.writeline("Average    = " + (total / 10))
        console.writeline("Divide by 0 = " + (total / (i - 11)))
    }
}
`,
  },
];

export const DEFAULT_SAMPLE = SAMPLES[0];
