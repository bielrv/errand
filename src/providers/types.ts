import type { Task } from '../types.js'

/**
 * What the orchestrator needs from a voice stack. Nothing more.
 *
 * The two implementations sit at different tiers. Vapi is managed: we hand it
 * a prompt and a number and it owns the media path, calling back over HTTP
 * when the model wants a tool. LiveKit is bring-your-own-pipeline: we dial a
 * SIP participant into a room and our own worker process runs the agent loop,
 * calling the same handlers as direct function calls.
 *
 * Because both stacks derive their prompt from `buildSystemPrompt` and their
 * tools from `toolSpecs`, the agent behaves identically either way. Only the
 * transport differs.
 */
export type PlacedCall = {
  /** Whatever the provider calls this call. Stored so webhooks can find the task. */
  providerCallId: string
}

export type VoiceProvider = {
  name: 'vapi' | 'livekit'
  placeCall(task: Task): Promise<PlacedCall>
  endCall(providerCallId: string): Promise<void>
}
