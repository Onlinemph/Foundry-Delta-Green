/**
 * Every phone sound, synthesised with WebAudio (no audio files): ringtone (a classic two-tone trill
 * ring), ringback, vibrate buzz, key clicks and DTMF, camera shutter, message ping, error tones.
 * The client setting 'agency-phone-sounds' mutes them; volume follows Foundry's interface volume.
 */
import { soundsOn } from './settings.ts'

let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  if (!soundsOn()) return null
  try {
    const shared = (game as any).audio?.context as AudioContext | undefined
    ctx ??= shared ?? new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

function volume(): number {
  try {
    const v = Number((game.settings as any).get('core', 'globalInterfaceVolume'))
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5
  } catch {
    return 0.5
  }
}

/** A master gain for one sound, connected to the speakers. */
function out(ac: AudioContext, level = 1): GainNode {
  const g = ac.createGain()
  g.gain.value = level * volume()
  g.connect(ac.destination)
  return g
}

function tone(
  ac: AudioContext,
  dest: AudioNode,
  freq: number,
  start: number,
  dur: number,
  type: OscillatorType = 'sine',
  peak = 0.3
): void {
  const osc = ac.createOscillator()
  const env = ac.createGain()
  osc.type = type
  osc.frequency.value = freq
  env.gain.setValueAtTime(0, start)
  env.gain.linearRampToValueAtTime(peak, start + 0.005)
  env.gain.setValueAtTime(peak, start + Math.max(0.006, dur - 0.012))
  env.gain.linearRampToValueAtTime(0, start + dur)
  osc.connect(env).connect(dest)
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

function noise(ac: AudioContext, dest: AudioNode, start: number, dur: number, freq: number, q = 1, peak = 0.5): void {
  const len = Math.max(1, Math.floor(ac.sampleRate * dur))
  const buffer = ac.createBuffer(1, len, ac.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2)
  const src = ac.createBufferSource()
  src.buffer = buffer
  const filter = ac.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = freq
  filter.Q.value = q
  const env = ac.createGain()
  env.gain.value = peak
  src.connect(filter).connect(env).connect(dest)
  src.start(start)
}

/** DTMF row/column frequencies. */
export const DTMF: Record<string, [number, number]> = {
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  '*': [941, 1209],
  '0': [941, 1336],
  '#': [941, 1477],
}

export function playDtmf(key: string): void {
  const ac = audio()
  const f = DTMF[key]
  if (!ac || !f) return
  const g = out(ac, 0.5)
  const t = ac.currentTime
  tone(ac, g, f[0], t, 0.12, 'sine', 0.25)
  tone(ac, g, f[1], t, 0.12, 'sine', 0.25)
}

/** Rubber key click (burner). */
export function playClick(): void {
  const ac = audio()
  if (!ac) return
  const g = out(ac, 0.6)
  const t = ac.currentTime
  noise(ac, g, t, 0.018, 3200, 2, 0.6)
  tone(ac, g, 2200, t, 0.012, 'square', 0.04)
}

/** Soft tap (touchscreen). */
export function playTick(): void {
  const ac = audio()
  if (!ac) return
  const g = out(ac, 0.35)
  noise(ac, g, ac.currentTime, 0.012, 5000, 3, 0.4)
}

export function playShutter(): void {
  const ac = audio()
  if (!ac) return
  const g = out(ac, 0.8)
  const t = ac.currentTime
  noise(ac, g, t, 0.035, 2500, 1.2, 0.9)
  noise(ac, g, t + 0.075, 0.05, 1600, 1, 0.7)
}

export function playPing(): void {
  const ac = audio()
  if (!ac) return
  const g = out(ac, 0.45)
  const t = ac.currentTime
  for (const [f, at] of [
    [1318.5, 0],
    [1760, 0.11],
  ] as const) {
    const osc = ac.createOscillator()
    const env = ac.createGain()
    osc.frequency.value = f
    env.gain.setValueAtTime(0, t + at)
    env.gain.linearRampToValueAtTime(0.35, t + at + 0.006)
    env.gain.exponentialRampToValueAtTime(0.001, t + at + 0.4)
    osc.connect(env).connect(g)
    osc.start(t + at)
    osc.stop(t + at + 0.42)
  }
}

/** Special information tones: "your call cannot be completed". */
export function playError(): void {
  const ac = audio()
  if (!ac) return
  const g = out(ac, 0.35)
  const t = ac.currentTime
  ;[950, 1400, 1800].forEach((f, i) => tone(ac, g, f, t + i * 0.33, 0.3, 'sine', 0.25))
}

/** Two short beeps: connected / hung up. */
export function playBeep(up = true): void {
  const ac = audio()
  if (!ac) return
  const g = out(ac, 0.35)
  const t = ac.currentTime
  tone(ac, g, up ? 880 : 620, t, 0.08, 'sine', 0.25)
  tone(ac, g, up ? 1175 : 440, t + 0.1, 0.1, 'sine', 0.25)
}

/** A vibrate motor: low buzzy rumble in two pulses. */
export function playBuzz(level = 1): void {
  const ac = audio()
  if (!ac) return
  const g = out(ac, 0.5 * level)
  const t = ac.currentTime
  for (const at of [0, 0.5]) {
    const osc = ac.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = 150
    const lp = ac.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 420
    const env = ac.createGain()
    env.gain.setValueAtTime(0, t + at)
    env.gain.linearRampToValueAtTime(0.5, t + at + 0.02)
    env.gain.setValueAtTime(0.5, t + at + 0.32)
    env.gain.linearRampToValueAtTime(0, t + at + 0.36)
    osc.connect(lp).connect(env).connect(g)
    osc.start(t + at)
    osc.stop(t + at + 0.4)
  }
}

/** Repeats `schedule` every `period` seconds until stopped. Returns the stop function. */
function loop(
  period: number,
  schedule: (ac: AudioContext, dest: AudioNode, at: number) => void,
  level: number
): () => void {
  const ac = audio()
  if (!ac) return () => {}
  const g = out(ac, level)
  let next = ac.currentTime + 0.05
  let stopped = false
  const pump = () => {
    if (stopped) return
    while (next < ac.currentTime + 2 * period) {
      schedule(ac, g, next)
      next += period
    }
  }
  pump()
  const timer = setInterval(pump, period * 500)
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    const t = ac.currentTime
    g.gain.cancelScheduledValues(t)
    g.gain.setValueAtTime(g.gain.value, t)
    g.gain.linearRampToValueAtTime(0, t + 0.05)
    setTimeout(() => g.disconnect(), 120)
  }
}

/** Classic electronic ring: a two-tone trill, "brrring-brrring", pause. */
export function startRingtone(): () => void {
  return loop(
    3,
    (ac, dest, at) => {
      for (const burst of [0, 0.6]) {
        const osc = ac.createOscillator()
        osc.type = 'triangle'
        const env = ac.createGain()
        const start = at + burst
        const dur = 0.42
        for (let i = 0; i * 0.04 < dur; i++) osc.frequency.setValueAtTime(i % 2 ? 1250 : 1000, start + i * 0.04)
        env.gain.setValueAtTime(0, start)
        env.gain.linearRampToValueAtTime(0.32, start + 0.01)
        env.gain.setValueAtTime(0.32, start + dur - 0.02)
        env.gain.linearRampToValueAtTime(0, start + dur)
        osc.connect(env).connect(dest)
        osc.start(start)
        osc.stop(start + dur + 0.02)
      }
    },
    0.55
  )
}

/** What the caller hears while it rings: 440 + 480 Hz, 2 s on, 4 s off. */
export function startRingback(): () => void {
  return loop(
    6,
    (ac, dest, at) => {
      tone(ac, dest, 440, at, 2, 'sine', 0.12)
      tone(ac, dest, 480, at, 2, 'sine', 0.12)
    },
    0.5
  )
}

/** Vibrate pulses alongside the ringtone. */
export function startVibrate(): () => void {
  playBuzz(0.6)
  const timer = setInterval(() => playBuzz(0.6), 3000)
  return () => clearInterval(timer)
}
