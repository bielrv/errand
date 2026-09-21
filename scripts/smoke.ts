/**
 * End-to-end check with no phone call and no provider accounts.
 *
 * Queues a task, replays the webhooks Vapi would send during a real call, and
 * asserts the task ends in the right state. Run it after changing prompts,
 * tools or the orchestrator:
 *
 *   npm run smoke
 */
import { buildAssistant } from '../src/providers/vapi.js'
import * as store from '../src/db.js'
import { parseWhen } from '../src/tools.js'
import { nextOpenSlot, withinBusinessHours } from '../src/orchestrator.js'
import { TaskInput } from '../src/types.js'

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000'
const SECRET = process.env.WEBHOOK_SECRET ?? 'smoke-test-secret'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`)
  if (!ok) {
    failures++
    if (detail !== undefined) console.log('        ', detail)
  }
}

async function toolCall(taskId: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE}/webhooks/vapi/tool/${taskId}?secret=${SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        type: 'tool-calls',
        call: { id: 'smoke-call-1' },
        toolCallList: [{ id: `tc-${name}`, function: { name, arguments: args } }],
      },
    }),
  })
  const body = (await res.json()) as { results?: { result: string }[] }
  return body.results?.[0]?.result ?? ''
}

async function main() {
  const health = await fetch(`${BASE}/health`).catch(() => null)
  if (!health?.ok) {
    console.error(`No server on ${BASE}. Start it with: npm start`)
    process.exit(1)
  }

  // A task far enough in the future that the orchestrator will not dial it.
  const input = TaskInput.parse({
    title: 'smoke test',
    objective: 'Confirm the plumbing works without calling anyone.',
    callee: { name: 'Nobody Ltd', phone: '+442079460000', timezone: 'Europe/London' },
    facts: [
      { key: 'address', label: 'Address', value: '12 Elm Road', disclosure: 'proactive' },
      { key: 'account_number', label: 'Account number', value: '8829301', disclosure: 'on_request' },
      { key: 'portal_password', label: 'Portal password', value: 'hunter2', disclosure: 'never' },
    ],
    constraints: ['Do not agree to a new tariff.'],
    success: ['An engineer is booked.'],
    notBefore: new Date(Date.now() + 365 * 86400_000).toISOString(),
  })
  const task = store.createTask(input)
  console.log(`\ntask ${task.id.slice(0, 8)}\n`)

  /* ---- prompt composition ---------------------------------------------- */
  const assistant = buildAssistant(task) as {
    model: { messages: { content: string }[]; tools: unknown[] }
    firstMessage: string
  }
  const prompt = assistant.model.messages[0]!.content
  check('proactive facts reach the prompt', prompt.includes('12 Elm Road'))
  check('on_request facts are withheld from the prompt', !prompt.includes('8829301'))
  check('never-disclose facts are withheld', !prompt.includes('hunter2'))
  check('task constraints reach the prompt', prompt.includes('Do not agree to a new tariff'))
  check('success criteria reach the prompt', prompt.includes('An engineer is booked'))
  check('universal rails are present', prompt.includes('NON-NEGOTIABLE'))
  check('six tools are exposed', assistant.model.tools.length === 6, assistant.model.tools.length)
  check('opening line discloses the AI', /AI assistant/i.test(assistant.firstMessage))
  check('opening line names the principal', assistant.firstMessage.includes('Gabriel Rosinol'))

  /* ---- tool round trips ------------------------------------------------- */
  const acct = await toolCall(task.id, 'lookup_fact', { key: 'account_number' })
  check('lookup_fact returns an on_request fact', acct.includes('8829301'), acct)

  const secret = await toolCall(task.id, 'lookup_fact', { key: 'portal_password' })
  check('lookup_fact refuses a never fact', !secret.includes('hunter2'), secret)

  const missing = await toolCall(task.id, 'lookup_fact', { key: 'date_of_birth' })
  check('lookup_fact refuses to invent', /do not guess/i.test(missing), missing)

  await toolCall(task.id, 'record', { key: 'reference_number', value: 'REF-99812' })
  check('record persists a finding', store.getTask(task.id)?.findings.reference_number === 'REF-99812')

  check(
    'disclosures are audited',
    store.disclosuresForTask(task.id).map((d) => d.factKey).join(',') === 'account_number',
    store.disclosuresForTask(task.id),
  )

  await toolCall(task.id, 'schedule_callback', { when: 'tomorrow 10am', reason: 'Repairs team closed.' })
  const afterCallback = store.getTask(task.id)!
  check('schedule_callback moves the task to waiting_callback', afterCallback.status === 'waiting_callback')
  check('schedule_callback sets a future time', new Date(afterCallback.nextAttemptAt) > new Date())

  await toolCall(task.id, 'finish', { status: 'needs_human', summary: 'They want the account holder.' })
  const finished = store.getTask(task.id)!
  check('finish records status', finished.status === 'needs_human')
  check('finish records a summary', finished.summary === 'They want the account holder.')

  /* ---- scheduling ------------------------------------------------------- */
  const office = { ...task, callee: { ...task.callee, businessHours: { open: 9, close: 17, days: [1, 2, 3, 4, 5] } } }
  const sundayNoon = new Date('2026-09-20T12:00:00Z')
  const tuesday3am = new Date('2026-09-22T03:00:00Z')
  const tuesday11am = new Date('2026-09-22T11:00:00Z')
  check('closed on Sunday', !withinBusinessHours(office, sundayNoon))
  check('closed at 3am', !withinBusinessHours(office, tuesday3am))
  check('open Tuesday 11am', withinBusinessHours(office, tuesday11am))
  check('next slot after Sunday noon is inside hours', withinBusinessHours(office, nextOpenSlot(office, sundayNoon)))

  const tomorrow = parseWhen('tomorrow 9am', new Date('2026-09-21T15:00:00Z'))
  check('parseWhen handles "tomorrow 9am"', tomorrow.getDate() === 22, tomorrow.toISOString())
  const iso = parseWhen('2026-10-01T09:30:00Z')
  check('parseWhen handles ISO', iso.toISOString() === '2026-10-01T09:30:00.000Z', iso.toISOString())
  const vague = parseWhen('sometime soon-ish', new Date('2026-09-21T15:00:00Z'))
  check('parseWhen falls back rather than throwing', vague > new Date('2026-09-21T15:00:00Z'))

  /* ---- auth ------------------------------------------------------------- */
  const bad = await fetch(`${BASE}/webhooks/vapi/tool/${task.id}?secret=wrong`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { type: 'tool-calls', toolCallList: [] } }),
  })
  check('a wrong webhook secret is rejected', bad.status === 401, bad.status)

  console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
