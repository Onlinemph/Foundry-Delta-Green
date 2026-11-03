/**
 * Render suppression that can't get stuck and doesn't lose renders.
 *
 * Upstream GURPS sets `actor.ignoreRender = true` around multi-step updates so the sheet doesn't
 * flash, and the sheet's _render() silently returns while it's set. Two problems:
 *  1. Several code paths return early or throw without clearing the flag, so the sheet on that
 *     client stops updating until something else forces a render.
 *  2. Renders requested while suppressed (including ones caused by other players' changes) are
 *     dropped, not deferred, so the sheet keeps showing old data.
 *
 * This class backs `GurpsActor#ignoreRender`: renders requested while suppressed are remembered and
 * flushed when suppression ends, and suppression left on longer than `staleAfterMs` lapses.
 */
export const STALE_SUPPRESSION_MS = 15_000

export class RenderSuppression {
  private suppressed = false
  private since = 0
  private pending = false

  constructor(
    private readonly flush: () => void,
    private readonly now: () => number = Date.now,
    private readonly staleAfterMs: number = STALE_SUPPRESSION_MS,
    private readonly onStale: () => void = () => {}
  ) {}

  /** True while renders should be held back. Lapses (and flushes) if left on too long. */
  get active(): boolean {
    if (this.suppressed && this.now() - this.since > this.staleAfterMs) {
      this.onStale()
      this.set(false)
    }
    return this.suppressed
  }

  set(value: boolean): void {
    if (value) {
      // Keep the original start time when already suppressed, so nested set(true) calls
      // can't keep a stuck flag alive forever.
      if (!this.suppressed) this.since = this.now()
      this.suppressed = true
      return
    }
    this.suppressed = false
    if (this.pending) {
      this.pending = false
      this.flush()
    }
  }

  /** Remember that a render was requested while suppressed. */
  markPending(): void {
    this.pending = true
  }

  get hasPending(): boolean {
    return this.pending
  }
}
