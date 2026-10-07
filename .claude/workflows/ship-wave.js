export const meta = {
  name: 'ship-wave',
  description: 'Take a list of GitHub issues to approved pull requests: triage each issue, group by area, run one ship-lead child per area. Never merges, never posts to GitHub, no paid runs; the captain merges and writes the decision log.',
  whenToUse: 'The captain session, with args issues (an array of issue numbers) and optionally decisionLog (the number of the decision log issue)',
  phases: [
    { title: 'Triage', detail: 'one read-only agent per issue returns a triage card', model: 'haiku' },
    { title: 'Ship', detail: 'one ship-lead child run per area: plan, build, review, fix, verify' },
  ],
}

// Contract: args { issues: number[], decisionLog?: number }.
// Returns { approved: [{task, pr}], failed: [{task, why}], decisions_needed: [{issue, question, options, recommendation}] }.
// Each decision also carries the issue it is about (beyond {question, options, recommendation}): the captain reads it to route the answer.
// ship-lead returns the same three lists for its area, so this script only adds the issues no area ran.

const TRIAGE_CARD_SCHEMA = {
  type: 'object',
  properties: {
    issue: { type: 'integer' },
    kind: { type: 'string', enum: ['bug', 'feature', 'chore'] },
    area: { type: 'string', description: 'the subsystem the fix lands in: one lowercase word or two hyphenated, named the way the Layout table in AGENTS.md names the module or folder' },
    size: { type: 'string', enum: ['xs', 's', 'm', 'l'], description: 'xs: one line or a test only; s: one file; m: a few files; l: more than that' },
    claim: { type: 'string', description: 'the one checkable statement the issue rests on, naming the file or behaviour it is about' },
    needs_owner: { type: 'boolean', description: 'true when no code can be written until the owner decides something, supplies a secret, or does a step only a human can do' },
    confidence: { type: 'number', description: 'from 0 to 1: how sure you are the claim still holds on origin/main' },
  },
  required: ['issue', 'kind', 'area', 'size', 'claim', 'needs_owner', 'confidence'],
}

const issues = [...new Set(Array.isArray(args?.issues) ? args.issues : [])]
if (!issues.length || !issues.every((n) => Number.isInteger(n) && n > 0)) throw new Error('ship-wave needs args.issues: a non-empty array of issue numbers')
const decisionLog = Number.isInteger(args?.decisionLog) ? args.decisionLog : undefined

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const out = { approved: [], failed: [], decisions_needed: [] }

// ---------------------------------------------------------------- Triage

phase('Triage')
const triaged = await parallel(
  issues.map((n) => () => agent(
    `Triage GitHub issue #${n} on stitts-dev/voxren-pi-public. You are read-only: change no file, make no branch, post nothing, run no model. Read the issue with \`gh issue view ${n} --comments\`, and the Layout table in AGENTS.md (in the repository you start in) for the module names. Look at the code the issue names with \`git grep\` and \`git show origin/main:<path>\`, so you judge origin/main and not a stale checkout. Return one triage card: kind, area, size, claim, needs_owner, confidence. Stay short: this is a first pass, a lead checks the claim against the code afterwards.`,
    { label: `triage #${n}`, phase: 'Triage', schema: TRIAGE_CARD_SCHEMA, model: 'haiku', effort: 'low' },
  )),
)

// Cards are grouped by area, so the area names are made to match, and the issue number is the one asked for.
const byArea = new Map()
triaged.forEach((card, i) => {
  if (!card) {
    out.failed.push({ task: `#${issues[i]}`, why: 'triage returned nothing' })
    return
  }
  const area = slug(card.area) || 'misc'
  byArea.set(area, [...(byArea.get(area) ?? []), { ...card, issue: issues[i], area }])
})
log(`${issues.length} issues triaged into ${byArea.size} areas: ${[...byArea].map(([a, g]) => `${a} (${g.length})`).join(', ')}`)

// ---------------------------------------------------------------- Ship

phase('Ship')
const areas = [...byArea]
const runs = await parallel(
  areas.map(([area, group]) => async () => {
    try {
      return await workflow('ship-lead', { area, cards: group, decisionLog })
    } catch (e) {
      log(`ship-lead for ${area} crashed: ${e?.message ?? e}`)
      return { crashed: String(e?.message ?? e) }
    }
  }),
)
runs.forEach((run, i) => {
  const [area, group] = areas[i]
  if (!run || run.crashed) {
    for (const c of group) out.failed.push({ task: `#${c.issue}`, why: `ship-lead for ${area} ${run ? `crashed: ${run.crashed}` : 'returned nothing'}` })
    return
  }
  out.approved.push(...(run.approved ?? []))
  out.failed.push(...(run.failed ?? []))
  out.decisions_needed.push(...(run.decisions_needed ?? []))
})
log(`${out.approved.length} approved, ${out.failed.length} failed, ${out.decisions_needed.length} decisions needed`)
return out
