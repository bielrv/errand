import { config } from './config.js'
import * as store from './db.js'
import { notifyOutcome, notify } from './notify.js'
import { provider } from './providers/index.js'
import type { Task } from './types.js'

/**
 * Turns a one-off phone call into a task that finishes. This is the part that
 * makes "set it and forget it" true: a call that ends without success does
 * not end the task, it just schedules the next attempt.
 */

/** Local wall-clock hour and weekday at the callee, without pulling in a date library. */
function localParts(tz: string, at = new Date()): { hour: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  })
  const parts = fmt.formatToParts(at)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const weekday = names.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Sun')
  return { hour, weekday }
}

export function withinBusinessHours(task: Task, at = new Date()): boolean {
  const { hour, weekday } = localParts(task.callee.timezone, at)
  const { open, close, days } = task.callee.businessHours
  return days.includes(weekday) && hour >= open && hour < close
}

/** Next moment the callee is open, searched hour by hour over the next week. */
export function nextOpenSlot(task: Task, from = new Date()): Date {
  const probe = new Date(from)
  probe.setMinutes(0, 0, 0)
  for (let i = 1; i <= 24 * 8; i++) {
    probe.setHours(probe.getHours() + 1)
    if (withinBusinessHours(task, probe)) return probe
  }
  return new Date(from.getTime() + 24 * 3600_000)
}

/** 15 min, 1 h, 4 h, 24 h - enough to ride out a busy line without nagging. */
function backoffMs(attempt: number): number {
  const ladder = [15 * 60_000, 60 * 60_000, 4 * 3600_000, 24 * 3600_000]
  return ladder[Math.min(attempt, ladder.length - 1)] ?? 24 * 3600_000
}

export async function attemptTask(task: Task): Promise<void> {
  if (task.deadline && new Date(task.deadline) < new Date()) {
    task.status = 'failed'
    task.summary = 'Deadline passed before the task could be completed.'
    store.saveTask(task)
    await notifyOutcome(task)
    return
  }

  if (task.attempts >= task.maxAttempts) {
    task.status = 'needs_human'
    task.summary = `Gave up after ${task.attempts} attempts. ${task.summary ?? ''}`.trim()
    store.saveTask(task)
    await notifyOutcome(task)
    return
  }

  if (!withinBusinessHours(task)) {
    task.nextAttemptAt = nextOpenSlot(task).toISOString()
    store.saveTask(task)
    return
  }

  task.status = 'calling'
  task.attempts += 1
  // Hold the slot so a slow call cannot be dialled twice by the next tick.
  task.nextAttemptAt = new Date(Date.now() + config.agent.maxCallSeconds * 1000).toISOString()
  store.saveTask(task)

  try {
    const stack = await provider()
    const { providerCallId } = await stack.placeCall(task)
    store.startCall(task.id, providerCallId)
    console.log(`[call:${stack.name}] task=${task.id} attempt=${task.attempts} call=${providerCallId}`)
  } catch (err) {
    console.error('[call] failed to place', err)
    task.status = 'queued'
    task.nextAttemptAt = new Date(Date.now() + backoffMs(task.attempts)).toISOString()
    store.saveTask(task)
  }
}

/**
 * Called when a call ends. The agent's own finish() has usually already set a
 * terminal status; anything else means the call dropped, nobody answered, or
 * it hit the IVR and died, so we queue a retry.
 */
export async function onCallEnded(taskId: string, endedReason: string | null): Promise<void> {
  const task = store.getTask(taskId)
  if (!task) return

  const terminal: Task['status'][] = ['done', 'failed', 'needs_human']
  if (terminal.includes(task.status)) {
    await notifyOutcome(task)
    return
  }

  if (task.status === 'waiting_callback') {
    // schedule_callback already set nextAttemptAt; just respect opening hours.
    if (!withinBusinessHours(task, new Date(task.nextAttemptAt))) {
      task.nextAttemptAt = nextOpenSlot(task, new Date(task.nextAttemptAt)).toISOString()
    }
    store.saveTask(task)
    await notify(
      `Call-back scheduled - ${task.title}\n` +
        `${task.callee.name} on ${new Date(task.nextAttemptAt).toUTCString()}.`,
    )
    return
  }

  task.status = 'queued'
  task.nextAttemptAt = new Date(Date.now() + backoffMs(task.attempts)).toISOString()
  store.saveTask(task)
  console.log(`[retry] task=${task.id} reason=${endedReason} next=${task.nextAttemptAt}`)
}

let timer: NodeJS.Timeout | null = null

export function startOrchestrator(): void {
  const tick = async () => {
    try {
      for (const task of store.dueTasks()) await attemptTask(task)
    } catch (err) {
      console.error('[tick]', err)
    }
  }
  void tick()
  timer = setInterval(() => void tick(), config.tickMs)
}

export function stopOrchestrator(): void {
  if (timer) clearInterval(timer)
  timer = null
}
