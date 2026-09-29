#!/usr/bin/env node
/**
 * Operator CLI for the DSH Telegram plugin: verify the bot token, discover the
 * chat ids to send to, and send a message outside the agent loop.
 *
 * Usage:
 *   dsh-xxnerv-telegram getMe
 *   dsh-xxnerv-telegram updates [--limit 20]
 *   dsh-xxnerv-telegram send --chat <id|@username> --text "hello" [--silent] [--parse-mode HTML]
 *
 * Flags (all subcommands): --token <t> --proxy <url> --api-base <url> --timeout <ms>
 * Environment fallbacks: DSH_XXNERV_TELEGRAM_BOT_TOKEN, DSH_XXNERV_TELEGRAM_PROXY, DSH_XXNERV_TELEGRAM_API_BASE
 */
import process from 'node:process'
import { DEFAULT_API_BASE, TelegramError, callBotApi } from '../lib/telegram.js'

/**
 * Parse `--flag value` / `--flag=value` / boolean flags.
 * @param argv - arguments after the subcommand.
 * @returns parsed flags and positionals.
 */
function parseFlags(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const [rawKey, inline] = arg.slice(2).split('=')
    const key = rawKey.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
    if (inline !== undefined) {
      flags[key] = inline
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      index += 1
    } else {
      flags[key] = true
    }
  }
  return { flags, positionals }
}

/** Print usage and exit with the given status. */
function usage(status) {
  const text = [
    'usage: dsh-xxnerv-telegram <getMe|updates|send> [options]',
    '',
    '  getMe                       verify the token and show the bot identity',
    '  updates [--limit N]         show recent chats that messaged the bot (getUpdates)',
    '  send --chat <id> --text <t> send one message',
    '',
    'options: --token <t> --proxy <url> --api-base <url> --timeout <ms>',
    'env:     DSH_XXNERV_TELEGRAM_BOT_TOKEN, DSH_XXNERV_TELEGRAM_PROXY, DSH_XXNERV_TELEGRAM_API_BASE',
  ].join('\n')
  ;(status === 0 ? process.stdout : process.stderr).write(`${text}\n`)
  process.exit(status)
}

const [, , command, ...rest] = process.argv
if (command === undefined || command === '--help' || command === '-h') usage(command === undefined ? 2 : 0)

const { flags } = parseFlags(rest)
const token = String(flags.token ?? process.env.DSH_XXNERV_TELEGRAM_BOT_TOKEN ?? '').trim()
const proxyUrl = String(flags.proxy ?? process.env.DSH_XXNERV_TELEGRAM_PROXY ?? '').trim()
const apiBase = String(flags.apiBase ?? process.env.DSH_XXNERV_TELEGRAM_API_BASE ?? DEFAULT_API_BASE).trim()
const timeoutMs = Number(flags.timeout ?? 15_000)
const call = (method, body) => callBotApi({ token, method, body, apiBase, proxyUrl, timeoutMs })

try {
  if (token === '') throw new TelegramError('no bot token: pass --token or set DSH_XXNERV_TELEGRAM_BOT_TOKEN')
  if (command === 'getMe') {
    const me = await call('getMe', {})
    process.stdout.write(`${me.first_name ?? ''} (@${me.username ?? '?'}) id=${me.id}\n`)
  } else if (command === 'updates') {
    const limit = Number(flags.limit ?? 20)
    const updates = await call('getUpdates', { limit, timeout: 0, allowed_updates: ['message', 'channel_post'] })
    if (!Array.isArray(updates) || updates.length === 0) {
      process.stdout.write('no updates. Send the bot a message in Telegram first (and make sure no webhook is set).\n')
    } else {
      for (const update of updates) {
        const message = update.message ?? update.channel_post ?? update.edited_message
        const chat = message?.chat
        if (chat === undefined) continue
        const label = chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(' ') ?? ''
        const preview = String(message?.text ?? '').slice(0, 60).replace(/\s+/g, ' ')
        process.stdout.write(`chat_id=${chat.id}\ttype=${chat.type}\t${label}\t${preview}\n`)
      }
    }
  } else if (command === 'send') {
    const chat = flags.chat
    const text = flags.text
    if (chat === undefined || text === undefined) usage(2)
    const result = await call('sendMessage', {
      chat_id: String(chat),
      text: String(text),
      ...(flags.parseMode === undefined ? {} : { parse_mode: String(flags.parseMode) }),
      ...(flags.silent === true ? { disable_notification: true } : {}),
    })
    process.stdout.write(`sent message_id=${result.message_id} chat_id=${result.chat?.id}\n`)
  } else {
    usage(2)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}
