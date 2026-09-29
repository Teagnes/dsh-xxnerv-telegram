/**
 * DSH plugin: send Telegram messages through a bot.
 *
 * Three contributions:
 *
 * 1. `xxnerv_telegram_send` — a model-callable tool that posts one text message.
 * 2. `xxnerv_telegram_config` — reads the effective configuration and writes the
 *    editable fields (bot token, chat ids, proxy, auto-push) back into the
 *    profile through the harness settings service, so no YAML editing is needed.
 * 3. An optional turn-end notification that pushes the finished turn's last
 *    assistant text to a Telegram chat.
 *
 * The token, chat ids, proxy, and the auto-push switch are declared
 * `.volatile()`: the harness exposes them as editable configuration, persists
 * writes into the active profile's Cordis patch, and hands the plugin live
 * references — so a change takes effect without restarting or reloading the
 * plugin. The token additionally carries `role('secret')` so form and API
 * surfaces receive a presence marker instead of the secret.
 *
 * Shell-free logic lives in `./telegram.js`, `./notify.js`, and `./config.js`;
 * this module declares the config schema and wires the contributions.
 *
 * @module dsh-xxnerv-telegram
 */
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  SETTINGS_NAMESPACE,
  buildConfigPatch,
  configBoolean,
  configNumber,
  configString,
  maskSecret,
  patchFieldNames,
  readEffectiveConfig,
} from './config.js'
import { TurnEndNotifier } from './notify.js'
import { DEFAULT_API_BASE, MAX_MESSAGE_CHARS, TelegramError, callBotApi, clampMessageText } from './telegram.js'

export const name = 'xxnerv-telegram'

/** The tool registry must exist before the tools can be registered. */
export const inject = ['tools']

/**
 * Plugin configuration: bundle defaults first, then the profile's own
 * `cordis.patch.yml` override, plus whatever `xxnerv_telegram_config` writes later.
 *
 * Fields marked `.volatile()` are the ones a person changes at runtime; they
 * arrive as live references and are editable through the harness settings
 * service. The remaining fields are deployment constants edited in the patch.
 */
export const Config = Schema.object({
  botToken: Schema.string().default('').role('secret').volatile(),
  defaultChatId: Schema.string().default('').volatile(),
  notifyChatId: Schema.string().default('').volatile(),
  proxyUrl: Schema.string().default('').volatile(),
  notifyOnTurnEnd: Schema.boolean().default(false).volatile(),
  apiBase: Schema.string().default(DEFAULT_API_BASE),
  timeoutMs: Schema.number().default(15_000),
  notifyMaxChars: Schema.number().default(600),
  notifyOnlyHumanSessions: Schema.boolean().default(true),
})

/**
 * Register both tools and, when enabled, the turn-end notifier.
 * @param ctx - registrant context; `ctx.tools` must be available.
 * @param config - validated plugin configuration (volatile fields are references).
 */
export function apply(ctx, config) {
  /** Current effective configuration, read fresh so edits apply immediately. */
  const current = () => readEffectiveConfig(config)

  /**
   * Send one Bot API method with the deployment's current transport settings.
   * @param method - Bot API method name.
   * @param body - request payload.
   * @param signal - caller-owned cancellation signal.
   * @returns the unwrapped Bot API `result`.
   */
  const call = (method, body, signal) => {
    const settings = current()
    return callBotApi({
      token: settings.botToken,
      method,
      body,
      apiBase: settings.apiBase,
      proxyUrl: settings.proxyUrl,
      timeoutMs: settings.timeoutMs,
      signal,
    })
  }

  ctx.tools.register(defineTool({
    name: 'xxnerv_telegram_send',
    description:
      'Send one text message to a Telegram chat through the configured bot. '
      + 'Use it when the user asks for a Telegram message or notification; do not send unsolicited messages. '
      + `The chat defaults to the plugin's configured chat id. Text longer than ${MAX_MESSAGE_CHARS} characters is truncated.`,
    parameters: {
      text: { type: 'string', required: true, description: 'Message text to send (max 4096 characters).' },
      chat_id: { type: 'string', description: 'Target chat id or @channelusername; omit to use the configured default chat.' },
      parse_mode: {
        type: 'string',
        enum: ['HTML', 'MarkdownV2'],
        description: 'Optional Telegram formatting mode. Omit for plain text, which never fails on markup.',
      },
      silent: { type: 'boolean', description: 'Deliver without a notification sound (disable_notification).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          messageId: { type: 'integer', required: true },
          chatId: { type: 'string', required: true },
          date: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const settings = current()
      const chatId = configString(args.chat_id, settings.defaultChatId)
      if (chatId === '') {
        throw new TelegramError(
          'xxnerv_telegram_send has no target chat: pass `chat_id`, or set the default chat with the xxnerv_telegram_config tool',
          { method: 'sendMessage' },
        )
      }
      const { text: messageText, truncated } = clampMessageText(args.text)
      if (messageText.trim() === '') throw new TelegramError('xxnerv_telegram_send requires non-empty `text`', { method: 'sendMessage' })
      const payload = { chat_id: chatId, text: messageText }
      if (args.parse_mode !== undefined) payload.parse_mode = args.parse_mode
      if (args.silent === true) payload.disable_notification = true
      const result = await call('sendMessage', payload, exec?.signal)
      const messageId = Number(result?.message_id ?? 0)
      const resolvedChatId = String(result?.chat?.id ?? chatId)
      const date = Number(result?.date ?? Math.floor(Date.now() / 1000))
      return {
        summary: `Sent Telegram message ${messageId} to chat ${resolvedChatId}${truncated ? ' (text truncated to the Telegram limit)' : ''}.`,
        messageId: Number.isFinite(messageId) ? messageId : 0,
        chatId: resolvedChatId,
        date: Number.isFinite(date) ? date : 0,
        truncated,
      }
    },
  }))

  /**
   * The settings namespace this plugin's own loader entry uses.
   *
   * The row id is discovered from the plugin's fiber rather than assumed, so a
   * profile that renames the row still writes to the right entry.
   * @returns the entry id, or the bundle's default row id.
   */
  const namespace = () => ctx.fiber?.entry?.options?.id ?? SETTINGS_NAMESPACE

  ctx.tools.register(defineTool({
    name: 'xxnerv_telegram_config',
    description:
      'Read or change the Telegram plugin configuration (bot token, target chat, proxy, turn-end notifications). '
      + 'Use it when the user asks to set up, point at another chat, or inspect the Telegram integration; '
      + 'changes are written to the active profile and take effect immediately.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'set'],
        description: 'status: report the effective configuration. set: write the fields supplied alongside.',
      },
      bot_token: { type: 'string', description: 'Telegram Bot Token from @BotFather (write-only; never echoed back).' },
      default_chat_id: { type: 'string', description: 'Chat id or @channelusername that xxnerv_telegram_send uses by default.' },
      notify_chat_id: { type: 'string', description: 'Chat that turn-end notifications go to; empty falls back to the default chat.' },
      proxy_url: { type: 'string', description: 'HTTP CONNECT proxy for reaching api.telegram.org, e.g. http://127.0.0.1:7897; empty means direct.' },
      notify_on_turn_end: { type: 'boolean', description: 'Push a notification when a human-prompted turn finishes.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          changed: { type: 'array', required: true, items: { type: 'string' } },
          effective: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const settings = current()
      const describe = () => [
        `botToken: ${maskSecret(settings.botToken)}`,
        `defaultChatId: ${settings.defaultChatId === '' ? '(未设置)' : settings.defaultChatId}`,
        `notifyChatId: ${settings.notifyChatId === '' ? '(未设置)' : settings.notifyChatId}`,
        `proxyUrl: ${settings.proxyUrl === '' ? '(直连)' : settings.proxyUrl}`,
        `notifyOnTurnEnd: ${settings.notifyOnTurnEnd}`,
      ].join('\n')
      if (args.action === 'status') {
        return {
          summary: `Telegram 配置（entry ${namespace()}）：\n${describe()}${describeLastWrite()}`,
          ok: true,
          changed: [],
          effective: describe(),
        }
      }
      const patch = buildConfigPatch(args)
      const changed = patchFieldNames(patch)
      if (changed.length === 0) {
        return {
          summary: '没有要写入的字段：请至少提供 bot_token / default_chat_id / notify_chat_id / proxy_url / notify_on_turn_end 之一。',
          ok: false,
          changed: [],
          effective: describe(),
        }
      }
      const submitted = scheduleConfigWrite(ctx, namespace(), patch)
      recordWrite(submitted.ok ? 'pending' : 'error', submitted.detail)
      return {
        summary: submitted.ok
          ? `已提交写入 ${changed.join(', ')}（entry ${namespace()}）。写入经 harness 配置服务落到 profile 的 cordis.patch.yml，`
            + '并在本轮工具调用结束后生效；用 xxnerv_telegram_config status 复核。'
          : `写入未提交：${submitted.detail}`,
        ok: submitted.ok,
        changed,
        effective: describe(),
      }
    },
  }))

  // The notifier is always mounted; the volatile switch decides per turn whether
  // anything is sent, so toggling it applies without a plugin reload.
  const notifier = new TurnEndNotifier({
    send: payload => call('sendMessage', payload),
    chatId: () => current().notifyChatId,
    maxChars: configNumber(config.notifyMaxChars, 600),
    onlyHumanSessions: configBoolean(config.notifyOnlyHumanSessions, true),
    logger: ctx.logger,
  })
  let warnedMissingTarget = false
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/end' && current().notifyOnTurnEnd === true && current().notifyChatId === '' && !warnedMissingTarget) {
      warnedMissingTarget = true
      notifier.warn('notifyOnTurnEnd is on but no chat id is configured; set it with the xxnerv_telegram_config tool')
    }
    if (current().notifyOnTurnEnd !== true) return
    notifier.observe(session, event)
  })
}

/**
 * Submit a configuration patch to the harness settings service without awaiting it.
 *
 * The service persists the change and applies it by reloading the entry, and
 * that reload cannot reach quiescence while the caller still holds an open tool
 * call or plugin activation — so awaiting `settings.update()` deadlocks, while
 * the write itself lands (verified: the profile patch is updated either way).
 * The write is therefore fire-and-forget and the outcome is recorded for the
 * next `status` call.
 *
 * @param ctx - plugin context.
 * @param ns - this plugin's profile entry id.
 * @param patch - fields to merge.
 * @returns whether the write could be started, with a diagnostic.
 */
function scheduleConfigWrite(ctx, ns, patch) {
  const settings = ctx.get('settings')
  if (settings === undefined) {
    return {
      ok: false,
      detail: `harness settings service is unavailable, so ${ns} cannot be rewritten in place; edit the telegram row in the profile's cordis.patch.yml instead`,
    }
  }
  let revision
  try {
    revision = settings.describe().find(row => row.ns === ns)?.revision
  } catch {
    revision = undefined
  }
  // Start on the next tick so the tool result is produced first.
  setTimeout(() => {
    Promise.resolve()
      .then(() => settings.update(ns, patch, revision))
      .then(
        () => recordWrite('ok', `${Object.keys(patch).join(', ')} applied`),
        error => {
          recordWrite('error', error instanceof Error ? error.message : String(error))
          try {
            ctx.logger?.warn?.(`telegram: config write failed: ${error instanceof Error ? error.message : String(error)}`)
          } catch {
            /* a disposed logger must not turn a failed write into a crash */
          }
        },
      )
  }, 0)
  return { ok: true, detail: 'submitted' }
}

/** Outcome of the most recent configuration write, surfaced by `status`. */
let lastWrite = { state: 'none', detail: '' }

/**
 * Record the most recent write outcome.
 * @param state - `pending`, `ok`, or `error`.
 * @param detail - short diagnostic.
 */
function recordWrite(state, detail) {
  lastWrite = { state, detail }
}

/**
 * Describe the most recent write for the `status` action.
 * @returns one summary line.
 */
function describeLastWrite() {
  if (lastWrite.state === 'none') return ''
  if (lastWrite.state === 'pending') return '\n最后一次写入：已提交，等待生效（用 status 再看一次即可确认）。'
  if (lastWrite.state === 'ok') return `\n最后一次写入：成功（${lastWrite.detail}）。`
  return `\n最后一次写入：失败（${lastWrite.detail}）。`
}
