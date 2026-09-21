import Fastify from 'fastify'
import twilio from 'twilio'
import { config } from './config.js'
import * as store from './db.js'
import { onCallEnded, startOrchestrator, withinBusinessHours } from './orchestrator.js'
import { runTool } from './tools.js'
import { TaskInput } from './types.js'

const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 })

/** Providers hit these endpoints over the open internet, so gate on the secret. */
function authed(query: unknown): boolean {
  const q = query as { secret?: string } | undefined
  return q?.secret === config.webhookSecret
}

app.get('/health', async () => ({ ok: true, at: new Date().toISOString() }))

/* ------------------------------------------------------- agent tool calls -- */

type VapiToolCall = { id?: string; toolCallId?: string; function?: { name?: string; arguments?: unknown } }

app.post<{ Params: { taskId: string } }>('/webhooks/vapi/tool/:taskId', async (req, reply) => {
  if (!authed(req.query)) return reply.code(401).send({ error: 'bad secret' })

  const task = store.getTask(req.params.taskId)
  if (!task) return reply.code(404).send({ error: 'no such task' })

  const message = (req.body as { message?: Record<string, unknown> })?.message ?? {}
  const list = (message.toolCallList ?? message.toolCalls ?? []) as VapiToolCall[]
  const callId = ((message.call as { id?: string } | undefined)?.id ?? null) as string | null

  const results = []
  for (const call of list) {
    const id = call.id ?? call.toolCallId ?? ''
    const name = call.function?.name ?? ''
    // Vapi sends arguments as an object, but some models emit a JSON string.
    const raw = call.function?.arguments
    let args: Record<string, unknown> = {}
    try {
      args = typeof raw === 'string' ? JSON.parse(raw) : ((raw as Record<string, unknown>) ?? {})
    } catch {
      args = {}
    }

    console.log(`[tool] task=${task.id} ${name}(${JSON.stringify(args)})`)
    // Re-read so each tool in a batch sees the previous one's writes.
    const fresh = store.getTask(task.id) ?? task
    const result = await runTool(fresh, callId, name, args)
    results.push({ toolCallId: id, result })
  }

  return { results }
})

/* ------------------------------------------------------------ call events -- */

app.post<{ Params: { taskId: string } }>('/webhooks/vapi/events/:taskId', async (req, reply) => {
  if (!authed(req.query)) return reply.code(401).send({ error: 'bad secret' })

  const message = (req.body as { message?: Record<string, unknown> })?.message ?? {}
  const type = message.type as string | undefined
  const call = message.call as { id?: string } | undefined
  const providerCallId = call?.id ?? (message.callId as string | undefined) ?? null

  if (type === 'end-of-call-report' && providerCallId) {
    const artifact = message.artifact as { transcript?: string; recordingUrl?: string } | undefined
    const analysis = message.analysis as { summary?: string; structuredData?: unknown } | undefined

    store.finishCall(providerCallId, {
      endedReason: (message.endedReason as string) ?? null,
      transcript: artifact?.transcript ?? null,
      recordingUrl: artifact?.recordingUrl ?? null,
      costUsd: (message.cost as number) ?? null,
      outcome: analysis?.summary ?? null,
    })

    // The model's own finish() is authoritative; this only fills the gap when
    // the call dropped before it could be called.
    const task = store.getTask(req.params.taskId)
    if (task && !task.summary && analysis?.summary) {
      task.summary = analysis.summary
      store.saveTask(task)
    }

    await onCallEnded(req.params.taskId, (message.endedReason as string) ?? null)
  }

  return { ok: true }
})

/* ----------------------------------------------------------- inbound SMS -- */

app.post('/webhooks/sms', async (req, reply) => {
  const signature = req.headers['x-twilio-signature']
  const url = `${config.publicUrl}/webhooks/sms`
  const valid =
    typeof signature === 'string' &&
    twilio.validateRequest(config.twilio.authToken, signature, url, (req.body ?? {}) as Record<string, string>)
  if (!valid) return reply.code(403).send('bad signature')

  const body = req.body as { From?: string; Body?: string }
  if (body.From !== config.principal.mobile) return reply.code(403).send('unknown sender')

  const text = (body.Body ?? '').trim()

  // "YES 4821" / "no 4821" / "4821 the code is 552310" / bare answer
  const coded = text.match(/\b(\d{4})\b/)
  const esc = coded?.[1]
    ? (store.findOpenEscalationByCode(coded[1]) ?? store.oldestOpenEscalation())
    : store.oldestOpenEscalation()

  if (!esc) {
    reply.header('Content-Type', 'text/xml')
    return '<Response><Message>Nothing is waiting on an answer right now.</Message></Response>'
  }

  const answer = coded?.[1] ? text.replace(coded[1], '').trim() || text : text
  store.answerEscalation(esc.id, answer)
  console.log(`[sms] answered escalation ${esc.code}`)

  reply.header('Content-Type', 'text/xml')
  return '<Response></Response>'
})

/* ------------------------------------------------------------------ API -- */

app.post('/api/tasks', async (req, reply) => {
  const parsed = TaskInput.safeParse(req.body)
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() })
  const task = store.createTask(parsed.data)
  return { task, callableNow: withinBusinessHours(task) }
})

app.get('/api/tasks', async (req) => {
  const q = req.query as { status?: string }
  return { tasks: store.listTasks(q.status as never) }
})

app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
  const task = store.getTask(req.params.id)
  if (!task) return reply.code(404).send({ error: 'not found' })
  return {
    task,
    calls: store.callsForTask(task.id),
    disclosed: store.disclosuresForTask(task.id).map((d) => d.factKey),
  }
})

app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req, reply) => {
  const task = store.getTask(req.params.id)
  if (!task) return reply.code(404).send({ error: 'not found' })
  return { task: store.patchTask(task.id, { status: 'failed', summary: 'Cancelled by the account holder.' }) }
})

/* ---------------------------------------------------------------- boot -- */

const start = async () => {
  await app.listen({ port: config.port, host: '0.0.0.0' })
  startOrchestrator()
  console.log(`errand listening on :${config.port}`)
  console.log(`public url ${config.publicUrl}`)
}

start().catch((err) => {
  console.error(err)
  process.exit(1)
})
