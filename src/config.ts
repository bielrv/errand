import 'dotenv/config'

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`)
  return v
}
function opt(name: string, fallback: string): string {
  return process.env[name] || fallback
}

export const config = {
  port: Number(opt('PORT', '3000')),
  /** Public HTTPS base URL that Vapi and Twilio can reach. */
  publicUrl: need('PUBLIC_URL').replace(/\/$/, ''),
  /** Shared secret echoed on every provider webhook; we reject anything else. */
  webhookSecret: need('WEBHOOK_SECRET'),

  vapi: {
    apiKey: need('VAPI_API_KEY'),
    phoneNumberId: need('VAPI_PHONE_NUMBER_ID'),
    baseUrl: opt('VAPI_BASE_URL', 'https://api.vapi.ai'),
    model: { provider: opt('MODEL_PROVIDER', 'anthropic'), model: opt('MODEL', 'claude-sonnet-5') },
    voice: { provider: opt('VOICE_PROVIDER', '11labs'), voiceId: opt('VOICE_ID', 'burt') },
    transcriber: { provider: opt('TRANSCRIBER_PROVIDER', 'deepgram'), model: opt('TRANSCRIBER_MODEL', 'nova-3') },
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
  },

  /** How often the orchestrator looks for work, in ms. */
  tickMs: Number(opt('TICK_MS', '30000')),
  dbPath: opt('DB_PATH', './data/errand.db'),
}
