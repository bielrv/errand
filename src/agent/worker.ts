import {
  Agent,
  AgentSession,
  AgentSessionEventTypes,
  ServerOptions,
  cli,
  defineAgent,

  type JobContext,
} from '@livekit/agents'
import * as anthropic from '@livekit/agents-plugin-anthropic'
import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs'
import * as silero from '@livekit/agents-plugin-silero'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import * as store from '../db.js'
import { onCallEnded } from '../orchestrator.js'
import { taskIdFromRoom } from '../providers/livekit.js'
import { buildInstructions, buildTools } from './session.js'

/**
 * The LiveKit agent worker: a separate process from the HTTP server.
 *
 * Run it alongside `npm start`:
 *   npm run worker -- dev     (local)
 *   npm run worker -- start   (production)
 *
 * The interesting difference from the Vapi path is that the six tools are
 * ordinary function calls here, not webhooks. They still run the same handlers
 * in src/tools.ts, so the agent behaves identically on both stacks - only the
 * transport changes. The prompt comes from the same buildSystemPrompt too.
 */

/** Which task is this job for? The dispatch metadata says so; the room name is the fallback. */
function resolveTaskId(ctx: JobContext): string | null {
  try {
    const meta = JSON.parse(ctx.job.metadata || '{}') as { taskId?: string }
    if (meta.taskId) return meta.taskId
  } catch {
    // Not JSON. Fall through to the room name.
  }
  return taskIdFromRoom(ctx.room.name ?? '')
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const taskId = resolveTaskId(ctx)
    const task = taskId ? store.getTask(taskId) : null
    if (!task) {
      console.error(`[worker] no task for room ${ctx.room.name}; hanging up`)
      return
    }

    const room = ctx.room.name ?? ''
    // Must match what livekit.ts recorded, so finishCall can find the row.
    const call = store.callsForTask(task.id).find((c) => c.providerCallId?.startsWith(`${room}#`))
    const providerCallId = call?.providerCallId ?? null

    const agent = Agent.create({
      instructions: buildInstructions(task),
      tools: buildTools(task, providerCallId),
    })

    const session = new AgentSession({
      llm: new anthropic.LLM({
        model: config.model.model,
        temperature: 0.3,
        // One call at a time keeps the transcript legible and stops the model
        // asking the principal two questions at once.
        parallelToolCalls: false,
      }),
      stt: new deepgram.STT({
        model: config.transcriber.model,
        language: task.language.split('-')[0],
        // Phone audio is 8kHz; smart formatting helps with spoken reference numbers.
        smartFormat: true,
        punctuate: true,
      }),
      tts: new elevenlabs.TTS({ voiceId: config.voice.voiceId, language: task.language.split('-')[0] }),
      // Tuned for the phone rather than for a video call: a call centre agent
      // saying "bear with me" is not the end of their turn.
      vad: await silero.VAD.load({ minSilenceDuration: config.agent.endOfTurnSilenceMs / 1000 }),
      turnHandling: {
        endpointing: { mode: 'dynamic', minDelay: config.agent.endOfTurnSilenceMs, maxDelay: 6000 },
        interruption: { mode: 'adaptive', resumeFalseInterruption: true, falseInterruptionTimeout: 1500 },
      },
      ttsTextTransforms: ['filter_markdown', 'filter_emoji'],
    })

    /* ---- transcript and usage, for the record and for costing ----------- */

    const transcript: string[] = []
    session.on(AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item as { role?: string; textContent?: string }
      if (item.textContent) transcript.push(`${item.role ?? 'unknown'}: ${item.textContent}`)
    })

    ctx.addShutdownCallback(async () => {
      if (providerCallId) {
        store.finishCall(providerCallId, {
          endedReason: 'worker_shutdown',
          transcript: transcript.join('\n') || null,
          metrics: { modelUsage: session.usage.modelUsage, turns: transcript.length },
        })
      }
      // The task's own finish() has usually already set a terminal status; this
      // is what queues a retry when the call simply dropped.
      await onCallEnded(task.id, 'worker_shutdown')
    })

    await session.start({ agent, room: ctx.room })
    console.log(`[worker] live on ${room} for task ${task.id.slice(0, 8)}`)
  },
})

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    // Explicit dispatch: this worker only takes jobs addressed to it, so it
    // never picks up unrelated rooms.
    agentName: config.livekit.agentName,
    wsURL: config.livekit.url,
    apiKey: config.livekit.apiKey,
    apiSecret: config.livekit.apiSecret,
  }),
)
