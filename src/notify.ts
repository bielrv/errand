import twilio from 'twilio'
import { config } from './config.js'
import type { Escalation, Task } from './types.js'

const client = twilio(config.twilio.accountSid, config.twilio.authToken)

async function sms(body: string): Promise<void> {
  await client.messages.create({
    to: config.principal.mobile,
    from: config.twilio.from,
    // Twilio splits anything longer, and long SMS on a live call is useless.
    body: body.slice(0, 900),
  })
}

/** Mid-call question. The agent is holding the line while this goes out. */
export async function askPrincipal(task: Task, esc: Escalation): Promise<void> {
  await sms(
    `[${esc.code}] ON A CALL NOW - ${task.callee.name}\n` +
      `${esc.prompt}\n\n` +
      `Reply with the answer. Prefix with ${esc.code} if you have more than one open.`,
  )
}

/** Approval gate for anything binding. Default is no. */
export async function requestApproval(task: Task, esc: Escalation): Promise<void> {
  await sms(
    `[${esc.code}] APPROVAL NEEDED - ${task.callee.name}\n` +
      `${esc.prompt}\n\n` +
      `Reply YES ${esc.code} to approve, NO ${esc.code} to decline. No reply = declined.`,
  )
}

export async function notifyOutcome(task: Task): Promise<void> {
  const verdict =
    task.status === 'done' ? 'DONE' : task.status === 'failed' ? 'FAILED' : 'NEEDS YOU'
  const findings = Object.entries(task.findings)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  await sms(
    `${verdict} - ${task.title}\n` +
      `${task.summary ?? 'No summary recorded.'}` +
      (findings ? `\n\n${findings}` : ''),
  )
}

export async function notify(text: string): Promise<void> {
  await sms(text)
}

/**
 * Wait for the principal to answer, polling the database.
 *
 * Vapi holds a tool call open for a limited window, so this is deliberately
 * short. If it times out the agent is told to arrange a call-back instead of
 * guessing, which is the honest failure mode.
 */
export async function waitForAnswer(
  escalationId: string,
  seconds: number,
  read: (id: string) => Escalation | null,
): Promise<string | null> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const esc = read(escalationId)
    if (esc?.answer) return esc.answer
    await new Promise((r) => setTimeout(r, 1500))
  }
  return null
}
