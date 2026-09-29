#!/usr/bin/env node
/**
 * Fake Telegram Bot API origin for the integration run. Requests are appended to
 * a JSONL file so the shell runner can assert what the booted runtime actually sent.
 *
 * Usage: node fake-telegram.mjs <port> <log-path>
 */
import { appendFileSync } from 'node:fs'
import { startFakeTelegram } from '../helpers.mjs'

const port = Number(process.argv[2] ?? 18791)
const logPath = process.argv[3] ?? '/tmp/fake-telegram.jsonl'

const server = await startFakeTelegram({
  port,
  handler: call => ({
    status: 200,
    body: { ok: true, result: { message_id: 1001, date: 1_700_000_000, chat: { id: Number(call.json?.chat_id ?? 0), type: 'private' } } },
  }),
})

process.stdout.write(`fake-telegram listening on ${server.url}\n`)

// Record every request as it arrives, so assertions can run after the boot exits.
let seen = 0
const timer = setInterval(() => {
  while (seen < server.calls.length) {
    const call = server.calls[seen++]
    appendFileSync(logPath, `${JSON.stringify({ method: call.method, url: call.url, body: call.json })}\n`)
  }
}, 25)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(timer)
    while (seen < server.calls.length) {
      const call = server.calls[seen++]
      appendFileSync(logPath, `${JSON.stringify({ method: call.method, url: call.url, body: call.json })}\n`)
    }
    process.exit(0)
  })
}
