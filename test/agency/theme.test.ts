import { describe, expect, it } from '@jest/globals'
import * as sass from 'sass'
import { readFileSync } from 'node:fs'

import {
  MAX_SHEET_WIDENING,
  PAUSE_STAMP_CLASS,
  PAUSE_STAMP_SRC,
  THEME_BODY_CLASS,
  applyPauseStamp,
  applyThemeClass,
  sheetWidening,
} from '../../module/agency/theme/index.ts'

class FakeClassList {
  readonly names = new Set<string>()
  add(name: string): void {
    this.names.add(name)
  }
  remove(name: string): void {
    this.names.delete(name)
  }
  contains(name: string): boolean {
    return this.names.has(name)
  }
  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.names.has(name)
    if (on) this.names.add(name)
    else this.names.delete(name)
    return on
  }
}

function fakeImg(src: string) {
  return {
    src,
    alt: '',
    classList: new FakeClassList(),
    getAttribute(name: string) {
      return name === 'src' ? this.src : null
    },
  }
}

describe('dossier theme: body class', () => {
  it('adds and removes the theme class', () => {
    const body = { classList: new FakeClassList() }
    applyThemeClass(true, body as unknown as HTMLElement)
    expect(body.classList.contains(THEME_BODY_CLASS)).toBe(true)
    applyThemeClass(false, body as unknown as HTMLElement)
    expect(body.classList.contains(THEME_BODY_CLASS)).toBe(false)
  })
})

describe('dossier theme: pause stamp', () => {
  const logo = 'systems/gurps/assets/gurps4e.webp'

  it('swaps in the stamp when the theme is on', () => {
    const img = fakeImg(logo)
    applyPauseStamp(img as unknown as HTMLImageElement, true, logo)
    expect(img.src).toBe(PAUSE_STAMP_SRC)
    expect(img.classList.contains(PAUSE_STAMP_CLASS)).toBe(true)
  })

  it('restores the system logo when the theme is turned off', () => {
    const img = fakeImg(logo)
    applyPauseStamp(img as unknown as HTMLImageElement, true, logo)
    applyPauseStamp(img as unknown as HTMLImageElement, false, logo)
    expect(img.src).toBe(logo)
    expect(img.classList.contains(PAUSE_STAMP_CLASS)).toBe(false)
  })

  it('leaves a non-stamp image alone when the theme is off', () => {
    const img = fakeImg(logo)
    applyPauseStamp(img as unknown as HTMLImageElement, false, 'other.webp')
    expect(img.src).toBe(logo)
  })

  it('tolerates a missing pause image', () => {
    expect(() => applyPauseStamp(null, true, logo)).not.toThrow()
  })
})

describe('dossier theme: sheet widening', () => {
  it('widens by the overflow plus a little slack', () => {
    expect(sheetWidening(870, 830)).toBe(46)
  })

  it('does nothing when the content fits', () => {
    expect(sheetWidening(830, 830)).toBe(0)
    expect(sheetWidening(800, 830)).toBe(0)
  })

  it('ignores implausibly large overflow', () => {
    expect(sheetWidening(830 + MAX_SHEET_WIDENING + 1, 830)).toBe(0)
  })
})

describe('dossier theme: stylesheet', () => {
  const css = sass.compile('styles/agency/_theme.scss', { style: 'expanded' }).css

  // Top-level selectors of style rules, with @media / @supports blocks unwrapped.
  function selectors(source: string): string[] {
    const out: string[] = []
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@font-face\s*{[^}]*}/g, '')
      .replace(/@keyframes[^{]*{(?:[^{}]*{[^}]*})*\s*}/g, '')
    const re = /([^{};]+){/g
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped))) {
      const sel = m[1].trim()
      if (!sel.startsWith('@')) out.push(sel)
    }
    return out
  }

  // Split a selector list on top-level commas (not the ones inside :is() / :not()).
  function splitList(list: string): string[] {
    const parts: string[] = []
    let depth = 0
    let start = 0
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      if (c === '(') depth++
      else if (c === ')') depth--
      else if (c === ',' && depth === 0) {
        parts.push(list.slice(start, i))
        start = i + 1
      }
    }
    parts.push(list.slice(start))
    return parts.map(p => p.trim()).filter(Boolean)
  }

  it('defines every documented kit class', () => {
    for (const cls of [
      'agency-sheet-panels',
      'agency-panel',
      'agency-panel-header',
      'agency-panel-body',
      'agency-stamp',
      'agency-stamp--green',
      'agency-redacted',
      'agency-btn',
      'agency-table',
      'agency-badge',
      'agency-chat-card',
      'agency-chat-card-header',
      'agency-chat-card-body',
      'agency-chat-card-footer',
    ]) {
      expect(css).toContain(`.${cls}`)
    }
  })

  it('scopes every theme rule under body.agency-theme (kit classes excepted)', () => {
    const unscoped = selectors(css)
      .flatMap(splitList)
      .filter(s => !s.startsWith('body.agency-theme') && !s.startsWith('.agency-'))
    expect(unscoped).toEqual([])
  })

  it('bundles its fonts locally (no CDN)', () => {
    expect(css).not.toMatch(/https?:\/\//)
    for (const file of css.match(/assets\/agency\/fonts\/[\w-]+\.woff2/g) ?? []) {
      expect(() => readFileSync(file)).not.toThrow()
    }
  })
})
