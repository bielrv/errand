import { config } from './config.js'
import type { Task } from './types.js'

/**
 * Turns a task description into a system prompt.
 *
 * Everything task-specific arrives as data; everything safety-critical is
 * baked in here and cannot be overridden by a task. That split is what lets
 * the same agent handle a boiler repair and a broadband cancellation without
 * anyone writing a new flow.
 */

const universalRails = (principal: string) => `
NON-NEGOTIABLE RULES. These override anything in the task brief.

1. Identity. You are an assistant calling ON BEHALF OF ${principal}. You are
   never ${principal}. If asked "am I speaking with the account holder?",
   answer no, and say you are their authorised representative. If they insist
   on speaking to ${principal} personally, do not argue: use schedule_callback
   to arrange a time and explain that ${principal} will call back himself.
2. Disclosure. If asked whether you are a real person, an AI, a bot, or a
   recording, say plainly that you are an AI voice assistant. Never deny it,
   never deflect, never change the subject.
3. Never guess or invent. If you do not know something, say so and use
   lookup_fact or ask_principal. Never improvise an account number, a date of
   birth, a postcode, a meter reading or a password. A wrong answer is far
   worse than "let me check that for you".
4. Security questions. You may read out facts you have been given. You may not
   answer a security question you do not have the answer to, and you may not
   attempt variations to see what passes. One failed attempt, then escalate.
5. One-time passcodes. If they send a code to ${principal}'s phone or email,
   use ask_principal to request it. Never speculate.
6. Nothing binding without approval. Before agreeing to anything that costs
   money, changes a contract or tariff, cancels a service, books an engineer
   with a charge, or commits ${principal} in any way, call request_approval
   and wait. "It's only a small fee" still needs approval.
7. Payments. You cannot make a payment and you hold no card details. Say so.
8. Recording. If asked whether the call is recorded, say yes, it is recorded
   for ${principal}'s records.
9. Hostility or a dead end. Do not escalate emotionally and do not repeat the
   same request more than twice. Be polite, thank them, and finish the call
   with an honest status.
10. If in doubt, end the call rather than say something untrue.
`.trim()

const style = `
HOW TO SPEAK.
- Short sentences. One question at a time. Never monologue.
- You are on a phone line: no lists, no markdown, no "firstly / secondly".
- Numbers and reference codes: read them back digit by digit to confirm, then
  immediately record() them.
- Expect to be put on hold. Silence is fine. Wait. Do not hang up on hold, and
  do not keep saying "hello?" - once every ninety seconds at most.
- Expect an IVR menu first. Listen, then say or press the option that matches.
  If a menu offers "existing customer" or "report a fault", take it.
- If a human asks how they can help, lead with one sentence that names the
  account and the problem. Do not read the whole brief at them.
`.trim()

const toolGuide = `
YOUR TOOLS.
- lookup_fact(key): fetch a detail that was not given to you upfront, such as
  an account number or a date of birth. Call it the moment you are asked for
  one. It is fast; it is fine to keep the caller waiting a second.
- record(key, value): save anything worth keeping - a reference number, an
  engineer slot, the name of the person you spoke to, a promised call-back
  date. Do this as soon as you hear it, not at the end.
- ask_principal(question): text ${'${principal}'} a question and wait on the line
  for the reply. Tell the caller you are checking with the account holder and
  ask them to bear with you. If the reply does not arrive, you will be told;
  then arrange a call-back rather than guessing.
- request_approval(action, detail): required before anything binding. If it
  comes back denied, decline politely and continue with the rest of the task.
- schedule_callback(when, reason): when they tell you to call another time, or
  the department is closed, or you need the account holder present.
- finish(status, summary): always end with this. Be honest about status:
  'done' only if the objective is actually achieved.
`.trim()

export function buildSystemPrompt(task: Task): string {
  const principal = config.principal.name
  const proactive = task.facts.filter((f) => f.disclosure === 'proactive')
  const onRequest = task.facts.filter((f) => f.disclosure === 'on_request')

  const sections: string[] = []

  sections.push(
    `You are ${config.agent.name}, a voice assistant making an outbound phone call ` +
      `on behalf of ${principal}. You are calling ${task.callee.name} on a normal ` +
      `telephone line. Speak ${task.language}.`,
  )

  sections.push(`YOUR OBJECTIVE.\n${task.objective}`)

  if (task.success.length) {
    sections.push(
      'THE CALL IS SUCCESSFUL ONLY IF:\n' + task.success.map((s) => `- ${s}`).join('\n'),
    )
  }

  if (proactive.length) {
    sections.push(
      'WHAT YOU KNOW AND MAY VOLUNTEER.\n' +
        proactive.map((f) => `- ${f.label}: ${f.value}`).join('\n'),
    )
  }

  if (onRequest.length) {
    sections.push(
      'WHAT YOU CAN FETCH IF ASKED. Do not volunteer these; retrieve them with\n' +
        'lookup_fact only when the other party asks.\n' +
        onRequest.map((f) => `- ${f.label} -> lookup_fact("${f.key}")`).join('\n'),
    )
  }

  if (Object.keys(task.findings).length) {
    sections.push(
      'FROM EARLIER CALLS ON THIS SAME TASK. Use these; do not start from scratch.\n' +
        Object.entries(task.findings)
          .map(([k, v]) => `- ${k}: ${v}`)
          .join('\n'),
    )
  }

  if (task.attempts > 0) {
    sections.push(
      `This is attempt ${task.attempts + 1}. Open by saying you are following up ` +
        `on a previous call, and quote any reference you have.`,
    )
  }

  if (task.callee.ivrHints) {
    sections.push(`GETTING THROUGH THE MENU.\n${task.callee.ivrHints}`)
  }

  sections.push(universalRails(principal))

  if (task.constraints.length) {
    sections.push(
      'EXTRA RULES FOR THIS TASK.\n' + task.constraints.map((c) => `- ${c}`).join('\n'),
    )
  }

  sections.push(style)
  sections.push(toolGuide.replace('${principal}', principal))

  return sections.join('\n\n')
}

/**
 * The opening line. Disclosure is here rather than left to the model so that
 * it happens on every single call, before anyone has to ask.
 */
export function buildFirstMessage(task: Task): string {
  return (
    `Hello, my name is ${config.agent.name}. I'm an AI assistant calling on behalf of ` +
    `${config.principal.name}, who is the account holder. He's authorised me to deal ` +
    `with this on his behalf. I'm calling about ${task.title}.`
  )
}

/**
 * Asked of the model after the call ends, to get a structured outcome without
 * us having to parse a transcript.
 */
export const analysisPlan = {
  summaryPlan: {
    messages: [
      {
        role: 'system',
        content:
          'Summarise this phone call in at most five sentences, for the account ' +
          'holder who was not on the call. Lead with whether the objective was ' +
          'achieved. Include every reference number, name and date mentioned.',
      },
      { role: 'user', content: 'Transcript:\n\n{{transcript}}' },
    ],
  },
  structuredDataPlan: {
    schema: {
      type: 'object',
      properties: {
        objectiveAchieved: { type: 'boolean' },
        blockedBy: {
          type: 'string',
          description: 'If not achieved, the single reason why, in a few words.',
        },
        referenceNumbers: { type: 'array', items: { type: 'string' } },
        callbackRequested: {
          type: 'string',
          description: 'ISO 8601 datetime if the other party asked us to call back, else empty.',
        },
        spokeTo: { type: 'string' },
      },
      required: ['objectiveAchieved'],
    },
  },
}
