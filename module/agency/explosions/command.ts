/**
 * GM chat command for IEDs, set charges and anything else that goes off without an attack roll:
 *
 *   /explode 4d cr ex [2d]               then click where it goes off
 *   /explode 2lb c4                      a charge by weight and explosive (B415, HT183)
 *   /explode 1lb black powder [1d]       a pipe bomb wrapped in nails
 *   /explode flashbang | smoke 8         special munitions
 *   /explode 4d+1 [2d] cr ex target      at the targeted token instead of a clicked point
 *   /explode 9d [2d] cr ex contact       the targeted token is lying on it (B415)
 *   /explode 3d cr ex internal           it goes off inside the targeted token (B415)
 *   ... enclosed | vented | thermobaric | underwater | vacuum | airburst
 */
import ChatProcessor from '../../chat/chat-processor.js'
import { parseExplodeCommand } from './command-parse.ts'
import { escapeHtml, localize } from './i18n.ts'
import { parseExplosive } from './parse.ts'
import { radii } from './resolve.ts'
import { explosionsEnabled } from './settings.ts'
import { pickPoint, tokenCenter } from './scene.ts'
import { matchSpecials, summarizeSpecials } from './specials.ts'
import { newBlastId, requestDetonation } from './detonate.ts'

export class ExplodeChatProcessor extends ChatProcessor {
  private args = ''

  override help() {
    return '/explode &lt;damage | weight explosive | flashbang | smoke&gt; [enclosed|thermobaric|airburst|target|contact|internal]'
  }

  override isGMOnly() {
    return true
  }

  override matches(line: string) {
    const match = line.match(/^\/explode(?:\s+([\s\S]*))?$/i)
    this.args = match?.[1]?.trim() ?? ''
    return !!match
  }

  override async process(_line: string) {
    if (!explosionsEnabled()) {
      this.priv(localize('command.disabled'))
      return false
    }
    const parsed = parseExplodeCommand(this.args)
    if ('error' in parsed) {
      this.priv(localize(`command.error.${parsed.error}`, { detail: escapeHtml(parsed.detail ?? '') }))
      this.priv(this.help())
      return false
    }
    const scene = canvas?.scene
    if (!scene) {
      this.priv(localize('command.noScene'))
      return false
    }

    let center
    let target: any = null
    if (parsed.options.atTarget) {
      const targets: any[] = Array.from((game.user as any)?.targets ?? [])
      if (targets.length !== 1) {
        this.priv(localize('command.oneTarget'))
        return false
      }
      target = targets[0]
      center = tokenCenter(target)
    } else {
      const spec = parseExplosive(parsed.damage)
      const reach = spec
        ? radii({
            spec,
            specials: summarizeSpecials(matchSpecials({ name: parsed.label, damage: parsed.damage, spec })),
          })
        : null
      center = await pickPoint({
        radii: [reach?.blast ?? 0, reach?.fragments ?? 0, reach?.affliction ?? 0, reach?.smoke ?? 0],
        hint: localize('command.pickHint', { label: parsed.label }),
      })
      if (!center) return false
    }

    const targetId = target?.document?.id ?? null
    if (parsed.charge)
      this.priv(
        localize('command.charge', {
          pounds: Math.round(parsed.charge.pounds * 100) / 100,
          explosive: parsed.charge.explosive.name,
          ref: parsed.charge.explosive.ref,
          damage: parsed.damage,
        })
      )
    await requestDetonation({
      id: newBlastId(),
      sceneId: scene.id!,
      center,
      label: parsed.label,
      damage: parsed.damage,
      weaponName: parsed.label,
      notes: '',
      attacker: null,
      struckTokenId: null,
      options: parsed.options,
      scatter: null,
      contactTokenId: parsed.options.contact ? targetId : null,
      internalTokenId: parsed.options.internal ? targetId : null,
      userId: game.user!.id,
    })
    return true
  }
}
