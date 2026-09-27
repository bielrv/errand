import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import type { CallAttempt, Disclosure, Escalation, Task, TaskInput, TaskStatus } from './types.js'

mkdirSync(dirname(config.dbPath), { recursive: true })
const db = new DatabaseSync(config.dbPath)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  doc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  provider_call_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT,
  transcript TEXT,
  recording_url TEXT,
  cost_usd REAL,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS calls_provider ON calls(provider_call_id);

CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  code TEXT NOT NULL,
  prompt TEXT NOT NULL,
  answer TEXT,
  asked_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS escalations_code ON escalations(code);

CREATE TABLE IF NOT EXISTS disclosures (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  call_id TEXT,
  fact_key TEXT NOT NULL,
  at TEXT NOT NULL
);
`)

/**
 * Per-call model/STT/TTS usage, so you can see whether hold time is actually
 * where the money goes before optimising for it. Added after the first
 * release, hence the guarded ALTER.
 */
const columns = (db.prepare('PRAGMA table_info(calls)').all() as Row[]).map((c) => c.name as string)
if (!columns.includes('metrics')) db.exec('ALTER TABLE calls ADD COLUMN metrics TEXT')

const now = () => new Date().toISOString()
type Row = Record<string, unknown>

/* ---------------------------------------------------------------- tasks -- */

export function createTask(input: TaskInput): Task {
  const task: Task = {
    ...input,
    id: randomUUID(),
    status: 'queued',
    attempts: 0,
    nextAttemptAt: input.notBefore ?? now(),
    findings: {},
    summary: null,
    createdAt: now(),
    updatedAt: now(),
  }
  db.prepare(
    `INSERT INTO tasks (id, status, next_attempt_at, attempts, doc, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(task.id, task.status, task.nextAttemptAt, 0, JSON.stringify(task), task.createdAt, task.updatedAt)
  return task
}

const hydrate = (row: Row): Task => JSON.parse(row.doc as string) as Task

export function getTask(id: string): Task | null {
  const row = db.prepare('SELECT doc FROM tasks WHERE id = ?').get(id) as Row | undefined
  return row ? hydrate(row) : null
}

export function saveTask(task: Task): Task {
  task.updatedAt = now()
  db.prepare(
    'UPDATE tasks SET status = ?, next_attempt_at = ?, attempts = ?, doc = ?, updated_at = ? WHERE id = ?',
  ).run(task.status, task.nextAttemptAt, task.attempts, JSON.stringify(task), task.updatedAt, task.id)
  return task
}

export function patchTask(id: string, patch: Partial<Task>): Task {
  const task = getTask(id)
  if (!task) throw new Error(`No such task ${id}`)
  return saveTask(Object.assign(task, patch))
}

export function listTasks(status?: TaskStatus): Task[] {
  const rows = (
    status
      ? db.prepare('SELECT doc FROM tasks WHERE status = ? ORDER BY created_at DESC').all(status)
      : db.prepare('SELECT doc FROM tasks ORDER BY created_at DESC').all()
  ) as Row[]
  return rows.map(hydrate)
}

/** Tasks whose next attempt is due. Business-hours filtering happens upstream. */
export function dueTasks(): Task[] {
  const rows = db
    .prepare(
      `SELECT doc FROM tasks
        WHERE status IN ('queued', 'waiting_callback')
          AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC`,
    )
    .all(now()) as Row[]
  return rows.map(hydrate)
}

/* ---------------------------------------------------------------- calls -- */

const toCall = (r: Row): CallAttempt => ({
  id: r.id as string,
  taskId: r.task_id as string,
  providerCallId: r.provider_call_id as string | null,
  startedAt: r.started_at as string,
  endedAt: r.ended_at as string | null,
  endedReason: r.ended_reason as string | null,
  transcript: r.transcript as string | null,
  recordingUrl: r.recording_url as string | null,
  costUsd: r.cost_usd as number | null,
  outcome: r.outcome as string | null,
  metrics: r.metrics ? (JSON.parse(r.metrics as string) as Record<string, unknown>) : null,
})

export function startCall(taskId: string, providerCallId: string | null): CallAttempt {
  const call: CallAttempt = {
    id: randomUUID(),
    taskId,
    providerCallId,
    startedAt: now(),
    endedAt: null,
    endedReason: null,
    transcript: null,
    recordingUrl: null,
    costUsd: null,
    outcome: null,
    metrics: null,
  }
  db.prepare('INSERT INTO calls (id, task_id, provider_call_id, started_at) VALUES (?, ?, ?, ?)').run(
    call.id,
    call.taskId,
    call.providerCallId,
    call.startedAt,
  )
  return call
}

export function findCallByProviderId(providerCallId: string): CallAttempt | null {
  const row = db.prepare('SELECT * FROM calls WHERE provider_call_id = ?').get(providerCallId) as Row | undefined
  return row ? toCall(row) : null
}

export function finishCall(
  providerCallId: string,
  patch: Partial<
    Pick<CallAttempt, 'endedReason' | 'transcript' | 'recordingUrl' | 'costUsd' | 'outcome' | 'metrics'>
  >,
): void {
  db.prepare(
    `UPDATE calls SET ended_at = ?, ended_reason = ?, transcript = ?, recording_url = ?, cost_usd = ?,
                      outcome = ?, metrics = ?
      WHERE provider_call_id = ?`,
  ).run(
    now(),
    patch.endedReason ?? null,
    patch.transcript ?? null,
    patch.recordingUrl ?? null,
    patch.costUsd ?? null,
    patch.outcome ?? null,
    patch.metrics ? JSON.stringify(patch.metrics) : null,
    providerCallId,
  )
}

export function callsForTask(taskId: string): CallAttempt[] {
  const rows = db.prepare('SELECT * FROM calls WHERE task_id = ? ORDER BY started_at ASC').all(taskId) as Row[]
  return rows.map(toCall)
}

/* ---------------------------------------------------------- escalations -- */

const toEscalation = (r: Row): Escalation => ({
  id: r.id as string,
  taskId: r.task_id as string,
  kind: r.kind as Escalation['kind'],
  code: r.code as string,
  prompt: r.prompt as string,
  answer: r.answer as string | null,
  askedAt: r.asked_at as string,
  answeredAt: r.answered_at as string | null,
})

/** Four digits is enough: only a handful are ever open at once. */
function freshCode(): string {
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000))
    const clash = db.prepare('SELECT 1 FROM escalations WHERE code = ? AND answer IS NULL').get(code)
    if (!clash) return code
  }
  throw new Error('Could not allocate an escalation code')
}

export function createEscalation(taskId: string, kind: Escalation['kind'], prompt: string): Escalation {
  const esc: Escalation = {
    id: randomUUID(),
    taskId,
    kind,
    code: freshCode(),
    prompt,
    answer: null,
    askedAt: now(),
    answeredAt: null,
  }
  db.prepare(
    'INSERT INTO escalations (id, task_id, kind, code, prompt, asked_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(esc.id, esc.taskId, esc.kind, esc.code, esc.prompt, esc.askedAt)
  return esc
}

export function getEscalation(id: string): Escalation | null {
  const row = db.prepare('SELECT * FROM escalations WHERE id = ?').get(id) as Row | undefined
  return row ? toEscalation(row) : null
}

/** Oldest unanswered escalation - what a bare SMS reply is assumed to mean. */
export function oldestOpenEscalation(): Escalation | null {
  const row = db
    .prepare('SELECT * FROM escalations WHERE answer IS NULL ORDER BY asked_at ASC LIMIT 1')
    .get() as Row | undefined
  return row ? toEscalation(row) : null
}

export function findOpenEscalationByCode(code: string): Escalation | null {
  const row = db
    .prepare('SELECT * FROM escalations WHERE code = ? AND answer IS NULL ORDER BY asked_at DESC LIMIT 1')
    .get(code) as Row | undefined
  return row ? toEscalation(row) : null
}

export function answerEscalation(id: string, answer: string): void {
  db.prepare('UPDATE escalations SET answer = ?, answered_at = ? WHERE id = ?').run(answer, now(), id)
}

export function openEscalationsForTask(taskId: string): Escalation[] {
  const rows = db
    .prepare('SELECT * FROM escalations WHERE task_id = ? AND answer IS NULL')
    .all(taskId) as Row[]
  return rows.map(toEscalation)
}

/* ---------------------------------------------------------- disclosures -- */

export function recordDisclosure(taskId: string, callId: string | null, factKey: string): void {
  db.prepare('INSERT INTO disclosures (id, task_id, call_id, fact_key, at) VALUES (?, ?, ?, ?, ?)').run(
    randomUUID(),
    taskId,
    callId,
    factKey,
    now(),
  )
}

export function disclosuresForTask(taskId: string): Disclosure[] {
  const rows = db.prepare('SELECT * FROM disclosures WHERE task_id = ? ORDER BY at ASC').all(taskId) as Row[]
  return rows.map((r) => ({
    id: r.id as string,
    taskId: r.task_id as string,
    callId: r.call_id as string | null,
    factKey: r.fact_key as string,
    at: r.at as string,
  }))
}

export { db }
