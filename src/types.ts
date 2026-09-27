import { z } from 'zod'

/**
 * A single piece of information about the principal or the account.
 *
 * `disclosure` is the whole point of this type:
 *   proactive  - safe to put in the system prompt and volunteer unprompted
 *   on_request - withheld from the prompt; the agent must call lookup_fact,
 *                which gives us an audit trail of exactly what was said aloud
 *   never      - stored for our own records, never reaches the model
 */
export const Fact = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  disclosure: z.enum(['proactive', 'on_request', 'never']).default('on_request'),
})
export type Fact = z.infer<typeof Fact>

export const Callee = z.object({
  name: z.string(),
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164, e.g. +442079460000'),
  /** Free text: "press 2 for existing customer, then 3 for repairs" */
  ivrHints: z.string().optional(),
  /** IANA zone used to keep calls inside business hours. */
  timezone: z.string().default('Europe/London'),
  businessHours: z.object({ open: z.number(), close: z.number(), days: z.array(z.number()) })
    .default({ open: 9, close: 17, days: [1, 2, 3, 4, 5] }),
})
export type Callee = z.infer<typeof Callee>

export const TaskStatus = z.enum([
  'queued',            // waiting for the next call window
  'calling',           // a call is live right now
  'waiting_principal', // agent asked you something and is holding
  'waiting_callback',  // they told us to try again later
  'needs_human',       // stuck; you have to take it from here
  'done',
  'failed',
])
export type TaskStatus = z.infer<typeof TaskStatus>

export const TaskInput = z.object({
  title: z.string(),
  /** Plain English. This is what makes the agent generic. */
  objective: z.string(),
  callee: Callee,
  language: z.string().default('en-GB'),
  facts: z.array(Fact).default([]),
  /** Task-specific hard rails, appended to the universal ones. */
  constraints: z.array(z.string()).default([]),
  /** Concrete, checkable definitions of done. */
  success: z.array(z.string()).default([]),
  maxAttempts: z.number().int().positive().default(4),
  /** Earliest we may dial, ISO 8601. Defaults to now. */
  notBefore: z.string().datetime().optional(),
  /** Hard stop; after this the task fails rather than nagging forever. */
  deadline: z.string().datetime().optional(),
})
export type TaskInput = z.infer<typeof TaskInput>

export type Task = TaskInput & {
  id: string
  status: TaskStatus
  attempts: number
  nextAttemptAt: string
  /** Anything the agent captured on the phone: ref numbers, names, slots. */
  findings: Record<string, string>
  summary: string | null
  createdAt: string
  updatedAt: string
}

export type CallAttempt = {
  id: string
  taskId: string
  providerCallId: string | null
  startedAt: string
  endedAt: string | null
  endedReason: string | null
  transcript: string | null
  recordingUrl: string | null
  costUsd: number | null
  outcome: string | null
  /** Model, STT and TTS usage for this call. Shape varies by stack. */
  metrics: Record<string, unknown> | null
}

/** A question or approval the agent pushed to the principal mid-call. */
export type Escalation = {
  id: string
  taskId: string
  kind: 'question' | 'approval'
  /** Short code the principal quotes when replying by SMS. */
  code: string
  prompt: string
  answer: string | null
  askedAt: string
  answeredAt: string | null
}

/** Every value the agent spoke aloud, for audit. */
export type Disclosure = {
  id: string
  taskId: string
  callId: string | null
  factKey: string
  at: string
}
