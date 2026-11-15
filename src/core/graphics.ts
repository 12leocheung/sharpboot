/** Shared mode-13h graphics contract for the bare-metal kernel and the browser VM. */

export const GRAPHICS_WIDTH = 320;
export const GRAPHICS_HEIGHT = 200;
export const GRAPHICS_PIXELS = GRAPHICS_WIDTH * GRAPHICS_HEIGHT;

/** Pack 8-bit RGB into the kernel's 3-3-2 palette index. */
export function rgbIndex(r: number, g: number, b: number): number {
  return ((r & 0xe0) | ((g & 0xe0) >> 3) | ((b & 0xc0) >> 6)) & 0xff;
}

/** Expand a 3-3-2 palette index to 8-bit RGB for the browser canvas. */
export function paletteColor(index: number): [number, number, number] {
  const value = index & 0xff;
  const r = (value >> 5) & 7;
  const g = (value >> 2) & 7;
  const b = value & 3;
  return [Math.round((r * 255) / 7), Math.round((g * 255) / 7), Math.round((b * 255) / 3)];
}
