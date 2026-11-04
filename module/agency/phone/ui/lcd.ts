/**
 * The burner's screen: a 128x128, four-shade LCD drawn into a byte buffer (0 = backlight ... 3 = ink),
 * then pushed to a canvas with a palette. Pure: no DOM until toRGBA().
 */
import { ADVANCE, glyph, textWidth } from './lcd-font.ts'

export const LCD_W = 128
export const LCD_H = 128

export type Shade = 0 | 1 | 2 | 3

/** Backlit teal-green LCD, light to dark. */
export const LCD_PALETTE: [number, number, number][] = [
  [178, 205, 178],
  [130, 163, 136],
  [70, 98, 80],
  [22, 36, 30],
]

/**
 * 16x16 menu icons. '.' leaves the pixel alone, 'o' paints backlight, '-' light, '+' dark, '#' ink.
 */
export const ICONS: Record<string, string[]> = {
  messages: [
    '................',
    '................',
    '................',
    '################',
    '#++oooooooooo++#',
    '#o++oooooooo++o#',
    '#oo++oooooo++oo#',
    '#oooo++oo++oooo#',
    '#oooo#o##o#oooo#',
    '#ooo#oooooo#ooo#',
    '#oo#oooooooo#oo#',
    '#o#oooooooooo#o#',
    '##oooooooooooo##',
    '################',
    '................',
    '................',
  ],
  names: [
    '................',
    '......####......',
    '.....#oooo#.....',
    '....#oooooo#....',
    '....#oo#o#o#....',
    '....#oooooo#....',
    '....#o#oo#o#....',
    '.....#o##o#.....',
    '......####......',
    '....##oooo##....',
    '...#oooooooo#...',
    '..#oooooooooo#..',
    '..#o#oooooo#o#..',
    '..#o#oooooo#o#..',
    '..############..',
    '................',
  ],
  calls: [
    '................',
    '.####...........',
    '#oooo#..........',
    '#ooo#...........',
    '#oo#............',
    '.#o#............',
    '.#oo#...........',
    '..#oo#..........',
    '...#oo#.........',
    '....#oo#...###..',
    '.....#oo###ooo#.',
    '......#ooooooo#.',
    '.......#oooooo#.',
    '........#######.',
    '................',
    '................',
  ],
  camera: [
    '................',
    '................',
    '.....####.......',
    '.##.#oooo#......',
    '################',
    '#oooo#####ooo++#',
    '#ooo#+++++#ooo+#',
    '#oo#++ooo++#ooo#',
    '#oo#+ooooo+#ooo#',
    '#oo#+oo#oo+#ooo#',
    '#oo#++ooo++#ooo#',
    '#ooo#+++++#oooo#',
    '#oooo#####ooooo#',
    '################',
    '................',
    '................',
  ],
  photos: [
    '................',
    '................',
    '################',
    '#oooooooooooooo#',
    '#oooooooooo##oo#',
    '#ooooooooo####o#',
    '#oooooooooo##oo#',
    '#ooooo#ooooooo##',
    '#oooo###oooo#oo#',
    '#ooo#####oo###o#',
    '#oo#######+++++#',
    '#o#############+',
    '################',
    '................',
    '................',
    '................',
  ],
  torch: [
    '..#....#....#...',
    '...#...#...#....',
    '....#.....#.....',
    '................',
    '..###########...',
    '..#ooooooooo#...',
    '...#ooooooo#....',
    '....#ooooo#.....',
    '....#o+++o#.....',
    '....#ooooo#.....',
    '....#o+++o#.....',
    '....#ooooo#.....',
    '....#ooooo#.....',
    '....#ooooo#.....',
    '....#######.....',
    '................',
  ],
  memo: [
    '................',
    '..###########...',
    '..#ooooooooo#...',
    '..#o#######o#...',
    '..#ooooooooo#.#.',
    '..#o#######o##o#',
    '..#ooooooooo#oo#',
    '..#o######o#oo#.',
    '..#ooooooo#oo#..',
    '..#o#####o#o#o..',
    '..#ooooooo##oo..',
    '..#oooooo###oo..',
    '..#ooooooooooo#.',
    '..#############.',
    '................',
    '................',
  ],
  clock: [
    '................',
    '.....######.....',
    '...##oooooo##...',
    '..#oooo#ooooo#..',
    '.#ooooo#oooooo#.',
    '.#ooooo#oooooo#.',
    '#oooooo#ooooooo#',
    '#oooooo#ooooooo#',
    '#oooooo####oooo#',
    '#ooooooooooooooo',
    '.#oooooooooooo#.',
    '.#oooooooooooo#.',
    '..#oooooooooo#..',
    '...##oooooo##...',
    '.....######.....',
    '................',
  ],
  calc: [
    '...##########...',
    '...#oooooooo#...',
    '...#o######o#...',
    '...#o#++++#o#...',
    '...#o######o#...',
    '...#oooooooo#...',
    '...#o##o##o##...',
    '...#oooooooo#...',
    '...#o##o##o##...',
    '...#oooooooo#...',
    '...#o##o##o##...',
    '...#oooooooo#...',
    '...#o#####o##...',
    '...#oooooooo#...',
    '...##########...',
    '................',
  ],
  // 7x5 status glyphs
  envelope: ['#######', '##ooo##', '#o#o#o#', '#oo#oo#', '#######'],
  missed: ['.#...#.', '..#.#..', '...#...', '#######', '#ooooo#'],
  bulb: ['.###.', '#ooo#', '#ooo#', '.#o#.', '.###.', '..#..'],
  muted: ['.##.#', '#oo#.', '#o#o#', '.#oo#', '#.##.'],
}

const SHADE_OF: Record<string, Shade | null> = { '.': null, o: 0, '-': 1, '+': 2, '#': 3 }

export class Lcd {
  readonly px: Uint8Array

  constructor(
    readonly w = LCD_W,
    readonly h = LCD_H
  ) {
    this.px = new Uint8Array(w * h)
  }

  clear(shade: Shade = 0): void {
    this.px.fill(shade)
  }

  set(x: number, y: number, shade: Shade): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    this.px[(y | 0) * this.w + (x | 0)] = shade
  }

  get(x: number, y: number): Shade {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0
    return this.px[y * this.w + x] as Shade
  }

  rect(x: number, y: number, w: number, h: number, shade: Shade): void {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) this.px[j * this.w + i] = shade
  }

  hline(x: number, y: number, w: number, shade: Shade): void {
    this.rect(x, y, w, 1, shade)
  }

  vline(x: number, y: number, h: number, shade: Shade): void {
    this.rect(x, y, 1, h, shade)
  }

  frame(x: number, y: number, w: number, h: number, shade: Shade): void {
    this.hline(x, y, w, shade)
    this.hline(x, y + h - 1, w, shade)
    this.vline(x, y, h, shade)
    this.vline(x + w - 1, y, h, shade)
  }

  /** Box with clipped corners (the classic phone selection bar). */
  roundRect(x: number, y: number, w: number, h: number, shade: Shade): void {
    this.rect(x + 1, y, w - 2, h, shade)
    this.rect(x, y + 1, 1, h - 2, shade)
    this.rect(x + w - 1, y + 1, 1, h - 2, shade)
  }

  /** 50% checkerboard. */
  dither(x: number, y: number, w: number, h: number, shade: Shade): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if ((i + j) % 2 === 0) this.set(i, j, shade)
  }

  text(x: number, y: number, text: string, shade: Shade = 3, scale = 1): number {
    let cx = x
    for (const ch of text) {
      const rows = glyph(ch)
      for (let r = 0; r < rows.length; r++) {
        const bits = rows[r]
        for (let c = 0; c < 5; c++) {
          if (bits & (1 << (4 - c))) {
            if (scale === 1) this.set(cx + c, y + r, shade)
            else this.rect(cx + c * scale, y + r * scale, scale, scale, shade)
          }
        }
      }
      cx += ADVANCE * scale
    }
    return cx - x
  }

  textCenter(y: number, text: string, shade: Shade = 3, scale = 1, x0 = 0, width = this.w): void {
    this.text(x0 + Math.floor((width - textWidth(text, scale)) / 2), y, text, shade, scale)
  }

  textRight(xRight: number, y: number, text: string, shade: Shade = 3, scale = 1): void {
    this.text(xRight - textWidth(text, scale), y, text, shade, scale)
  }

  icon(x: number, y: number, name: string, invert = false, scale = 1): void {
    const rows = ICONS[name]
    if (!rows) return
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const s = SHADE_OF[row[i]]
        if (s === null || s === undefined) continue
        const shade = (invert ? 3 - s : s) as Shade
        if (scale === 1) this.set(x + i, y + j, shade)
        else this.rect(x + i * scale, y + j * scale, scale, scale, shade)
      }
    })
  }

  /** Little arcs either side of a point: a ringing phone. */
  waves(cx: number, cy: number, r: number, shade: Shade = 3): void {
    for (let k = 0; k < 2; k++) {
      const rad = r + k * 4
      for (let a = -0.7; a <= 0.7; a += 0.12) {
        this.set(Math.round(cx + Math.cos(a) * rad), Math.round(cy + Math.sin(a) * rad), shade)
        this.set(Math.round(cx - Math.cos(a) * rad), Math.round(cy + Math.sin(a) * rad), shade)
      }
    }
  }

  /** Levels from ditherShades (0 = dark ... 3 = light) into the box. */
  image(x: number, y: number, w: number, h: number, levels: Uint8Array): void {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) this.set(x + i, y + j, (3 - (levels[j * w + i] ?? 0)) as Shade)
  }

  /** Signal bars, 11x7 at (x, y); 0 bars draws an X. */
  bars(x: number, y: number, n: number): void {
    // Antenna
    this.set(x, y, 3)
    this.set(x + 2, y, 3)
    this.set(x + 1, y + 1, 3)
    this.vline(x + 1, y + 1, 6, 3)
    if (n <= 0) {
      for (let i = 0; i < 5; i++) {
        this.set(x + 4 + i, y + 1 + i, 3)
        this.set(x + 8 - i, y + 1 + i, 3)
      }
      return
    }
    const heights = [2, 3, 5, 7]
    for (let b = 0; b < 4; b++) {
      const bh = heights[b]
      const bx = x + 3 + b * 2
      if (b < n) this.vline(bx, y + 7 - bh, bh, 3)
      else this.set(bx, y + 6, 2)
    }
  }

  /** Battery 13x7, `level` of 3 segments. */
  battery(x: number, y: number, level: number): void {
    this.frame(x + 1, y, 12, 7, 3)
    this.rect(x, y + 2, 1, 3, 3)
    for (let s = 0; s < 3; s++) if (s >= 3 - level) this.rect(x + 3 + s * 3, y + 2, 2, 3, 3)
  }

  toRGBA(palette: [number, number, number][] = LCD_PALETTE): Uint8ClampedArray {
    const out = new Uint8ClampedArray(this.w * this.h * 4)
    for (let i = 0; i < this.px.length; i++) {
      const [r, g, b] = palette[this.px[i]] ?? palette[0]
      out[i * 4] = r
      out[i * 4 + 1] = g
      out[i * 4 + 2] = b
      out[i * 4 + 3] = 255
    }
    return out
  }
}
