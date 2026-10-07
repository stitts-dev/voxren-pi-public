export const meta = {
  name: 'ship-lead',
  description: 'One area of a ship wave: check each triage card against origin/main and the decision log, write task cards, build each in its own worktree, skeptic-review and fix each pull request, then re-run every gate. Never merges, never posts, no paid runs.',
  whenToUse: 'Run by ship-wave as a child, once per area, with args area, cards and decisionLog. Not started by hand.',
  phases: [
    { title: 'Plan', detail: 'the lead drops false claims and writes task cards', model: 'sonnet' },
    { title: 'Build', detail: 'one builder per card in its own worktree: failing test first, change, mutation check, PR', model: 'sonnet' },
    { title: 'Review', detail: 'one skeptic per PR in its own detached worktree', model: 'sonnet' },
    { title: 'Fix', detail: 'a fresh fixer in the builder worktree, at most 2 rounds per PR', model: 'sonnet' },
    { title: 'Verify', detail: 'the lead re-runs every approved card gate on its PR branch', model: 'sonnet' },
  ],
}

// Contract: args { area: string, cards: TriageCard[], decisionLog?: number }.
// Returns { approved: [{task, pr}], failed: [{task, why}], decisions_needed: [{issue, question, options, recommendation}] }.
// Each decision also carries the issue it is about (beyond {question, options, recommendation}): the captain reads it to route the answer.
// A task is a card id; an issue that never became a card is named "#<issue>".

const RULES = `
REPOSITORY: stitts-dev/voxren-pi-public. <root> below is the absolute path that \`git rev-parse --show-toplevel\` prints from your starting directory (if it lies inside .claude/worktrees, use the parent directory of what \`git rev-parse --path-format=absolute --git-common-dir\` prints). Run it once and write the absolute path out in every later command: shell variables do not survive between Bash calls. <root> is the primary checkout: never edit, commit or switch branches there (a hook refuses it). Work ONLY in the worktree path named in your task, and start EVERY Bash call with \`cd <that worktree path> && ...\` (absolute path). Read AGENTS.md first: it is the contract. Rules that bite: 5 (no game fact from memory), 6 (a test runs a public function, never greps a source file), 9 (no empty catch, every catch calls logEvent), 10 (a fallback logs why), 11 (a degrading capability calls raiseNotice), 13 (no host, user name or home path in shipped files; src/portable.test.ts checks it).
SETUP: run \`npm ci\` in your worktree (never symlink node_modules). Fetch first: \`git -C <root> fetch origin\`.
FORBIDDEN, they cost money or touch live services: any paid model call or lab runner (just stories, just smoke, coach, pi, claude -p), installing or updating plugins, editing anything under ~/.claude, touching the Windows machine, editing stored data files. The shell is zsh: it does not word-split unquoted variables, so write every flag and path out in full. Never write \`cmd; echo $?\` and never pipe a test run through tail or head (a hook blocks both); run tests bare and read the pass/fail lines.
GIT: stage files by explicit path (never \`git add -A\`, never \`git commit -am\`). No Co-Authored-By line in commits. Never push to main, never merge, never force-push, never comment on or label an issue or a pull request, never approve on GitHub.
PR: title in the repository's style (look at \`git log --oneline -15 origin/main\`: "area: plain sentence of what now happens"), body in plain English: the cause, the change, how it was verified (the test seen failing before the change, each mutation check and its result, the commands run with their pass/fail counts), and what was not verified. End the body with the line: 🤖 Generated with [Claude Code](https://claude.com/claude-code)
EVIDENCE: report only what you ran and saw. If a check was not run, say so.`

const TASK_CARD_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'short, unique, lowercase and hyphenated, starting with the issue number, for example 123-lane-test' },
    issue: { type: 'integer' },
    objective: { type: 'string', description: 'one testable sentence, written like a test assertion' },
    gate: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'one shell command that fails before the change and passes after it' },
        expect: { type: 'string', description: 'what a pass looks like: the exit status and the output line that decides it' },
      },
      required: ['command', 'expect'],
    },
    files_owned: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'every file the change edits or adds, tests included, as repo-relative paths (files, not folders)' },
    steps: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'exact steps, in order: the file and place, the change, the failing test to write first, the mutation checks to run' },
    branch: { type: 'string', description: 'fix/<slug>, feat/<slug> or chore/<slug>' },
    depends_on: { type: 'array', items: { type: 'string' }, maxItems: 1, description: 'the id of the one card whose branch this card builds on, or empty' },
  },
  required: ['id', 'issue', 'objective', 'gate', 'files_owned', 'steps', 'branch', 'depends_on'],
}

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    issue: { type: 'integer' },
    question: { type: 'string', description: 'one question the owner can answer in a line' },
    options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
    recommendation: { type: 'string', description: 'the option you would pick, and why in one sentence' },
  },
  required: ['issue', 'question', 'options', 'recommendation'],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    tasks: { type: 'array', items: TASK_CARD_SCHEMA },
    dropped: {
      type: 'array',
      items: {
        type: 'object',
        properties: { issue: { type: 'integer' }, why: { type: 'string', description: 'the evidence: file, line and what it shows' } },
        required: ['issue', 'why'],
      },
    },
    decisions_needed: { type: 'array', items: DECISION_SCHEMA },
  },
  required: ['tasks', 'dropped', 'decisions_needed'],
}

const WORKER_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'the card id' },
    pr: { type: 'string', description: 'URL of the pull request you opened, or empty when you opened none' },
    failing_before: { type: 'string', description: 'which new test failed before the change and how you saw it' },
    mutations: { type: 'string', description: 'each mutation check and its result' },
    gate_output: { type: 'string', description: 'the gate command, its exit status and the output line that decides it' },
    not_verified: { type: 'string', description: 'what you did not run or could not check; the reason when no pull request was opened' },
  },
  required: ['task', 'pr', 'failing_before', 'mutations', 'gate_output', 'not_verified'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'the card id' },
    approve: { type: 'boolean', description: 'true only when must_fix is empty' },
    must_fix: { type: 'array', items: { type: 'string' }, description: 'defects that make the pull request wrong or unsafe to merge' },
    should_fix: { type: 'array', items: { type: 'string' }, description: 'real but smaller improvements worth one finishing pass' },
    evidence: { type: 'string', description: 'what you ran and saw, your own mutation check included, at most 150 words' },
  },
  required: ['task', 'approve', 'must_fix', 'should_fix', 'evidence'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    pushed: { type: 'boolean' },
    head: { type: 'string', description: 'the short commit id of the branch head after your push' },
    changes: { type: 'string' },
    checks: { type: 'string', description: 'commands run with pass/fail counts' },
    declined: { type: 'string', description: 'items not done and why' },
  },
  required: ['pushed', 'head', 'changes', 'checks', 'declined'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'the card id' },
          pass: { type: 'boolean' },
          output: { type: 'string', description: 'the output line that decided it, at most 200 characters' },
        },
        required: ['task', 'pass', 'output'],
      },
    },
  },
  required: ['results'],
}

const area = String(args?.area ?? '')
const cards = Array.isArray(args?.cards) ? args.cards : []
const decisionLog = Number.isInteger(args?.decisionLog) ? args.decisionLog : null
if (!area || !cards.length) throw new Error('ship-lead needs args.area and a non-empty args.cards (ship-wave passes them)')

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const out = { approved: [], failed: [], decisions_needed: [] }
const fail = (task, why) => {
  out.failed.push({ task, why })
  log(`${task}: ${why}`)
}

// ---------------------------------------------------------------- Plan

phase('Plan')
const decisionLine = decisionLog
  ? `The decision log is issue #${decisionLog}: read it with \`gh issue view ${decisionLog} --comments\`. A card the log settles follows the log. A card the log contradicts is dropped, or goes to decisions_needed, with the entry quoted.`
  : 'No decision log was given.'
const plan = await agent(
  `You are the lead for the "${area}" area of a ship wave on stitts-dev/voxren-pi-public. You write the plan: you change nothing, build nothing and open nothing.
Triage cards, one per issue, written by a quick pass that may be wrong:
${JSON.stringify(cards, null, 1)}
1. Run \`git -C <root> fetch origin\`, then read AGENTS.md. For each card read the issue (\`gh issue view <n> --comments\`) and check its claim against origin/main itself, never a local checkout: \`git -C <root> show origin/main:<path>\`, \`git -C <root> grep -n <pattern> origin/main -- <path>\`, \`git -C <root> log origin/main --oneline -30\` for work merged since. Also look for an open pull request that already does it (\`gh pr list --state open --search <n>\`). A claim that does not hold (already fixed, wrong file, wrong cause, already under review) is false: put its issue in dropped with the evidence.
2. ${decisionLine}
3. A card with needs_owner true, or whose fix is a choice between real options the log has not settled, gets no task: put its issue in decisions_needed with one question, 2 to 4 options and one recommendation. A needs_owner card the log already decides becomes a task like any other.
4. Every other card that holds becomes one TaskCard. The builder is a low-effort agent: the card carries all the thinking, so name the file, the place in it, the exact change, the failing test to write first, and the mutation checks (a change to the source that the new test must catch, reverted afterwards). The gate is the one command that fails before the change and passes after it.
5. Two cards never own the same file. When two would, keep both, and give the later one depends_on with the earlier one's id: it is then built on the earlier branch, after the earlier pull request is approved.
6. Each card's issue appears exactly once across tasks, dropped and decisions_needed. branch is fix/<slug>, feat/<slug> or chore/<slug>.
${RULES}`,
  { label: `plan ${area}`, phase: 'Plan', schema: PLAN_SCHEMA, model: 'sonnet', effort: 'high' },
)
if (!plan) {
  for (const c of cards) fail(`#${c.issue}`, 'the lead plan returned nothing')
  return out
}

const wanted = new Set(cards.map((c) => c.issue))
const accounted = new Set()
const tasks = []
for (const t of plan.tasks) {
  if (!wanted.has(t.issue)) log(`${t.id}: issue #${t.issue} is not one of this area's cards, left out`)
  else if (tasks.some((x) => x.id === t.id)) fail(`${t.id} (duplicate)`, 'a second card with this id was left out')
  else {
    tasks.push(t)
    accounted.add(t.issue)
  }
}
for (const d of plan.dropped) {
  if (wanted.has(d.issue)) fail(`#${d.issue}`, `dropped by the lead: ${d.why}`)
  accounted.add(d.issue)
}
for (const d of plan.decisions_needed) {
  if (wanted.has(d.issue)) out.decisions_needed.push(d)
  accounted.add(d.issue)
}
for (const c of cards) if (!accounted.has(c.issue)) fail(`#${c.issue}`, 'the lead gave it no task, drop or decision')

// Branches stay unique, so no two builders share a worktree. Cards that share a file (an exact path match) form a group, and a
// group is built as a chain in plan order, each card on the branch of the one before it. A depends_on the lead wrote for any
// other reason is kept only when it names an earlier card, which also rules out a cycle and a card that does not exist.
const arrange = (list) => {
  const branches = new Set()
  const uniq = list.map((t) => {
    let branch = String(t.branch).toLowerCase().split('/').map(slug).filter(Boolean).join('/') || `chore/${slug(t.id)}`
    // The worktree folder is the branch with / replaced by -, so fix/a-b and fix/a/b would share one: dedupe on both.
    for (let n = 2; branches.has(branch) || branches.has(branch.replace(/\//g, '-')); n++) branch = `${branch.replace(/-\d+$/, '')}-${n}`
    branches.add(branch)
    branches.add(branch.replace(/\//g, '-'))
    return { ...t, branch, slug: branch.replace(/\//g, '-'), files_owned: [...new Set(t.files_owned.map((f) => f.replace(/^\.\//, '')))] }
  })
  const position = new Map(uniq.map((t, i) => [t.id, i]))
  const parent = new Map(uniq.map((t) => [t.id, t.id]))
  const root = (id) => (parent.get(id) === id ? id : root(parent.get(id)))
  const owner = new Map()
  for (const t of uniq)
    for (const f of t.files_owned) {
      if (owner.has(f)) parent.set(root(t.id), root(owner.get(f)))
      else owner.set(f, t.id)
    }
  const previous = new Map()
  return uniq.map((t, i) => {
    const before = previous.get(root(t.id))
    previous.set(root(t.id), t.id)
    return { ...t, depends_on: before ? [before] : (t.depends_on ?? []).filter((d) => position.get(d) < i).slice(0, 1) }
  })
}
const planned = arrange(tasks)
const byId = new Map(planned.map((t) => [t.id, t]))
for (const t of planned) if (t.depends_on.length) log(`${t.id} is built on ${t.depends_on[0]}`)
if (!planned.length) return out

// ---------------------------------------------------------------- Build, review, fix (one flow per card)

const buildPrompt = (t, dep) => `Build task ${t.id} (issue #${t.issue}) on stitts-dev/voxren-pi-public and open a pull request. The card carries the thinking: follow it exactly. If a step cannot be done as written (a file moved, the claim no longer holds on origin/main), stop, open no pull request, leave pr empty and say why in not_verified.
Objective: ${t.objective}
Gate: run \`${t.gate.command}\`; a pass is: ${t.gate.expect}
Files you own, the only files you may change: ${t.files_owned.join(', ')}
Steps, in order:
${t.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
Create your worktree first: \`git -C <root> fetch origin && git -C <root> worktree add <root>/.claude/worktrees/${t.slug} -b ${t.branch} origin/${dep ? dep.branch : 'main'}\`. Your worktree path is <root>/.claude/worktrees/${t.slug}; leave it in place when done, and never commit the .claude/worktrees folder itself. Branch name: ${t.branch}.${dep ? ` This card is built on ${dep.branch}, the branch of an approved pull request, so its commits are already in your worktree.` : ''}
Order of work: write the failing test first and see it fail; make the change; run the gate; then commit the change and run each mutation check on top of it, reverting each one with \`git checkout -- <file>\` so the tree is clean again; push with \`git push -u origin ${t.branch}\`; open the pull request with \`gh pr create --base ${dep ? dep.branch : 'main'} --repo stitts-dev/voxren-pi-public\`. The body says \`Refs #${t.issue}\` and never Closes or Fixes: the captain closes issues when it merges.
Return the pull request URL in pr.
${RULES}`

const skeptic = (t, w, dep, round) => agent(
  `You are the skeptic for the pull request ${w.pr} (branch ${t.branch}, base ${dep ? dep.branch : 'main'}) on stitts-dev/voxren-pi-public, which does task ${t.id} for issue #${t.issue}. Review round ${round}. Try to find what is wrong.
Your worktree path is <root>/.claude/worktrees/review-${t.slug}. If it does not exist, create it: \`git -C <root> fetch origin ${t.branch} && git -C <root> worktree add --detach <root>/.claude/worktrees/review-${t.slug} FETCH_HEAD\`; if it exists, \`cd\` there, run \`git fetch origin ${t.branch} && git checkout --detach FETCH_HEAD\`. Run \`npm ci\` if node_modules is missing. Restore every mutation with \`git checkout -- .\` before you finish. Read \`gh pr diff ${w.pr}\` and the pull request body.
Check: (1) the change does what the card asks and nothing beyond it, and touches only the files it owns; (2) mutation check yourself: put back the pre-change source (keep the new tests) and confirm the new tests fail, then remove each new guard one at a time and confirm a test fails; if the auto-mode classifier refuses a mutation run, argue by reading and say so; (3) AGENTS.md rules 5, 6, 9, 10, 11 and 13; (4) the pull request body's claims match what you see, and it says Refs #${t.issue}, never Closes or Fixes; (5) the gate and the relevant tests pass, and \`npm run typecheck\` does. Do not edit the branch, push, comment, approve on GitHub or merge.
must_fix: defects that make the pull request wrong or unsafe to merge. should_fix: real but smaller improvements worth one finishing pass. Leave both empty only when you found nothing. approve is true only when must_fix is empty.
The card the builder had:
${JSON.stringify({ objective: t.objective, gate: t.gate, files_owned: t.files_owned, steps: t.steps })}
The builder reported: failing test before the change: ${w.failing_before}. Mutation checks: ${w.mutations}. Not verified: ${w.not_verified}
${RULES}`,
  { label: `skeptic ${t.id} r${round}`, phase: 'Review', schema: VERDICT_SCHEMA, model: 'sonnet', effort: 'medium' },
)

const fixer = (t, w, v, round) => agent(
  `Finish the pull request ${w.pr} (branch ${t.branch}) on stitts-dev/voxren-pi-public for task ${t.id}, issue #${t.issue}. Work in the builder's worktree <root>/.claude/worktrees/${t.slug} (branch ${t.branch} is checked out there): \`cd\` there, run \`git pull --ff-only origin ${t.branch}\`, and apply the skeptic's items below. Do every must_fix item. Do each should_fix item unless it would widen the change beyond the card; list any you decline and why. Each new or changed test must be seen failing before its fix. Commit (files staged by path), run \`git push origin ${t.branch}\` (never force), and update the pull request body with \`gh pr edit ${w.pr} --body-file <file>\` if its claims changed.
must_fix: ${JSON.stringify(v.must_fix)}
should_fix: ${JSON.stringify(v.should_fix)}
Skeptic evidence: ${v.evidence}
The card:
${JSON.stringify({ objective: t.objective, gate: t.gate, files_owned: t.files_owned, steps: t.steps })}
${RULES}`,
  { label: `fix ${t.id} r${round}`, phase: 'Fix', schema: FIX_SCHEMA, model: 'sonnet', effort: 'medium' },
)

// A card on another card's branch starts only once that card is approved, so it sits on the branch's final head.
const settled = new Map()
const ship = (t) => {
  if (!settled.has(t.id)) {
    settled.set(t.id, flow(t).catch((e) => {
      log(`${t.id} crashed: ${e?.message ?? e}`)
      return { task: t.id, approved: false, why: `its flow crashed: ${e?.message ?? e}` }
    }))
  }
  return settled.get(t.id)
}

async function flow(t) {
  let dep = null
  if (t.depends_on.length) {
    dep = await ship(byId.get(t.depends_on[0]))
    if (!dep.approved) return { task: t.id, approved: false, why: `built on ${t.depends_on[0]}, which was not approved: ${dep.why}` }
  }
  const w = await agent(buildPrompt(t, dep), { label: `build ${t.id}`, phase: 'Build', schema: WORKER_RESULT_SCHEMA, model: 'sonnet', effort: 'low' })
  if (!w) return { task: t.id, approved: false, why: 'the builder returned nothing' }
  if (!w.pr) return { task: t.id, approved: false, why: `no pull request opened: ${w.not_verified}` }
  let v = await skeptic(t, w, dep, 1)
  for (let round = 1; round <= 2 && v && (v.must_fix.length || v.should_fix.length); round++) {
    const fix = await fixer(t, w, v, round)
    if (!fix || !fix.pushed) break
    v = await skeptic(t, w, dep, round + 1)
  }
  if (!v) return { task: t.id, approved: false, why: `the skeptic returned nothing (${w.pr})` }
  if (!v.approve || v.must_fix.length) return { task: t.id, approved: false, why: `not approved after the fix rounds: ${v.must_fix.join('; ') || v.evidence} (${w.pr})` }
  if (v.should_fix.length) log(`${t.id}: approved with optional items left: ${v.should_fix.join('; ')}`)
  return { task: t.id, approved: true, pr: w.pr, branch: t.branch }
}

const shipped = await parallel(planned.map((t) => () => ship(t)))

// ---------------------------------------------------------------- Verify

const ready = shipped.filter((s) => s && s.approved)
for (const s of shipped) if (s && !s.approved) fail(s.task, s.why)
if (!ready.length) return out

phase('Verify')
const verified = await agent(
  `You are the lead for the "${area}" area, and the last gate before a pull request counts as approved. Re-run every card's gate yourself on its pull request branch; trust no builder's gate_output.
Your worktree path is <root>/.claude/worktrees/verify-${slug(area)}. If it does not exist, create it: \`git -C <root> fetch origin && git -C <root> worktree add --detach <root>/.claude/worktrees/verify-${slug(area)} origin/main\`. For each card below, in order: \`cd\` there, run \`git fetch origin <branch> && git checkout --detach FETCH_HEAD\`, run \`npm ci\` when node_modules is missing or package-lock.json differs from the last install, then run the gate command exactly as written. pass is true only when the command ran and printed what the card expects. Report pass false when it errors, prints something else, or cannot run, and give the output line that decided it. Do not edit files, push, comment, approve or merge.
Cards:
${JSON.stringify(ready.map((s) => ({ id: s.task, branch: s.branch, pr: s.pr, gate: byId.get(s.task).gate })), null, 1)}
${RULES}`,
  { label: `verify ${area}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: 'sonnet', effort: 'high' },
)
const verifyFailed = new Set()
for (const s of ready) {
  const r = verified?.results.find((x) => x.task === s.task)
  const parent = byId.get(s.task).depends_on[0]
  // A child stacked on a parent whose gate failed here must not stay approved: its PR base is the failing parent's branch.
  if (parent && verifyFailed.has(parent)) {
    verifyFailed.add(s.task)
    fail(s.task, `built on ${parent}, whose gate failed in the lead verify (${s.pr})`)
  } else if (r?.pass) out.approved.push({ task: s.task, pr: s.pr })
  else {
    verifyFailed.add(s.task)
    fail(s.task, r ? `its gate failed on the PR branch: ${r.output} (${s.pr})` : `the lead verify gave no result for it (${s.pr})`)
  }
}
return out
