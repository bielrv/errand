# errand

A voice agent that phones companies on your behalf and works a task until it is
finished. You describe the errand in a sentence; it dials, navigates the menu,
talks to a human, texts you when it needs a code or a decision, calls back if
they tell it to, and texts you the outcome.

It is deliberately generic. There is no per-company flow to write. A task is
data - an objective, some facts, some rules - and the agent gets the same six
verbs no matter what it is calling about.

## How it works

```
  you  ──"call X about Y"──▶  cli  ──▶  Claude composes the brief
                                            │
                                            ▼
                                    SQLite task queue
                                            │
                       orchestrator ────────┤  respects opening hours,
                                            │  retries with backoff
                                            ▼
                                     Vapi  ──▶  Twilio number  ──▶  the company
                                       │
                          tool calls   │   end-of-call report
                                       ▼
                            your server ──SMS──▶  you
```

- **`src/prompt.ts`** composes the system prompt. Task-specific material comes
  in as data; the safety rails are baked in and a task cannot override them.
- **`src/tools.ts`** is the agent's whole capability set: `lookup_fact`,
  `record`, `ask_principal`, `request_approval`, `schedule_callback`, `finish`.
- **`src/orchestrator.ts`** turns a call into a task that finishes - a dropped
  call or an unhelpful agent means a retry, not a failure.
- **`src/providers/vapi.ts`** is the only file that knows about Vapi.

## Design decisions worth knowing

**Facts have a disclosure policy.** Anything marked `on_request` is kept out of
the prompt entirely; the agent has to call `lookup_fact` to get it, which means
every account number spoken aloud is logged in the `disclosures` table. Facts
marked `never` never reach the model at all.

**It never claims to be you.** The opening line says it is an AI calling on
your behalf. Rule 1 of the prompt says so too, and rule 2 says to admit it if
asked. This is also what the EU AI Act transparency rules require.

**Nothing binding happens without you.** `request_approval` texts you and waits.
No reply means declined, not approved.

**One-time passcodes go through you.** `ask_principal` texts you, holds the line
for `PRINCIPAL_WAIT_SECONDS`, and if you do not reply the agent arranges a
call-back rather than guessing.

## Setup

### 1. Accounts

- **Twilio** - buy a UK or Spanish number. You need the account SID, auth token,
  and a number for outbound SMS (it can be the same one).
- **Vapi** - import that Twilio number under Phone Numbers. Copy the phone
  number **id** (not the number itself) into `VAPI_PHONE_NUMBER_ID`.
- **Anthropic** - an API key for the CLI's brief composer. `ANTHROPIC_API_KEY`,
  or run `ant auth login`.

### 2. Config

```bash
cp .env.example .env
```

Fill it in. `PUBLIC_URL` must be reachable from the internet, because Vapi and
Twilio call back into it. For local work:

```bash
npx untun@latest tunnel http://localhost:3000
```

Then point Twilio's inbound SMS webhook at `<PUBLIC_URL>/webhooks/sms`.

### 3. Run

```bash
npm install
npm start
```

### 4. Give it an errand

```bash
npm run task -- "Call British Gas about the boiler at Flat 3, 12 Elm Road SW4 7TG. No hot water since Monday, error F28. Account 8829301744. Get an engineer booked, weekday mornings only."
```

It shows you the brief it composed, asks you to confirm, and queues it. You get
a text when it needs you and a text when it is done.

Other commands:

```bash
npm run task -- --file tasks/example-boiler.json   # skip the composer
npm run task -- --list
npm run task -- --show <id>
npm run prompt -- tasks/example-boiler.json        # see the exact prompt
npm run smoke                                      # 26 checks, no phone call
```

## Before it will actually work

**Register the agent as an authorised contact on each account.** This is the
part that decides whether the whole thing works, and it is paperwork rather than
code. Most UK and Spanish utilities let you add a named third party or grant
"authority to act" - one phone call per account, made by you. Without it the
agent will get through the menu, be asked to prove it is you, correctly refuse,
and hand the task back.

**Test on something low-stakes first.** Your own broadband provider, not the
tenant's emergency.

## Cost

Roughly EUR 0.10-0.20 per minute all in (Vapi platform, Twilio minutes, the
model, the voice). A 30 minute hold-and-resolve call costs about EUR 5 and none
of your time. The Twilio number is a few euros a month.

## Deploying

It is a single Node process plus a SQLite file. Fly.io, Railway or a EUR 5 VPS
all work. It needs to stay up: call-backs and SMS replies arrive at their own
pace, not yours.

## Limits

- The retry ladder is 15 min, 1 h, 4 h, 24 h, then it gives up and texts you.
- `parseWhen` handles "tomorrow 9am", "Tuesday", ISO dates and "in 2 hours".
  Anything else becomes "try again in two hours".
- Business hours are a simple open/close/weekday window per callee. No bank
  holidays.
- One call at a time per task. Nothing stops several tasks running at once.
