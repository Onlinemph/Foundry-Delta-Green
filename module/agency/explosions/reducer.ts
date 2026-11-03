/**
 * How the GM card's state changes. Pure; tested in test/agency/explosions-resolve.test.ts.
 */
import { recordDive } from './resolve.ts'
import type { BlastCardFlag, BlastEvent } from './types.ts'

export function reduceBlast(flag: BlastCardFlag, event: BlastEvent): BlastCardFlag {
  switch (event.kind) {
    case 'dive': {
      const row = flag.state.rows.find(r => r.facts.id === event.tokenId)
      if (!row || row.applied) return flag
      // An answer that arrives after the GM settled the dive (or applied) doesn't change it.
      if (row.dive.status !== 'pending' && row.dive.status !== 'none') return flag
      return {
        ...flag,
        state: recordDive(flag.state, event.tokenId, {
          status: event.status,
          margin: event.margin,
          coverStep: event.coverStep,
          smother: event.smother,
        }),
      }
    }
    case 'cover':
      return {
        ...flag,
        state: {
          ...flag.state,
          rows: flag.state.rows.map(r =>
            r.facts.id === event.tokenId
              ? {
                  ...r,
                  coverOverride:
                    event.dr === null || !Number.isFinite(event.dr) ? null : Math.max(0, Math.floor(event.dr)),
                }
              : r
          ),
        },
      }
    case 'applied':
      return {
        ...flag,
        state: {
          ...flag.state,
          rows: flag.state.rows.map(r =>
            event.tokenIds.includes(r.facts.id)
              ? { ...r, applied: true, dive: r.dive.status === 'pending' ? { ...r.dive, status: 'none' } : r.dive }
              : r
          ),
        },
      }
    case 'enclosed':
      return { ...flag, state: { ...flag.state, setup: { ...flag.state.setup, enclosed: event.value } } }
    case 'templates':
      return { ...flag, templateIds: event.ids }
    default:
      return flag
  }
}
