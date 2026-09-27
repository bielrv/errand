import { tool } from '@livekit/agents'
import type { JSONSchema7 } from 'json-schema'
import * as store from '../db.js'
import { buildFirstMessage, buildSystemPrompt } from '../prompt.js'
import { runTool, toolSpecs } from '../tools.js'
import type { Task } from '../types.js'

/**
 * Everything the LiveKit worker needs to build its agent, kept out of
 * worker.ts so it can be tested without starting a worker process (worker.ts
 * calls cli.runApp at import time).
 */

/**
 * On the managed stack the opening line is a scripted first utterance. Here we
 * are already listening when the line connects, so speaking immediately would
 * talk over the IVR. The line becomes an instruction instead.
 */
export function buildInstructions(task: Task): string {
  return (
    buildSystemPrompt(task) +
    `\n\nOPENING THE CALL.\nYou are connected but the line may start with ringing or a ` +
    `recorded menu. Say nothing until you are sure a person is speaking to you. ` +
    `Your first words to a person must be, near enough:\n"${buildFirstMessage(task)}"`
  )
}

/**
 * The same six handlers as the Vapi path, reached as direct function calls
 * instead of over HTTP.
 */
export function buildTools(task: Task, callId: string | null) {
  return toolSpecs().map((spec) =>
    tool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters as JSONSchema7,
      execute: async (args) => {
        // Re-read so each call sees what the last one wrote.
        const fresh = store.getTask(task.id) ?? task
        return runTool(fresh, callId, spec.name, args as Record<string, unknown>)
      },
    }),
  )
}
