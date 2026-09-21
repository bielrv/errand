import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import Anthropic from '@anthropic-ai/sdk'
import * as store from './db.js'
import { withinBusinessHours, nextOpenSlot } from './orchestrator.js'
import { TaskInput } from './types.js'

/**
 * The front door: describe the errand in plain English, Claude turns it into a
 * task, you check it, it goes in the queue.
 *
 *   npm run task -- "Call British Gas about the boiler at Flat 3, 12 Elm Road.
 *                    No hot water since Monday. Account 8829301. Get an
 *                    engineer booked, mornings only."
 *   npm run task -- --file tasks/example.json
 *   npm run task -- --list
 *   npm run task -- --show <id>
 */

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Six words or fewer, e.g. "boiler repair at Flat 3".' },
    objective: {
      type: 'string',
      description:
        'What the agent must achieve, written as instructions to a competent assistant who knows nothing about the situation. Include the history and the constraints. Three to six sentences.',
    },
    callee: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        phone: { type: 'string', description: 'E.164. Leave empty if not given; do not invent one.' },
        ivrHints: { type: 'string' },
        timezone: { type: 'string', description: 'IANA, e.g. Europe/London.' },
      },
      required: ['name', 'phone', 'timezone'],
    },
    language: { type: 'string', description: 'BCP-47, e.g. en-GB or es-ES.' },
    facts: {
      type: 'array',
      description:
        'Every concrete detail: account numbers, addresses, names, dates, meter readings. Mark anything used to prove identity as on_request; mark addresses and the nature of the problem proactive.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          value: { type: 'string' },
          disclosure: { type: 'string', enum: ['proactive', 'on_request', 'never'] },
        },
        required: ['key', 'label', 'value', 'disclosure'],
      },
    },
    constraints: {
      type: 'array',
      items: { type: 'string' },
      description: 'Limits the user stated or clearly implied, e.g. "mornings only", "do not accept a new tariff".',
    },
    success: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'objective', 'callee', 'language', 'facts', 'constraints', 'success'],
}

const COMPOSER_SYSTEM = `
You turn a short description of a real-world errand into a structured brief for
a voice agent that will phone a company and handle it.

Rules:
- Never invent a phone number, account number, address or date. If the user did
  not give it, leave the field out. A missing phone number is fine; the user
  will be asked for it.
- Split every concrete detail out into facts. The objective should read well
  without them.
- disclosure: 'proactive' for things that help explain the problem (address,
  what is broken, when it started). 'on_request' for anything that proves
  identity (account number, date of birth, postcode when used as a password,
  customer reference). 'never' for anything the user said to keep private.
- success criteria must be checkable by someone listening to the call.
- Infer the language from the country of the company being called.
`.trim()

async function compose(description: string) {
  const client = new Anthropic()
  const res = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: COMPOSER_SYSTEM,
    tools: [
      {
        name: 'create_task',
        description: 'Emit the structured brief.',
        input_schema: TASK_SCHEMA as Anthropic.Tool['input_schema'],
        strict: true,
      },
    ],
    tool_choice: { type: 'tool', name: 'create_task' },
    messages: [{ role: 'user', content: description }],
  })

  const block = res.content.find((b) => b.type === 'tool_use')
  if (!block || block.type !== 'tool_use') throw new Error('The model did not produce a brief.')
  return block.input as Record<string, unknown>
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(question)
  rl.close()
  return answer.trim()
}

function summarise(draft: Record<string, unknown>): string {
  const d = draft as {
    title: string
    objective: string
    callee: { name: string; phone: string }
    facts: { label: string; value: string; disclosure: string }[]
    constraints: string[]
    success: string[]
  }
  const lines = [
    ``,
    `  ${d.title}`,
    `  Calling: ${d.callee.name} ${d.callee.phone || '(NO NUMBER)'}`,
    ``,
    `  ${d.objective.replace(/\n/g, '\n  ')}`,
    ``,
  ]
  if (d.facts?.length) {
    lines.push(`  Facts it may use:`)
    for (const f of d.facts) {
      const tag = f.disclosure === 'on_request' ? 'only if asked' : f.disclosure === 'never' ? 'NEVER SAY' : 'volunteers'
      lines.push(`    ${f.label}: ${f.value}   [${tag}]`)
    }
    lines.push(``)
  }
  if (d.constraints?.length) {
    lines.push(`  Rules:`)
    d.constraints.forEach((c) => lines.push(`    - ${c}`))
    lines.push(``)
  }
  if (d.success?.length) {
    lines.push(`  Done when:`)
    d.success.forEach((s) => lines.push(`    - ${s}`))
    lines.push(``)
  }
  return lines.join('\n')
}

async function main() {
  const argv = process.argv.slice(2)

  if (argv[0] === '--list') {
    for (const t of store.listTasks()) {
      console.log(`${t.id.slice(0, 8)}  ${t.status.padEnd(18)}  ${t.attempts}x  ${t.title}`)
    }
    return
  }

  if (argv[0] === '--show') {
    const id = argv[1]
    const task = store.listTasks().find((t) => t.id.startsWith(id ?? ''))
    if (!task) return console.error('No such task.')
    console.log(JSON.stringify({ task, calls: store.callsForTask(task.id) }, null, 2))
    return
  }

  let draft: Record<string, unknown>

  if (argv[0] === '--file') {
    if (!argv[1]) throw new Error('--file needs a path')
    draft = JSON.parse(readFileSync(argv[1], 'utf8'))
  } else {
    const description = argv.join(' ').trim()
    if (!description) {
      console.error('Describe the errand, e.g.:\n  npm run task -- "Call X about Y..."')
      process.exit(1)
    }
    process.stdout.write('Working out what to do... ')
    draft = await compose(description)
    console.log('done.')
  }

  console.log(summarise(draft))

  const callee = draft.callee as { phone?: string }
  if (!callee?.phone) {
    callee.phone = await ask('  Phone number to call (E.164, e.g. +442079460000): ')
  }

  const parsed = TaskInput.safeParse(draft)
  if (!parsed.success) {
    console.error('That brief is not valid:')
    console.error(JSON.stringify(parsed.error.flatten(), null, 2))
    process.exit(1)
  }

  const confirm = await ask('  Queue it? [y/N] ')
  if (!/^y/i.test(confirm)) return console.log('  Cancelled.')

  const task = store.createTask(parsed.data)
  const when = withinBusinessHours(task) ? 'now' : nextOpenSlot(task).toUTCString()
  console.log(`\n  Queued ${task.id.slice(0, 8)}. First call: ${when}.`)
  console.log(`  You will get a text when it needs you or when it is finished.\n`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
