import { AgentDispatchClient, RoomServiceClient, SipClient } from 'livekit-server-sdk'
import { config } from '../config.js'
import type { PlacedCall, VoiceProvider } from './types.js'
import type { Task } from '../types.js'

/**
 * The bring-your-own-pipeline stack.
 *
 * Three steps, in this order:
 *   1. create the room, so it exists before anything tries to join it
 *   2. dispatch our worker into it, so the agent is listening before the
 *      callee says "hello"
 *   3. dial the callee in over SIP
 *
 * Doing (3) before (2) loses the opening seconds of the call, which on a
 * utility line is exactly when the IVR starts talking.
 *
 * The agent loop itself lives in src/agent/worker.ts - a separate process. It
 * reads the task id out of the job metadata we set here.
 */

/** The SDK's HTTP clients want an https:// host, not the wss:// media URL. */
const httpHost = () => config.livekit.url.replace(/^ws/, 'http').replace(/\/$/, '')

const roomName = (taskId: string) => `errand-${taskId}`

let rooms: RoomServiceClient | null = null
let dispatch: AgentDispatchClient | null = null
let sip: SipClient | null = null

function clients() {
  const { apiKey, apiSecret } = config.livekit
  rooms ??= new RoomServiceClient(httpHost(), apiKey, apiSecret)
  dispatch ??= new AgentDispatchClient(httpHost(), apiKey, apiSecret)
  sip ??= new SipClient(httpHost(), apiKey, apiSecret)
  return { rooms, dispatch, sip }
}

async function placeCall(task: Task): Promise<PlacedCall> {
  const lk = config.livekit
  const { rooms, dispatch, sip } = clients()
  const room = roomName(task.id)

  await rooms.createRoom({
    name: room,
    // Tear the room down shortly after the call drops; nothing else uses it.
    emptyTimeout: 60,
    departureTimeout: 20,
    maxParticipants: 3,
    metadata: JSON.stringify({ taskId: task.id, title: task.title }),
  })

  await dispatch.createDispatch(room, lk.agentName, {
    // This is how the worker learns which task it is working.
    metadata: JSON.stringify({ taskId: task.id }),
  })

  const participant = await sip.createSipParticipant(lk.sipTrunkId, task.callee.phone, room, {
    participantIdentity: 'callee',
    participantName: task.callee.name,
    ...(lk.fromNumber ? { fromNumber: lk.fromNumber } : {}),
    // Let the agent hear the ringing so it knows the call has not connected yet.
    playDialtone: true,
    ringingTimeout: lk.ringingTimeoutSeconds,
    // A hard ceiling on the call, which is also a hard ceiling on its cost.
    maxCallDuration: config.agent.maxCallSeconds,
    krispEnabled: true,
    // Return as soon as it is dialling. The worker handles the pickup.
    waitUntilAnswered: false,
  })

  // The room name is the durable handle: the SIP participant id changes if the
  // call is redialled, the room does not.
  return { providerCallId: `${room}#${participant.participantId}` }
}

async function endCall(providerCallId: string): Promise<void> {
  const room = providerCallId.split('#')[0]
  if (!room) return
  await clients().rooms.deleteRoom(room)
}

export const livekitProvider: VoiceProvider = { name: 'livekit', placeCall, endCall }

/** Exported for the worker, which needs to map a room back to its task. */
export function taskIdFromRoom(room: string): string | null {
  return room.startsWith('errand-') ? room.slice('errand-'.length) : null
}
