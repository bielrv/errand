/** Print the exact prompt a task would produce: npm run prompt -- tasks/x.json */
import { readFileSync } from 'node:fs'
import { buildAssistant } from '../src/providers/vapi.js'
import { TaskInput } from '../src/types.js'

const path = process.argv[2]
if (!path) throw new Error('usage: npm run prompt -- tasks/example-boiler.json')
const input = TaskInput.parse(JSON.parse(readFileSync(path, 'utf8')))
const task = {
  ...input,
  id: 'preview',
  status: 'queued' as const,
  attempts: 0,
  nextAttemptAt: '',
  findings: {},
  summary: null,
  createdAt: '',
  updatedAt: '',
}
const assistant = buildAssistant(task) as { firstMessage: string; model: { messages: { content: string }[] } }
console.log('=== OPENING LINE ===\n')
console.log(assistant.firstMessage)
console.log('\n=== SYSTEM PROMPT ===\n')
console.log(assistant.model.messages[0]!.content)
