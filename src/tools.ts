import { config } from './config.js'
import * as store from './db.js'
import { askPrincipal, requestApproval, waitForAnswer } from './notify.js'
import type { Task } from './types.js'

/**
 * The agent's capability set. This list is identical for every task - that is
 * what makes the system generic. A task supplies goals and facts; these six
 * verbs are how any task gets worked.
 */

type ToolDef = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
  server: { url: string }
}

const obj = (props: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties: props,
  required,
})

export function toolDefinitions(taskId: string): ToolDef[] {
  const url = `${config.publicUrl}/webhooks/vapi/tool/${taskId}?secret=${config.webhookSecret}`
  const t = (name: string, description: string, parameters: Record<string, unknown>): ToolDef => ({
    type: 'function',
    function: { name, description, parameters },
    server: { url },
  })

  return [
    t(
      'lookup_fact',
      'Retrieve a detail about the account holder or the account that you were not given upfront, such as an account number, date of birth or postcode. Call this the instant you are asked for one.',
      obj({ key: { type: 'string', description: 'The fact key, exactly as listed in your brief.' } }, ['key']),
    ),
    t(
      'record',
      'Save something worth keeping from this call: a reference number, an appointment slot, the name of the person you are speaking to, a promised call-back date. Call it as soon as you hear the information.',
      obj(
        {
          key: { type: 'string', description: 'Short snake_case label, e.g. reference_number.' },
          value: { type: 'string' },
        },
        ['key', 'value'],
      ),
    ),
    t(
      'ask_principal',
      'Send the account holder a text message and wait on the line for his reply. Use for one-time passcodes, or any decision only he can make. Tell the caller you are checking with the account holder before you call this.',
      obj(
        {
          question: {
            type: 'string',
            description: 'One clear question. Include the context he needs to answer in one line.',
          },
        },
        ['question'],
      ),
    ),
    t(
      'request_approval',
      'Ask the account holder to approve something binding: a cost, a contract or tariff change, a cancellation, a chargeable appointment. You must call this BEFORE agreeing. No reply means declined.',
      obj(
        {
          action: { type: 'string', description: 'What you would be agreeing to, in a few words.' },
          detail: { type: 'string', description: 'Cost, dates, terms, and anything he should weigh up.' },
        },
        ['action', 'detail'],
      ),
    ),
    t(
      'schedule_callback',
      'Arrange for this task to be retried later: they asked you to call back, the department is closed, or the account holder has to be present.',
      obj(
        {
          when: { type: 'string', description: 'ISO 8601 datetime, or a plain phrase like "tomorrow 9am".' },
          reason: { type: 'string' },
        },
        ['when', 'reason'],
      ),
    ),
    t(
      'finish',
      'End the task. Always call this before hanging up, including when the call went badly.',
      obj(
        {
          status: {
            type: 'string',
            enum: ['done', 'needs_human', 'failed'],
            description:
              "'done' only if the objective was actually achieved. 'needs_human' if the account holder must take it from here. 'failed' if it cannot be achieved at all.",
          },
          summary: { type: 'string', description: 'What happened and what was agreed, in a few sentences.' },
        },
        ['status', 'summary'],
      ),
    ),
  ]
}

/* ------------------------------------------------------------- handlers -- */

type Handler = (task: Task, callId: string | null, args: Record<string, unknown>) => Promise<string>

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''))

/**
 * Handlers return a plain string, which is spoken back into the model's
 * context. They read like instructions to the agent on purpose - the model is
 * the consumer, not a developer.
 */
const handlers: Record<string, Handler> = {
  async lookup_fact(task, callId, args) {
    const key = str(args.key)
    const fact = task.facts.find((f) => f.key === key)
    if (!fact) return `There is no fact called "${key}". Do not guess. Use ask_principal instead.`
    if (fact.disclosure === 'never') {
      return `"${key}" is marked not-for-disclosure and must not be said aloud. Tell the caller you are not authorised to give that out.`
    }
    store.recordDisclosure(task.id, callId, key)
    return `${fact.label}: ${fact.value}`
  },

  async record(task, _callId, args) {
    const key = str(args.key)
    const value = str(args.value)
    task.findings[key] = value
    store.saveTask(task)
    return `Recorded ${key}.`
  },

  async ask_principal(task, _callId, args) {
    const question = str(args.question)
    const esc = store.createEscalation(task.id, 'question', question)
    await askPrincipal(task, esc)
    const answer = await waitForAnswer(esc.id, config.agent.principalWaitSeconds, store.getEscalation)
    if (answer) return `The account holder replied: ${answer}`
    return (
      'No reply yet. Do not guess and do not wait longer. Apologise, explain that you ' +
      'need to confirm something with the account holder, and use schedule_callback to ' +
      'arrange a time to call back.'
    )
  },

  async request_approval(task, _callId, args) {
    const action = str(args.action)
    const detail = str(args.detail)
    const esc = store.createEscalation(task.id, 'approval', `${action}\n${detail}`)
    await requestApproval(task, esc)
    const answer = await waitForAnswer(esc.id, config.agent.principalWaitSeconds, store.getEscalation)
    const approved = !!answer && /^\s*(y|yes|ok|approve|approved|si|sí)\b/i.test(answer)
    if (approved) {
      task.findings[`approved_${Date.now()}`] = action
      store.saveTask(task)
      return `APPROVED: ${action}. You may agree to this now.`
    }
    return (
      `NOT APPROVED: ${action}. ` +
      'Decline politely - say you are not authorised to agree to that on this call and ' +
      'the account holder will come back to them. Then carry on with the rest of the task.'
    )
  },

  async schedule_callback(task, _callId, args) {
    const when = parseWhen(str(args.when))
    task.status = 'waiting_callback'
    task.nextAttemptAt = when.toISOString()
    task.findings.callback_reason = str(args.reason)
    store.saveTask(task)
    return `Call-back noted for ${when.toUTCString()}. Confirm the time with the caller, thank them, then call finish with status needs_human only if you are also blocked; otherwise just end the call politely.`
  },

  async finish(task, _callId, args) {
    const status = str(args.status)
    task.summary = str(args.summary)
    task.status = status === 'done' ? 'done' : status === 'failed' ? 'failed' : 'needs_human'
    store.saveTask(task)
    return 'Recorded. Thank them, say goodbye, and end the call.'
  },
}

/** Very small natural-language date parser, enough for "call back Tuesday". */
export function parseWhen(input: string, from = new Date()): Date {
  const iso = Date.parse(input)
  if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(input)) return new Date(iso)

  const s = input.toLowerCase()
  const d = new Date(from)
  const hourMatch = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/)
  const setTime = (defaultHour: number) => {
    let h = hourMatch ? Number(hourMatch[1]) : defaultHour
    const m = hourMatch && hourMatch[2] ? Number(hourMatch[2]) : 0
    if (hourMatch?.[3] === 'pm' && h < 12) h += 12
    if (hourMatch?.[3] === 'am' && h === 12) h = 0
    d.setHours(h, m, 0, 0)
  }

  if (s.includes('tomorrow')) {
    d.setDate(d.getDate() + 1)
    setTime(9)
    return d
  }
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const dayIdx = days.findIndex((name) => s.includes(name))
  if (dayIdx >= 0) {
    const delta = (dayIdx - d.getDay() + 7) % 7 || 7
    d.setDate(d.getDate() + delta)
    setTime(9)
    return d
  }
  const inHours = s.match(/in (\d+) hours?/)
  if (inHours?.[1]) return new Date(from.getTime() + Number(inHours[1]) * 3600_000)
  const inMins = s.match(/in (\d+) minutes?/)
  if (inMins?.[1]) return new Date(from.getTime() + Number(inMins[1]) * 60_000)

  // Anything we cannot read becomes "try again in two hours" rather than an error.
  return new Date(from.getTime() + 2 * 3600_000)
}

export async function runTool(
  task: Task,
  callId: string | null,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const handler = handlers[name]
  if (!handler) return `Unknown tool ${name}.`
  try {
    return await handler(task, callId, args)
  } catch (err) {
    console.error(`[tool:${name}]`, err)
    return 'That did not work. Do not retry it. Carry on with the call and mention it in your summary.'
  }
}
