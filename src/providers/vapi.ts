import { config } from '../config.js'
import { analysisPlan, buildFirstMessage, buildSystemPrompt } from '../prompt.js'
import { toolDefinitions } from '../tools.js'
import type { PlacedCall, VoiceProvider } from './types.js'
import type { Task } from '../types.js'

/**
 * The managed stack. Vapi owns the media path and calls our webhooks; see
 * src/providers/livekit.ts for the version where we own the pipeline.
 */

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
      provider: config.model.provider,
      model: config.model.model,
      temperature: 0.3,
      messages: [{ role: 'system', content: buildSystemPrompt(task) }],
      tools: toolDefinitions(task.id),
    },
    voice: { provider: config.voice.provider, voiceId: config.voice.voiceId },
    transcriber: {
      provider: config.transcriber.provider,
      model: config.transcriber.model,
      language: task.language.split('-')[0],
    },
    server: {
      url: `${config.publicUrl}/webhooks/vapi/events/${task.id}?secret=${config.webhookSecret}`,
    },
    serverMessages: ['status-update', 'end-of-call-report'],
    ...analysisPlan,
  }
}

async function placeCall(task: Task): Promise<PlacedCall> {
  const body = {
    phoneNumberId: config.vapi.phoneNumberId,
    customer: { number: task.callee.phone, name: task.callee.name },
    assistant: buildAssistant(task),
  }
  const res = (await vapi('/call', { method: 'POST', body: JSON.stringify(body) })) as { id: string }
  return { providerCallId: res.id }
}

async function endCall(providerCallId: string): Promise<void> {
  await vapi(`/call/${providerCallId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'ended' }),
  })
}

export const vapiProvider: VoiceProvider = { name: 'vapi', placeCall, endCall }
