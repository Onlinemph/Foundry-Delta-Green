import { MODERN_AGENT_MOOK, MODERN_AGENT_SETTINGS } from '../../module/agency/presets/modern-agent.ts'

describe('Modern agent preset', () => {
  test('setting keys are unique and labelled', () => {
    const keys = MODERN_AGENT_SETTINGS.map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of MODERN_AGENT_SETTINGS) expect(s.label).toMatch(/^GURPS\.agency\.presets\.change\./)
  })

  test('preset turns off Conditional Injury and turns on the wound model', () => {
    const byKey = Object.fromEntries(MODERN_AGENT_SETTINGS.map(s => [s.key, s.value]))
    expect(byKey['useConditionalInjury']).toBe(false)
    expect(byKey['agency-damage-model']).toBe('rfh')
  })

  test('agent NPC uses shots notation the NPC generator can parse', () => {
    // lib/npc-input.js matches shots with /[Ss]hots *([\w\)\(]+)/, so no '+1' chambered round here.
    const shots = MODERN_AGENT_MOOK.ranged.match(/ [Ss]hots *([\w)(]+)/)
    expect(shots?.[1]).toBe('17(3)')
  })
})
