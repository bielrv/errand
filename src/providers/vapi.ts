import { config } from '../config.js'
import { analysisPlan, buildFirstMessage, buildSystemPrompt } from '../prompt.js'
import { toolDefinitions } from '../tools.js'
import type { Task } from '../types.js'

/**
 * The only file that knows about Vapi. Swapping to Retell or Bland means
 * writing a sibling with the same two exports.
 */

export type PlacedCall = { providerCallId: string }

async function vapi(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${config.vapi.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.vapi.apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Vapi ${path} ${res.status}: ${text}`)
  return text ? JSON.parse(text) : null
}

/**
 * A transient assistant, built fresh for this task. Nothing is stored on
 * Vapi's side, so a task's prompt always reflects the current state of the
 * task - including anything learned on earlier attempts.
 */
export function buildAssistant(task: Task): Record<string, unknown> {
  return {
    name: `errand-${task.id.slice(0, 8)}`,
    firstMessage: buildFirstMessage(task),
    // Utility lines answer with an IVR, so let the machine speak first.
    firstMessageMode: 'assistant-waits-for-user',
    maxDurationSeconds: config.agent.maxCallSeconds,
    endCallFunctionEnabled: true,
    // Hold music and long silences are normal on these calls.
    silenceTimeoutSeconds: 300,
    backgroundSound: 'office',
    model: {
      provider: config.vapi.model.provider,
      model: config.vapi.model.model,
      temperature: 0.3,
      messages: [{ role: 'system', content: buildSystemPrompt(task) }],
      tools: toolDefinitions(task.id),
    },
    voice: { provider: config.vapi.voice.provider, voiceId: config.vapi.voice.voiceId },
    transcriber: {
      provider: config.vapi.transcriber.provider,
      model: config.vapi.transcriber.model,
      language: task.language.split('-')[0],
    },
    server: {
      url: `${config.publicUrl}/webhooks/vapi/events/${task.id}?secret=${config.webhookSecret}`,
    },
    serverMessages: ['status-update', 'end-of-call-report'],
    ...analysisPlan,
  }
}

export async function placeCall(task: Task): Promise<PlacedCall> {
  const body = {
    phoneNumberId: config.vapi.phoneNumberId,
    customer: { number: task.callee.phone, name: task.callee.name },
    assistant: buildAssistant(task),
  }
  const res = (await vapi('/call', { method: 'POST', body: JSON.stringify(body) })) as { id: string }
  return { providerCallId: res.id }
}

export async function endCall(providerCallId: string): Promise<void> {
  await vapi(`/call/${providerCallId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'ended' }),
  })
}
