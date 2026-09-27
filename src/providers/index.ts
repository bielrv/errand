import { config } from '../config.js'
import type { VoiceProvider } from './types.js'

/**
 * Picks the voice stack from VOICE_STACK. Lazy, so that running one stack does
 * not import the other's SDK or demand its credentials.
 */
let cached: VoiceProvider | null = null

export async function provider(): Promise<VoiceProvider> {
  if (cached) return cached
  if (config.provider === 'livekit') {
    const { livekitProvider } = await import('./livekit.js')
    cached = livekitProvider
  } else {
    const { vapiProvider } = await import('./vapi.js')
    cached = vapiProvider
  }
  return cached
}

export type { PlacedCall, VoiceProvider } from './types.js'
