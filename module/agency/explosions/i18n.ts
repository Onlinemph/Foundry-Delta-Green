/** Localization under GURPS.agency.explosions.* (pass a full key starting with "GURPS." to use another). */
const ROOT = 'GURPS.agency.explosions'

export function key(k: string): string {
  return k.startsWith('GURPS.') || k.startsWith('EFFECT.') ? k : `${ROOT}.${k}`
}

export function localize(k: string, data?: Record<string, unknown>): string {
  const i18n = game.i18n as any
  if (!i18n) return k
  return data ? i18n.format(key(k), data) : i18n.localize(key(k))
}

export function escapeHtml(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
