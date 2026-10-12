/**
 * Measures the one thing that genuinely differs between the two stacks: how
 * long a tool call takes to come back.
 *
 * On a live phone call this is dead air. The agent says "let me just check
 * that for you", calls lookup_fact, and says nothing until it returns. The
 * managed stack reaches the handler over an HTTP webhook; the LiveKit worker
 * calls the same handler in-process.
 *
 *   npm start          (in one terminal)
 *   npm run bench      (in another)
 *
 * Caveat that matters: the HTTP figure here is localhost, so it isolates our
 * own server's work. In production Vapi's cloud reaches us over the internet,
 * which adds a round trip on top - see the report footer.
 */
import { buildAssistant } from '../src/providers/vapi.js'
import * as store from '../src/db.js'
import { runTool } from '../src/tools.js'
import { TaskInput, type Task } from '../src/types.js'

const BASE = process.env.BENCH_BASE_URL ?? 'http://localhost:3000'
const SECRET = process.env.WEBHOOK_SECRET ?? 'smoke-test-secret'
const N = Number(process.env.BENCH_N ?? '200')
const WARMUP = 20

type Stats = { n: number; p50: number; p95: number; p99: number; max: number; mean: number }

function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b)
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0
  return {
    n: s.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: s[s.length - 1] ?? 0,
    mean: s.reduce((a, b) => a + b, 0) / (s.length || 1),
  }
}

async function timeIt(iterations: number, fn: (i: number) => Promise<unknown>): Promise<number[]> {
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    await fn(i)
    samples.push(performance.now() - t0)
  }
  return samples
}

/* ------------------------------------------------- the two transports -- */

async function viaWebhook(task: Task, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE}/webhooks/vapi/tool/${task.id}?secret=${SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        type: 'tool-calls',
        call: { id: 'bench' },
        toolCallList: [{ id: 'tc', function: { name, arguments: args } }],
      },
    }),
  })
  if (!res.ok) throw new Error(`webhook ${res.status}`)
  return res.json()
}

function row(label: string, s: Stats): string {
  const f = (n: number) => n.toFixed(2).padStart(8)
  return `  ${label.padEnd(34)} ${f(s.p50)} ${f(s.p95)} ${f(s.p99)} ${f(s.max)} ${f(s.mean)}`
}

async function main() {
  const health = await fetch(`${BASE}/health`).catch(() => null)
  if (!health?.ok) {
    console.error(`No server on ${BASE}. Start it with: npm start`)
    process.exit(1)
  }

  const task = store.createTask(
    TaskInput.parse({
      title: 'benchmark',
      objective: 'Measure tool-call latency on both transports.',
      callee: { name: 'Nobody Ltd', phone: '+442079460000', timezone: 'Europe/London' },
      facts: [
        { key: 'address', label: 'Address', value: '12 Elm Road', disclosure: 'proactive' },
        { key: 'account_number', label: 'Account number', value: '8829301', disclosure: 'on_request' },
      ],
      constraints: ['Do not agree to a new tariff.'],
      success: ['An engineer is booked.'],
      notBefore: new Date(Date.now() + 365 * 86400_000).toISOString(),
    }),
  )

  /**
   * The in-process path calls the handler exactly as the LiveKit worker's
   * execute() closure does. We invoke runTool directly rather than going
   * through buildTools, because @livekit/agents drags in a native WebRTC
   * binding that some machines block - and the tool() wrapper it would add is
   * inert metadata, not work in the call path.
   */
  const inProcess = (name: string, args: Record<string, unknown>) =>
    runTool(store.getTask(task.id) ?? task, 'bench', name, args)

  // Warm up both paths: JIT, the SQLite page cache, and HTTP keep-alive.
  await timeIt(WARMUP, (i) => viaWebhook(task, 'record', { key: `warm_${i}`, value: 'x' }))
  await timeIt(WARMUP, (i) => inProcess('record', { key: `warm_${i}`, value: 'x' }))

  const results: [string, Stats][] = [
    ['record       - webhook (localhost)', stats(await timeIt(N, (i) => viaWebhook(task, 'record', { key: `k${i}`, value: 'v' })))],
    ['record       - in-process', stats(await timeIt(N, (i) => inProcess('record', { key: `k${i}`, value: 'v' })))],
    ['lookup_fact  - webhook (localhost)', stats(await timeIt(N, () => viaWebhook(task, 'lookup_fact', { key: 'account_number' })))],
    ['lookup_fact  - in-process', stats(await timeIt(N, () => inProcess('lookup_fact', { key: 'account_number' })))],
  ]

  // Per-call setup: how long it takes to compose the whole assistant payload.
  const build = stats(await timeIt(N, async () => buildAssistant(store.getTask(task.id)!)))

  /**
   * Control. A bare GET with no body and no handler work. If this lands on
   * top of the webhook figures then the gap is the HTTP hop itself, not
   * anything we wrote - which is the whole point of measuring it.
   */
  const control = stats(await timeIt(N, () => fetch(`${BASE}/health`).then((r) => r.json())))

  console.log(`\n  errand tool-call latency, ms (n=${N}, warmup=${WARMUP})\n`)
  console.log(`  ${''.padEnd(34)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'max'.padStart(8)} ${'mean'.padStart(8)}`)
  console.log(`  ${'-'.repeat(34)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(8)}`)
  for (const [label, s] of results) console.log(row(label, s))
  console.log(row('buildAssistant (prompt compose)', build))
  console.log(row('CONTROL: bare GET /health', control))

  const webhookP50 = results[0]![1].p50
  const directP50 = results[1]![1].p50
  const overhead = webhookP50 - directP50
  console.log(`\n  transport overhead at p50: ${overhead.toFixed(2)} ms on localhost`)
  console.log(
    `  of which ${control.p50.toFixed(2)} ms is the bare HTTP hop on this machine, ` +
      `so ${Math.max(0, overhead - control.p50).toFixed(2)} ms is our own work.`,
  )
  console.log(`  In production the Vapi hop is an internet round trip instead: typically 20-80 ms.`)
  console.log(`  Six tool calls in a call therefore cost roughly 0.2-0.5 s of extra dead air.`)

  const prompt = (buildAssistant(store.getTask(task.id)!) as { model: { messages: { content: string }[] } })
    .model.messages[0]!.content
  console.log(`\n  system prompt: ${prompt.length} chars, ~${Math.round(prompt.length / 3.7)} tokens (rough)`)
  console.log(`  findings accumulated during the run: ${Object.keys(store.getTask(task.id)!.findings).length}\n`)

  console.log(JSON.stringify(
    { n: N, results: Object.fromEntries(results), buildAssistant: build, control, promptChars: prompt.length },
    null,
    2,
  ))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
