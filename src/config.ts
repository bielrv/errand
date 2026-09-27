import 'dotenv/config'

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`)
  return v
}
function opt(name: string, fallback: string): string {
  return process.env[name] || fallback
}

export type ProviderName = 'vapi' | 'livekit'

const provider = opt('VOICE_STACK', 'vapi') as ProviderName
if (provider !== 'vapi' && provider !== 'livekit') {
  throw new Error(`VOICE_STACK must be "vapi" or "livekit", got "${provider}"`)
}

export const config = {
  /** Which voice stack places the calls. See src/providers/. */
  provider,

  port: Number(opt('PORT', '3000')),
  /** Public HTTPS base URL that the providers and Twilio can reach. */
  publicUrl: need('PUBLIC_URL').replace(/\/$/, ''),
  /** Shared secret echoed on every provider webhook; we reject anything else. */
  webhookSecret: need('WEBHOOK_SECRET'),

  // Provider blocks are getters so that running on one stack does not demand
  // the other one's credentials.
  get vapi() {
    return {
      apiKey: need('VAPI_API_KEY'),
      phoneNumberId: need('VAPI_PHONE_NUMBER_ID'),
      baseUrl: opt('VAPI_BASE_URL', 'https://api.vapi.ai'),
    }
  },

  get livekit() {
    return {
      url: need('LIVEKIT_URL'),
      apiKey: need('LIVEKIT_API_KEY'),
      apiSecret: need('LIVEKIT_API_SECRET'),
      /** Outbound SIP trunk, created once from your Twilio trunk. */
      sipTrunkId: need('LIVEKIT_SIP_TRUNK_ID'),
      /** Caller ID. Empty means use the trunk's own number. */
      fromNumber: opt('LIVEKIT_SIP_FROM_NUMBER', ''),
      /** Must match the worker's agentName for explicit dispatch to find it. */
      agentName: opt('LIVEKIT_AGENT_NAME', 'errand'),
      /** Give up if nobody picks up. */
      ringingTimeoutSeconds: Number(opt('RINGING_TIMEOUT_SECONDS', '60')),
    }
  },

  /** Shared by both stacks. */
  model: { provider: opt('MODEL_PROVIDER', 'anthropic'), model: opt('MODEL', 'claude-opus-5') },
  voice: { provider: opt('VOICE_PROVIDER', '11labs'), voiceId: opt('VOICE_ID', 'burt') },
  transcriber: {
    provider: opt('TRANSCRIBER_PROVIDER', 'deepgram'),
    model: opt('TRANSCRIBER_MODEL', 'nova-3'),
  },

  twilio: {
    accountSid: need('TWILIO_ACCOUNT_SID'),
    authToken: need('TWILIO_AUTH_TOKEN'),
    /** Number the SMS escalations come from. */
    from: need('TWILIO_SMS_FROM'),
  },

  principal: {
    name: opt('PRINCIPAL_NAME', 'the account holder'),
    /** Where questions and approvals get texted. */
    mobile: need('PRINCIPAL_MOBILE'),
  },

  agent: {
    name: opt('AGENT_NAME', 'Max'),
    /** Seconds the agent will hold the line waiting for you to reply by SMS. */
    principalWaitSeconds: Number(opt('PRINCIPAL_WAIT_SECONDS', '45')),
    maxCallSeconds: Number(opt('MAX_CALL_SECONDS', '2700')),
    /**
     * Phone lines pause far longer than a video call does, and a call centre
     * agent saying "bear with me" is not the end of their turn. Both stacks
     * get a longer silence window than their own defaults.
     */
    endOfTurnSilenceMs: Number(opt('END_OF_TURN_SILENCE_MS', '900')),
  },

  /** How often the orchestrator looks for work, in ms. */
  tickMs: Number(opt('TICK_MS', '30000')),
  dbPath: opt('DB_PATH', './data/errand.db'),
}
