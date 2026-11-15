import type { Repair } from './types.ts';

export const COLORS = {
  black: 0,
  blue: 1,
  green: 2,
  cyan: 3,
  red: 4,
  magenta: 5,
  brown: 6,
  gray: 7,
  lightGray: 7,
  darkGray: 8,
  lightBlue: 9,
  lightGreen: 10,
  lightCyan: 11,
  lightRed: 12,
  lightMagenta: 13,
  yellow: 14,
  white: 15,
};

export const attr = (fg: number, bg: number): number => ((bg & 0x0f) << 4) | (fg & 0x0f);

const CP437_HIGH = [
  'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å',
  'É', 'æ', 'Æ', 'ô', 'ö', 'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ',
  'á', 'í', 'ó', 'ú', 'ñ', 'Ñ', 'ª', 'º', '¿', '⌐', '¬', '½', '¼', '¡', '«', '»',
  '░', '▒', '▓', '│', '┤', '╡', '╢', '╖', '╕', '╣', '║', '╗', '╝', '╜', '╛', '┐',
  '└', '┴', '┬', '├', '─', '┼', '╞', '╟', '╚', '╔', '╩', '╦', '╠', '═', '╬', '╧',
  '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫', '╪', '┘', '┌', '█', '▄', '▌', '▐', '▀',
  'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ', 'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩',
  '≡', '±', '≥', '≤', '⌠', '⌡', '÷', '≈', '°', '∙', '·', '√', 'ⁿ', '²', '■', ' ',
];

const CP437_LOW = [
  '', '☺', '☻', '♥', '♦', '♣', '♠', '•', '◘', '○', '◙', '♂', '♀', '♪', '♫', '☼',
  '►', '◄', '↕', '‼', '¶', '§', '▬', '↨', '↑', '↓', '→', '←', '∟', '↔', '▲', '▼',
];

export const CP437_TO_UNICODE: string[] = (() => {
  const table = new Array<string>(256).fill('?');
  table[0] = ' ';
  for (let i = 0; i < 128; i++) table[i] = String.fromCharCode(i);
  table[0] = ' ';
  for (let i = 0; i < CP437_LOW.length; i++) table[i] = CP437_LOW[i] || ' ';
  for (let i = 0; i < CP437_HIGH.length; i++) table[128 + i] = CP437_HIGH[i];
  return table;
})();

const UNICODE_TO_CP437 = (() => {
  const map = new Map<string, number>();
  for (let code = 0; code < 256; code++) {
    const ch = CP437_TO_UNICODE[code];
    if (ch.length !== 1 || ch === ' ' || code === 0xff) continue;
    if (!map.has(ch)) map.set(ch, code);
  }
  map.set(' ', 0x20);
  return map;
})();

const TRANSLITERATIONS: Record<string, string> = {
  '—': '-', '–': '-', '‒': '-', '―': '-', '−': '-',
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '…': '...', '•': '.', '◦': 'o', '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x',
  '€': 'EUR', '™': '(TM)', '©': '(c)', '®': '(R)', '°': 'deg', '±': '+/-',
  '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~=', '∞': 'inf', '→': '->', '←': '<-',
  '↔': '<->', '↑': '^', '↓': 'v', '■': '#', '□': '#', '▪': '-', '▫': '-',
  '½': '1/2', '¼': '1/4', '¾': '3/4', '×': 'x', '÷': '/', '§': 'S',
  '\u00a0': ' ', '\u200b': '', '\u200c': '', '\u200d': '', '\ufeff': '',
  '\t': '    ',
};

export function cp437Code(ch: string): number {
  const mapped = UNICODE_TO_CP437.get(ch);
  if (mapped !== undefined) return mapped;
  const code = ch.codePointAt(0) ?? 63;
  return code >= 32 && code < 127 ? code : 63;
}

export function sanitizeText(text: string): string {
  let out = '';
  for (const ch of Array.from(text)) {
    if (ch === '\r') continue;
    if (ch === '\n' || ch === '\t') {
      out += TRANSLITERATIONS[ch] ?? ' ';
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32) continue;
    if (code < 127) {
      out += ch;
      continue;
    }
    if (UNICODE_TO_CP437.has(ch)) {
      out += ch;
      continue;
    }
    const translit = TRANSLITERATIONS[ch];
    if (translit !== undefined) {
      out += translit;
      continue;
    }
    out += '?';
  }
  return out;
}

export interface PageCell {
  ch: string;
  attr: number;
}

export class Screen {
  chars: string[];
  attrs: Uint8Array;

  constructor() {
    this.chars = new Array<string>(80 * 25).fill(' ');
    this.attrs = new Uint8Array(80 * 25).fill(attr(COLORS.gray, COLORS.black));
  }

  fillRow(row: number, ch: string, color: number): void {
    for (let col = 0; col < 80; col++) {
      const i = row * 80 + col;
      this.chars[i] = ch;
      this.attrs[i] = color;
    }
  }

  put(row: number, col: number, text: string, color: number): void {
    if (row < 0 || row >= 25) return;
    const clean = sanitizeText(text);
    let cursor = col;
    for (const ch of Array.from(clean)) {
      if (cursor < 0 || cursor >= 80) break;
      const i = row * 80 + cursor;
      this.chars[i] = ch;
      this.attrs[i] = color;
      cursor++;
    }
  }

  putRight(row: number, text: string, color: number, endCol = 80): void {
    const clean = sanitizeText(text);
    const col = endCol - Array.from(clean).length;
    this.put(row, col, clean, color);
  }

  cells(): PageCell[] {
    const out: PageCell[] = new Array(80 * 25);
    for (let i = 0; i < 80 * 25; i++) out[i] = { ch: this.chars[i], attr: this.attrs[i] };
    return out;
  }

  encode(): Uint8Array {
    const bytes = new Uint8Array(80 * 25 * 2);
    for (let i = 0; i < 80 * 25; i++) {
      bytes[i * 2] = cp437Code(this.chars[i]);
      bytes[i * 2 + 1] = this.attrs[i];
    }
    return bytes;
  }
}

export interface ComposeInput {
  fileName: string;
  buildId: string;
  outputLines: string[];
  exitCode: number;
  sourceRepairs: number;
  runtimePatches: number;
  truncated: boolean;
  sectorCount: number;
  kernelBytes: number;
  maxPages?: number;
}

export interface ComposeResult {
  pages: PageCell[][];
  encoded: Uint8Array[];
  notices: Repair[];
}

const PAGE_LIMIT = 14;
const CONTENT_WIDTH = 76;

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ +/, '');
  }
  out.push(rest);
  return out;
}

export function composePages(input: ComposeInput): ComposeResult {
  const notices: Repair[] = [];
  const maxPages = input.maxPages ?? PAGE_LIMIT;

  let replacedChars = 0;
  const lines: string[] = [];

  for (const raw of input.outputLines) {
    let text = '';
    for (const ch of Array.from(raw)) {
      if (ch === '\t') {
        text += '    ';
        continue;
      }
      const clean = sanitizeText(ch);
      if (clean === '?') replacedChars++;
      text += clean;
    }
    for (const piece of wrapLine(text, CONTENT_WIDTH)) lines.push(piece);
  }

  if (replacedChars > 0) {
    notices.push({
      phase: 'render',
      title: `Replaced ${replacedChars} character${replacedChars === 1 ? '' : 's'} VGA text mode cannot render`,
      detail: 'Transliterated accents and symbols to CP437 glyphs or ASCII equivalents.',
    });
  }

  const capacity = 20 + (maxPages - 1) * 23;
  if (lines.length > capacity) {
    lines.length = capacity;
    lines[capacity - 1] = '  ... output truncated to fit the framebuffer ...';
    notices.push({
      phase: 'render',
      title: `Output truncated at ${capacity} console lines`,
      detail: `The image holds at most ${maxPages} VGA pages.`,
    });
  }

  const pages: PageCell[][] = [];
  const encoded: Uint8Array[] = [];

  const totalPages = 1 + Math.max(0, Math.ceil((lines.length - 20) / 23));
  let pageIndex = 0;

  while (pageIndex < totalPages && pageIndex < maxPages) {
    const screen = new Screen();
    const isFirst = pageIndex === 0;

    screen.fillRow(0, ' ', attr(COLORS.white, COLORS.blue));
    screen.put(0, 1, 'SHARPBOOT', attr(COLORS.white, COLORS.blue));
    screen.put(0, 11, 'C# -> x86', attr(COLORS.lightCyan, COLORS.blue));
    screen.putRight(0, `build ${input.buildId}`, attr(COLORS.lightGray, COLORS.blue));

    if (isFirst) {
      const name = input.fileName.length > 26 ? input.fileName.slice(0, 23) + '...' : input.fileName;
      screen.put(1, 1, name, attr(COLORS.lightCyan, COLORS.black));
      screen.put(1, 1 + name.length, ' · Program.Main() · exit ' + input.exitCode, attr(COLORS.darkGray, COLORS.black));
      screen.putRight(1, 'kernel 0x1000:0200', attr(COLORS.darkGray, COLORS.black));
      screen.fillRow(2, '═', attr(COLORS.lightBlue, COLORS.black));
    } else {
      screen.put(0, 28, `page ${pageIndex + 1}/${totalPages}`, attr(COLORS.lightCyan, COLORS.blue));
    }

    if (isFirst) {
      const chunk = lines.slice(0, 20);
      for (let i = 0; i < chunk.length; i++) {
        screen.put(3 + i, 2, chunk[i], attr(COLORS.gray, COLORS.black));
      }
      if (chunk.length === 0) {
        screen.put(3, 2, '(the program produced no console output)', attr(COLORS.darkGray, COLORS.black));
      }

      if (totalPages > 1) {
        screen.put(23, 2, `output continues on page 2  ·  ${plural(lines.length - 20, 'more line')}`, attr(COLORS.darkGray, COLORS.black));
      } else if (input.truncated) {
        screen.put(23, 2, 'process stopped early — see the repair log', attr(COLORS.yellow, COLORS.black));
      } else {
        screen.put(23, 2, `process exited with code ${input.exitCode}`, attr(COLORS.lightGreen, COLORS.black));
        screen.put(23, 31, `${plural(input.sourceRepairs, 'repair')} · ${plural(input.runtimePatches, 'patch')}`, attr(COLORS.darkGray, COLORS.black));
      }
    } else {
      const start = 20 + (pageIndex - 1) * 23;
      const chunk = lines.slice(start, start + 23);
      for (let i = 0; i < chunk.length; i++) {
        screen.put(1 + i, 2, chunk[i], attr(COLORS.gray, COLORS.black));
      }
    }

    screen.fillRow(24, ' ', attr(COLORS.lightGray, COLORS.blue));
    const isLast = pageIndex === totalPages - 1;
    if (isLast) {
      screen.put(24, 1, 'ANY KEY', attr(COLORS.white, COLORS.blue));
      screen.put(24, 8, ':', attr(COLORS.lightGray, COLORS.blue));
      screen.put(24, 10, 'halt', attr(COLORS.lightGray, COLORS.blue));
    } else {
      screen.put(24, 1, 'SPACE', attr(COLORS.white, COLORS.blue));
      screen.put(24, 6, ':', attr(COLORS.lightGray, COLORS.blue));
      screen.put(24, 8, 'next page', attr(COLORS.lightGray, COLORS.blue));
      screen.put(24, 20, 'ESC', attr(COLORS.white, COLORS.blue));
      screen.put(24, 23, ':', attr(COLORS.lightGray, COLORS.blue));
      screen.put(24, 25, 'halt', attr(COLORS.lightGray, COLORS.blue));
    }
    screen.putRight(24, `page ${pageIndex + 1}/${totalPages} · ${input.sectorCount} sectors`, attr(COLORS.lightGray, COLORS.blue));

    pages.push(screen.cells());
    encoded.push(screen.encode());
    pageIndex++;
  }

  return { pages, encoded, notices };
}
