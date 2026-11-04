import { callElapsed, callReduce, logOutcome, newCall, ringExpired } from '../../module/agency/phone/call-state.ts'
import { coneLight } from '../../module/agency/phone/flashlight.ts'
import {
  centredView,
  clampView,
  dotPosition,
  layerPlacement,
  mapMode,
  mapSource,
  panBy,
  zoomAt,
} from '../../module/agency/phone/maps.ts'
import {
  burnerFilter,
  canStore,
  captureScale,
  cropRect,
  dataUrlBytes,
  ditherShades,
  INLINE_BUDGET,
  photoSpec,
} from '../../module/agency/phone/photos.ts'
import { t9View } from '../../module/agency/phone/t9.ts'
import { burnerInit, burnerKey, top, type BurnerUI } from '../../module/agency/phone/ui/burner.ts'
import { clip, wrapText } from '../../module/agency/phone/ui/lcd-font.ts'
import { Lcd } from '../../module/agency/phone/ui/lcd.ts'
import type { Effect, PhoneSnapshot } from '../../module/agency/phone/ui/model.ts'
import { smartAction, smartInit } from '../../module/agency/phone/ui/smart.ts'
import { emptyDevice, normalizeDevice, parseDeviceId, type Photo } from '../../module/agency/phone/types.ts'

function snap(extra: Partial<PhoneSnapshot> = {}): PhoneSnapshot {
  const record = emptyDevice('7025550188')
  record.contacts = [
    { id: 'c1', name: 'Control', number: '2025550100' },
    { id: 'c2', name: 'Tom B', number: '7025550161' },
  ]
  return {
    device: { id: 'mara:burner', skin: 'burner', owner: 'agent', number: '7025550188', name: 'Mara' },
    record,
    messages: [],
    names: {},
    avatars: {},
    clock: { start: '2025-11-03 08:00', worldTime: 0, lang: 'en' },
    signal: true,
    bars: 3,
    carrier: 'Nightline',
    flashlight: false,
    map: null,
    call: null,
    inspect: false,
    apps: ['messages', 'phone', 'camera', 'photos', 'maps', 'flashlight', 'notes', 'clock', 'calc'],
    preview: null,
    storage: 0,
    now: 0,
    ...extra,
  }
}

/** Press burner keys; returns the final UI and every effect. */
function keys(seq: string[], s = snap(), ui0: BurnerUI = burnerInit(), start = 0): { ui: BurnerUI; effects: Effect[] } {
  let ui = ui0
  let now = start
  const effects: Effect[] = []
  for (const k of seq) {
    const r = burnerKey(ui, k, s, now)
    ui = r.ui
    effects.push(...r.effects)
    now += k === 'wait' ? 5000 : 120
  }
  return { ui, effects }
}

describe('burner firmware', () => {
  test('menu: D-pad moves on the 3x3 grid, number keys jump', () => {
    let { ui } = keys(['softL', 'right', 'down'])
    expect(top(ui)).toEqual({ s: 'menu', sel: 4 })
    ui = keys(['up', 'up'], snap(), ui).ui
    expect(top(ui)).toEqual({ s: 'menu', sel: 7 }) // wraps
    const jump = keys(['softL', '9'])
    expect(top(jump.ui).s).toBe('calc')
    expect(keys(['softL', '4']).effects).toContainEqual({ t: 'preview' })
  })

  test('End always returns to the idle screen', () => {
    const { ui } = keys(['softL', '1', 'ok', 'end'])
    expect(ui.stack).toEqual([{ s: 'idle' }])
  })

  test('write a message by multi-tap and send it', () => {
    // Messages > Write message > pick "Control" > type "hi" > Send
    const s = snap()
    let r = keys(['softL', '1', 'ok'], s)
    expect(top(r.ui).s).toBe('pickTo')
    r = keys(['down', 'ok'], s, r.ui)
    expect(top(r.ui)).toMatchObject({ s: 'compose', to: '2025550100' })
    r = keys(['4', '4', 'wait', '4', '4', '4'], s, r.ui)
    const compose = top(r.ui) as any
    expect(t9View(compose.t9).text + t9View(compose.t9).pending).toBe('Hi')
    r = keys(['softL'], s, r.ui, 99_000)
    expect(r.effects).toContainEqual({ t: 'send', to: '2025550100', text: 'Hi', photo: null })
    expect(top(r.ui)).toEqual({ s: 'thread', key: '2025550100', scroll: 0 })
  })

  test('typing on a real keyboard', () => {
    const s = snap()
    let r = keys(['softL', '1', 'ok', 'down', 'ok'], s)
    r = keys(['char:M', 'char:e', 'char:e', 'char:t', 'softL'], s, r.ui)
    expect(r.effects).toContainEqual({ t: 'send', to: '2025550100', text: 'Meet', photo: null })
  })

  test('dial from the idle screen and call', () => {
    const r = keys(['5', '5', '5', '0', '1', '6', '1', 'call'])
    expect(r.effects).toContainEqual({ t: 'call', to: '7025550161' })
    expect(r.effects.filter(e => e.t === 'sound')).toHaveLength(7)
    expect(r.ui.stack).toEqual([{ s: 'idle' }])
  })

  test('an invalid number shows a notice; any key dismisses it', () => {
    let r = keys(['1', '2', 'call'])
    expect(r.ui.notice?.text).toBe('notice.badNumber')
    r = keys(['ok'], snap(), r.ui, 200)
    expect(r.ui.notice).toBeNull()
  })

  test('add a contact: name by multi-tap, number on the keypad', () => {
    const s = snap()
    let r = keys(['softR', 'ok'], s) // Names > Add new
    expect(top(r.ui).s).toBe('editContact')
    r = keys(['char:Z', 'down', '5', '5', '5', '0', '1', '9', '9', 'softL'], s, r.ui)
    const save = r.effects.find(e => e.t === 'saveContact') as any
    expect(save.contact).toMatchObject({ name: 'Z', number: '7025550199' })
  })

  test('incoming call: call key answers, End rejects', () => {
    const call = newCall({
      id: 'x',
      role: 'callee',
      local: 'mara:burner',
      localNumber: '7025550188',
      remote: { number: '2025550100' },
      at: 0,
    })
    const s = snap({ call })
    expect(keys(['call'], s).effects).toEqual([{ t: 'answer' }])
    expect(keys(['end'], s).effects).toEqual([{ t: 'decline' }])
    const active = callReduce(call, { t: 'answered', at: 10 })
    const r = keys(['char:o', 'char:k', 'ok'], snap({ call: active }))
    expect(r.effects).toContainEqual({ t: 'say', text: 'ok' })
    expect(keys(['softR'], snap({ call: active })).effects).toEqual([{ t: 'hangup' }])
  })

  test('calculator driven from the keypad', () => {
    const r = keys(['softL', '9', '1', '2', '*', '*', '3', 'ok']) // 12 − 3 (* pressed twice cycles + to −)
    expect((top(r.ui) as any).calc.display).toBe('9')
    const r2 = keys(['softL', '9', '7', 'left', '6', 'ok'])
    expect((top(r2.ui) as any).calc.display).toBe('42')
  })

  test('send a photo from the gallery to a typed number', () => {
    const s = snap()
    s.record.gallery = [{ id: 'p1', src: 'p.jpg', caption: '', taken: 0, w: 320, h: 240, origin: 'camera', bytes: 0 }]
    // Menu > Photos > first photo > Options > Send > Enter number > 5550177 > OK > Send
    const r = keys(['softL', '5', 'ok', 'ok', 'ok', 'ok', '5', '5', '5', '0', '1', '7', '7', 'ok', 'softL'], s)
    expect(r.effects).toContainEqual({ t: 'send', to: '7025550177', text: '', photo: { src: 'p.jpg', w: 320, h: 240, caption: '' } })
  })

  test('torch toggles from its screen and from the idle D-pad', () => {
    expect(keys(['right']).effects).toEqual([{ t: 'torch' }])
    expect(keys(['softL', '6', 'ok']).effects).toContainEqual({ t: 'torch' })
  })
})

describe('smartphone actions', () => {
  const s = snap({
    device: { id: 'mara:smartphone', skin: 'smartphone', owner: 'agent', number: '2025550143', name: 'Mara' },
  })

  test('unlock, open an app, home', () => {
    let ui = smartAction(smartInit(), 'unlock', '', {}, s).ui
    expect(ui.locked).toBe(false)
    ui = smartAction(ui, 'open', 'notes', {}, s).ui
    expect(ui.app).toBe('notes')
    expect(smartAction(ui, 'home', '', {}, s).ui.app).toBe('home')
  })

  test('opening a thread marks it read, except when the GM is reading', () => {
    expect(smartAction(smartInit(), 'thread', '2025550100', {}, s).effects).toEqual([
      { t: 'markRead', key: '2025550100' },
    ])
    expect(smartAction(smartInit(), 'thread', '2025550100', {}, { ...s, inspect: true }).effects).toEqual([])
  })

  test('send clears the draft and the attachment', () => {
    let ui = {
      ...smartInit(),
      locked: false,
      app: 'messages' as const,
      thread: '2025550100',
      drafts: { '2025550100': 'hi' },
    }
    ui = { ...ui, attach: { src: 'a.jpg', w: 4, h: 3 } }
    const r = smartAction(ui, 'send', '', { text: ' hi ' }, s)
    expect(r.effects).toEqual([{ t: 'send', to: '2025550100', text: 'hi', photo: { src: 'a.jpg', w: 4, h: 3 } }])
    expect(r.ui.drafts).toEqual({})
    expect(r.ui.attach).toBeNull()
  })

  test('new message to a typed local number', () => {
    const r = smartAction(smartInit(), 'composeTo', '', { to: '555-0177' }, s)
    expect(r.ui.thread).toBe('2025550177')
    expect(smartAction(smartInit(), 'composeTo', '', { to: 'abc' }, s).ui.error).toBe('badNumber')
  })

  test('keypad dialling', () => {
    let ui = smartInit()
    for (const d of '5550100') ui = smartAction(ui, 'key', d, {}, s).ui
    const r = smartAction(ui, 'dial', '', {}, s)
    expect(r.effects).toEqual([{ t: 'call', to: '2025550100' }])
    expect(r.ui.dial).toBe('')
  })

  test('flashlight from the lock screen keeps it locked', () => {
    const r = smartAction(smartInit(), 'open', 'flashlight', {}, s)
    expect(r.effects).toEqual([{ t: 'torch' }])
    expect(r.ui.locked).toBe(true)
  })

  test('contact save validates name and number', () => {
    const ui = { ...smartInit(), contact: { id: '', name: '', number: '' } }
    expect(smartAction(ui, 'contactSave', '', { name: '', number: '5550100' }, s).ui.error).toBe('needName')
    const ok = smartAction(ui, 'contactSave', '', { name: 'Handler', number: '5550100' }, s)
    expect((ok.effects[0] as any).contact).toMatchObject({ name: 'Handler', number: '2025550100' })
  })
})

describe('maps', () => {
  test('mode and source', () => {
    expect(mapMode(undefined)).toBe('off')
    expect(mapMode('custom')).toBe('custom')
    expect(mapSource('off', 'bg.webp', 'c.webp')).toBeNull()
    expect(mapSource('background', 'bg.webp', null)).toBe('bg.webp')
    expect(mapSource('custom', 'bg.webp', '')).toBeNull()
  })

  test('the dot sits where the token is on the scene rectangle', () => {
    const rect = { x: 500, y: 300, width: 4000, height: 3000 }
    expect(dotPosition({ x: 2500, y: 1800 }, rect)).toEqual({ u: 0.5, v: 0.5 })
    expect(dotPosition({ x: 100, y: 100 }, rect)).toBeNull()
  })

  test('pan and zoom stay on the map', () => {
    const g = { vw: 318, vh: 690, aspect: 4 / 3 }
    const view = centredView(g, { u: 0.02, v: 0.5 }, 2)
    const p = layerPlacement(view, g)
    expect(p.left).toBeLessThanOrEqual(0) // can't pan past the left edge
    expect(p.top).toBeLessThanOrEqual(0)
    const zoomed = zoomAt(view, g, 100)
    expect(zoomed.zoom).toBe(6)
    const panned = panBy(clampView({ zoom: 1, cx: 0.5, cy: 0.5 }, g), g, -10_000, 0)
    const pp = layerPlacement(panned, g)
    expect(pp.left + pp.w).toBeCloseTo(g.vw, 5)
  })
})

describe('photos', () => {
  test('sizes', () => {
    expect(photoSpec('smartphone', true)).toMatchObject({ width: 1024, height: 768 })
    expect(photoSpec('smartphone', false)).toMatchObject({ width: 640, height: 480 })
    expect(photoSpec('burner', false)).toMatchObject({ width: 320, height: 240 })
  })

  test('inline storage budget', () => {
    const photo = (bytes: number): Photo => ({
      id: 'p',
      src: 'x',
      caption: '',
      taken: 0,
      w: 1,
      h: 1,
      origin: 'camera',
      bytes,
    })
    expect(canStore([photo(INLINE_BUDGET - 10)], 20)).toEqual({ ok: false, reason: 'full' })
    expect(canStore([photo(INLINE_BUDGET - 10)], 0)).toEqual({ ok: true })
    expect(
      canStore(
        Array.from({ length: 120 }, () => photo(0)),
        0
      )
    ).toEqual({ ok: false, reason: 'count' })
    expect(dataUrlBytes('data:image/jpeg;base64,QUJD')).toBe(3)
    expect(dataUrlBytes('worlds/x/a.jpg')).toBe(0)
  })

  test('framing around the token, clamped to the screen', () => {
    expect(cropRect({ x: 960, y: 540 }, { w: 1920, h: 1080 }, 800, 4 / 3)).toEqual({ x: 560, y: 240, w: 800, h: 600 })
    expect(cropRect({ x: 10, y: 10 }, { w: 1920, h: 1080 }, 800, 4 / 3)).toEqual({ x: 0, y: 0, w: 800, h: 600 })
    expect(cropRect({ x: 500, y: 300 }, { w: 640, h: 360 }, 2000, 4 / 3)).toEqual({ x: 160, y: 0, w: 480, h: 360 })
    expect(captureScale(100, 12, 1024, 1920)).toBeCloseTo(1024 / 1200)
    expect(captureScale(100, 12, 1024, 800)).toBeCloseTo((800 * 0.95) / 1200)
  })

  test('burner filter washes out and tints green; dithering spans the shades', () => {
    const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 0, 0, 255])
    burnerFilter(px, 1)
    expect(px[0]).toBeGreaterThan(10) // lifted blacks
    expect(px[1]).toBeGreaterThan(px[2]) // green cast
    expect(px[4]).toBeLessThan(255) // squashed highlights
    const w = 8
    const ramp = new Uint8ClampedArray(w * 4)
    for (let i = 0; i < w; i++) ramp.set([i * 36, i * 36, i * 36, 255], i * 4)
    const levels = ditherShades(ramp, w, 1, 4)
    expect(levels[0]).toBe(0)
    expect(levels[w - 1]).toBe(3)
  })
})

describe('calls', () => {
  const base = () =>
    newCall({ id: 'c', role: 'caller', local: 'a:smartphone', localNumber: '1', remote: { number: '2' }, at: 1000 })

  test('dialing -> answered -> hung up, with a duration', () => {
    let c = base()
    expect(c.phase).toBe('dialing')
    c = callReduce(c, { t: 'answered', at: 2000, peerUserId: 'u2' })
    expect(c.peerUserId).toBe('u2')
    c = callReduce(c, { t: 'say', who: 'them', text: '  where   are you ', at: 3000 })
    expect(c.lines).toEqual([{ who: 'them', text: 'where are you', at: 3000 }])
    expect(callElapsed(c, 44_000)).toBe(42)
    c = callReduce(c, { t: 'end', at: 62_000, reason: 'missed' })
    expect(c.end).toBe('hangup') // an answered call ends by hanging up
    expect(callElapsed(c, 99_000)).toBe(60)
    expect(logOutcome(c)).toBe('answered')
  })

  test('unanswered calls log as missed or declined; ringing expires', () => {
    expect(logOutcome(callReduce(base(), { t: 'end', at: 5, reason: 'declined' }))).toBe('declined')
    expect(logOutcome(callReduce(base(), { t: 'end', at: 5, reason: 'missed' }))).toBe('missed')
    expect(ringExpired(base(), 1000 + 30_000)).toBe(true)
    expect(ringExpired(base(), 1000 + 29_000)).toBe(false)
  })

  test('nothing happens after the end', () => {
    const ended = callReduce(base(), { t: 'end', at: 5, reason: 'busy' })
    expect(callReduce(ended, { t: 'answered', at: 6 })).toBe(ended)
  })
})

describe('odds and ends', () => {
  test('flashlight cone keeps the old light underneath', () => {
    const cone = coneLight(
      { bright: 0, dim: 0, angle: 360, color: null, animation: { type: 'torch', speed: 5 } },
      { bright: 3, dim: 8, angle: 60, color: '#ffcf8a' }
    )
    expect(cone).toMatchObject({ bright: 3, dim: 8, angle: 60, color: '#ffcf8a', animation: { type: null, speed: 5 } })
  })

  test('device ids', () => {
    expect(parseDeviceId('abc:burner')).toEqual({ type: 'actor', actorId: 'abc', kind: 'burner' })
    expect(parseDeviceId('npc:x')).toEqual({ type: 'npc', npcId: 'x' })
    expect(parseDeviceId('num:2025550100')).toEqual({ type: 'num', number: '2025550100' })
    expect(parseDeviceId('abc:pager')).toBeNull()
    expect(normalizeDevice({ number: '1', contacts: 'bad' })).toMatchObject({ contacts: [], prefs: { h24: false } })
    expect(normalizeDevice(null)).toBeNull()
  })

  test('LCD text wraps and clips', () => {
    expect(wrapText('Meet at the overpass at 0300', 12)).toEqual(['Meet at the', 'overpass at', '0300'])
    expect(wrapText('abcdefghijklmno', 6)).toEqual(['abcdef', 'ghijkl', 'mno'])
    expect(clip('Control room', 8)).toBe('Control…')
    const lcd = new Lcd(20, 10)
    expect(lcd.text(0, 0, 'Hi', 3)).toBe(12)
    expect(Array.from(lcd.px).some(v => v === 3)).toBe(true)
  })
})
