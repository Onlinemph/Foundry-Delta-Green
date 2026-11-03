/**
 * Agency sanity: buttons on the SAN result card (project onto a Bond, record a disorder, raise Unnatural).
 */
import { createCard, NOTE_TEMPLATE } from './roll.ts'
import { getLastLoss, getSanity, LAST_LOSS_FLAG, newId, type SanityActor, sanityUpdate, t, willOf } from './data.ts'
import { nextBreakingPoint, projectOntoBond, reconcileSanityChange, type SanityData } from './rules.ts'

function escape(text: string): string {
  return foundry.utils.escapeHTML(String(text ?? ''))
}

function actorFrom(uuid: string | undefined): SanityActor | null {
  if (!uuid) return null
  const doc = (globalThis as any).fromUuidSync?.(uuid)
  return doc && doc.documentName === 'Actor' ? (doc as SanityActor) : null
}

function canEdit(actor: SanityActor | null): actor is SanityActor {
  if (!actor) {
    ui.notifications?.warn(t('errors.noActor'))
    return false
  }
  if (!actor.isOwner) {
    ui.notifications?.warn(t('errors.notOwner', { name: actor.name }))
    return false
  }
  return true
}

async function postNote(actor: SanityActor, title: string, lines: string[], rolls: Roll[] = []): Promise<void> {
  await createCard(actor, NOTE_TEMPLATE, { actorName: actor.name, title, lines }, rolls)
}

/** Ask for a disorder name. Returns null if cancelled. */
export async function promptDisorder(actor: SanityActor): Promise<string | null> {
  try {
    const name = await foundry.applications.api.DialogV2.prompt({
      window: { title: t('disorderPrompt.title', { name: actor.name }) },
      content: `<p>${t('disorderPrompt.text')}</p>
        <input type="text" name="disorder" autofocus placeholder="${escape(t('disorderPrompt.placeholder'))}" style="width:100%" />`,
      ok: {
        label: t('disorderPrompt.ok'),
        callback: (_event: Event, button: HTMLButtonElement) =>
          String((button.form!.elements as any).disorder.value ?? '').trim(),
      },
      rejectClose: false,
    } as any)
    return typeof name === 'string' && name ? name : null
  } catch {
    return null
  }
}

/** Record a disorder; if `resetBreakingPoint`, also reset BP to SAN − Will (manual breaking point). */
export async function recordDisorder(actor: SanityActor, resetBreakingPoint: boolean): Promise<void> {
  const name = await promptDisorder(actor)
  if (!name) return
  const s: SanityData = getSanity(actor)
  s.disorders = [...s.disorders, { id: newId(), name }]
  const lines = [t('note.disorder', { name: escape(actor.name), disorder: escape(name) })]
  if (resetBreakingPoint) {
    const bp = nextBreakingPoint(s.value, willOf(actor))
    lines.push(t('note.bpReset', { before: s.breakingPoint, after: bp }))
    s.breakingPoint = bp
  }
  await actor.update(sanityUpdate(s))
  await postNote(actor, t('note.disorderTitle'), lines)
}

async function chooseBond(actor: SanityActor): Promise<string | null> {
  const bonds = getSanity(actor).bonds.filter(b => b.score > 0)
  if (bonds.length === 0) {
    ui.notifications?.warn(t('errors.noBonds'))
    return null
  }
  const options = bonds
    .map(b => `<option value="${escape(b.id)}">${escape(b.name || t('unnamedBond'))} (${b.score})</option>`)
    .join('')
  try {
    const id = await foundry.applications.api.DialogV2.prompt({
      window: { title: t('project.title', { name: actor.name }) },
      content: `<p>${t('project.text')}</p><select name="bond" style="width:100%">${options}</select>`,
      ok: {
        label: t('project.ok'),
        icon: 'fa-solid fa-dice-d4',
        callback: (_event: Event, button: HTMLButtonElement) => String((button.form!.elements as any).bond.value),
      },
      rejectClose: false,
    } as any)
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

export async function projectLoss(actor: SanityActor, lossId: string): Promise<void> {
  const last = getLastLoss(actor)
  if (!last || last.id !== lossId) {
    ui.notifications?.warn(t('errors.notLatest'))
    return
  }
  if (last.projected) {
    ui.notifications?.warn(t('errors.alreadyProjected'))
    return
  }
  const bondId = await chooseBond(actor)
  if (!bondId) return

  const roll = new Roll('1d4')
  await roll.evaluate()
  // Re-read: the dialog was open for a while.
  const result = projectOntoBond(getSanity(actor), getLastLoss(actor)!, bondId, roll.total ?? 0)
  if (!result.ok) {
    ui.notifications?.warn(t(`errors.${result.reason}`))
    return
  }
  await actor.update({ ...sanityUpdate(result.state), [LAST_LOSS_FLAG]: result.lastLoss })

  const lines = [
    t('note.projected', {
      name: escape(actor.name),
      roll: result.roll,
      refund: result.refund,
      bond: escape(result.bond.name || t('unnamedBond')),
      before: result.bond.before,
      after: result.bond.after,
    }),
    t('note.sanNow', { value: result.state.value, max: result.state.max }),
  ]
  if (result.bond.after === 0) lines.push(t('note.bondBroken', { bond: escape(result.bond.name) }))
  if (result.bpReverted) lines.push(t('note.bpReverted', { bp: result.state.breakingPoint }))
  if (result.temporaryInsanityAverted) lines.push(t('note.insanityAverted', { remaining: result.remaining }))
  await postNote(actor, t('note.projectTitle'), lines, [roll])
}

/** GM only. Returns true if Unnatural was raised. */
export async function raiseUnnatural(actor: SanityActor, amount: number): Promise<boolean> {
  if (!game.user?.isGM || amount <= 0) return false
  const s = getSanity(actor)
  const patch = reconcileSanityChange(s, { unnatural: s.unnatural + amount })
  const proceed = await foundry.applications.api.DialogV2.confirm({
    window: { title: t('unnaturalPrompt.title') },
    content: `<p>${t('unnaturalPrompt.text', {
      name: escape(actor.name),
      amount,
      before: s.unnatural,
      after: patch.unnatural ?? s.unnatural,
      max: patch.max ?? s.max,
    })}</p>`,
    rejectClose: false,
  } as any)
  if (!proceed) return false
  await actor.update(sanityUpdate({ ...s, ...patch }))
  await postNote(actor, t('note.unnaturalTitle'), [
    t('note.unnatural', {
      name: escape(actor.name),
      before: s.unnatural,
      after: patch.unnatural ?? s.unnatural,
      max: patch.max ?? s.max,
    }),
  ])
  return true
}

/** renderChatMessageHTML: wire the card's buttons, hiding them from users who cannot use them. */
export function onRenderChatMessage(_message: unknown, html: HTMLElement): void {
  const card = html.querySelector<HTMLElement>('.agency-sanity-card')
  if (!card) return
  const actor = actorFrom(card.dataset.actorUuid)
  for (const button of Array.from(card.querySelectorAll<HTMLButtonElement>('button[data-san-action]'))) {
    const action = button.dataset.sanAction
    const allowed = action === 'unnatural' ? !!game.user?.isGM : !!actor?.isOwner
    if (!allowed) {
      button.remove()
      continue
    }
    const projectable = () => {
      const last = actor ? getLastLoss(actor) : null
      return !!last && last.id === card.dataset.lossId && !last.projected && last.amount > 0
    }
    if (action === 'project' && !projectable()) button.disabled = true
    button.addEventListener('click', async event => {
      event.preventDefault()
      const target = actorFrom(card.dataset.actorUuid)
      if (!canEdit(target)) return
      button.disabled = true
      let done = false
      try {
        if (action === 'project') await projectLoss(target, card.dataset.lossId ?? '')
        else if (action === 'disorder') await recordDisorder(target, false)
        else if (action === 'unnatural')
          done = await raiseUnnatural(target, parseInt(button.dataset.amount ?? '0', 10) || 0)
      } finally {
        // A cancelled projection can be tried again; a completed one cannot. Unnatural is raised once.
        button.disabled = action === 'project' ? !projectable() : done
      }
    })
  }
}
