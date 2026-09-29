/**
 * Turn-end notification policy, kept free of harness imports so it can be unit
 * tested without a running runtime.
 *
 * The notifier folds `session/event` payloads into three facts — which sessions
 * a human prompted, which sessions are subagent children, and the latest title
 * per session — and pushes one Telegram message when a turn finishes.
 *
 * @module dsh-xxnerv-telegram/notify
 */
import { resolveChatId } from './config.js'
import { clampMessageText } from './telegram.js'

/** Turn-end reasons that are synthetic crash-repair/fork closers rather than finished work. */
export const SILENT_TURN_END_REASONS = new Set(['forked', 'interrupted'])

/**
 * The last assistant text in a session, used as notification content.
 * @param session - object exposing `deriveMessages()`, or anything else.
 * @returns the joined text blocks, or an empty string when none exist.
 */
export function lastAssistantText(session) {
  let messages
  try {
    messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : undefined
  } catch {
    return ''
  }
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const joined = blocks
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (joined !== '') return joined
  }
  return ''
}

/**
 * Compose the turn-end notification body.
 * @param options - session label, turn-end reason kind, and assistant text.
 * @returns the message text sent to Telegram.
 */
export function composeNotification({ label, reason, body }) {
  const lines = [`🤖 DSH 任务完成 · ${reason}`, `会话：${label}`]
  if (body !== '') lines.push('————', body)
  return lines.join('\n')
}

/**
 * Decide whether one `turn/end` should notify, and compose the payload.
 *
 * Pure: it reads the supplied state and returns a decision, leaving transport
 * to the caller.
 *
 * @param options - event facts, folded session state, and notification policy.
 * @returns `{ notify: false }` or `{ notify: true, chatId, text, label, reason }`.
 */
export function decideTurnEndNotification({ sessionId, reason, state, policy, text }) {
  const kind = String(reason ?? 'completed')
  if (SILENT_TURN_END_REASONS.has(kind)) return { notify: false, why: 'synthetic turn end' }
  if (state.subagentSessions.has(sessionId)) return { notify: false, why: 'subagent session' }
  if (policy.onlyHumanSessions && !state.humanSessions.has(sessionId)) return { notify: false, why: 'not a human-prompted session' }
  // The target may be read live: the chat id is an editable (volatile) config field.
  const chatId = resolveChatId(policy.chatId)
  if (chatId === '') return { notify: false, why: 'no chat id configured' }
  const label = state.titles.get(sessionId) ?? String(sessionId)
  const { text: body } = clampMessageText(text, policy.maxChars)
  return { notify: true, chatId, label, reason: kind, text: composeNotification({ label, reason: kind, body }) }
}

/**
 * Stateful fold over session events that pushes one notification per finished turn.
 *
 * Notifications are deliberately narrow: only sessions a human prompted
 * (`source.kind === 'user'`) and never subagent-backed sessions, so subagent and
 * agent-team traffic cannot become a notification storm. Overlapping pushes for
 * the same session are coalesced, and transport failures are reported through
 * the logger instead of breaking the event handler.
 */
export class TurnEndNotifier {
  /** Sessions prompted by a human client. */
  #humanSessions = new Set()
  /** Sessions established as subagent children. */
  #subagentSessions = new Set()
  /** Latest known session titles. */
  #titles = new Map()
  /** Sessions with a notification currently in flight. */
  #inFlight = new Set()

  /**
   * @param options - notification policy plus `send` and logging callbacks.
   * @param options.send - `(payload, context) => Promise<unknown>` Telegram transport.
   * @param options.chatId - default target chat id ('' disables notifications).
   * @param options.maxChars - assistant-text budget for the notification body.
   * @param options.onlyHumanSessions - skip sessions no human prompted.
   * @param options.logger - optional `{ info, warn }` sink.
   */
  constructor({ send, chatId = '', maxChars = 600, onlyHumanSessions = true, logger } = {}) {
    if (typeof send !== 'function') throw new TypeError('TurnEndNotifier requires a send function')
    this.policy = { send, chatId, maxChars, onlyHumanSessions }
    this.logger = logger
  }

  /**
   * Report a problem on the host log when a logger is present.
   * @param message - diagnostic text.
   */
  warn(message) {
    try {
      this.logger?.warn?.(`telegram: ${message}`)
    } catch {
      /* a failing logger must never break plugin activation or an event handler */
    }
  }

  /**
   * Fold one session event into notification state, and push on `turn/end`.
   * @param session - the session the event belongs to (needs only `id`).
   * @param event - the session event.
   */
  observe(session, event) {
    const sessionId = session?.id
    if (sessionId === undefined) return
    switch (event?.type) {
      case 'user/message':
        if (event.data?.source?.kind === 'user') this.#humanSessions.add(sessionId)
        return
      case 'subagent/descriptor':
        this.#subagentSessions.add(sessionId)
        return
      case 'session/title':
        if (typeof event.data?.title === 'string' && event.data.title !== '') this.#titles.set(sessionId, event.data.title)
        return
      case 'turn/end': {
        if (this.#inFlight.has(sessionId)) return
        const decision = decideTurnEndNotification({
          sessionId,
          reason: event.data?.reason?.kind,
          state: { humanSessions: this.#humanSessions, subagentSessions: this.#subagentSessions, titles: this.#titles },
          policy: this.policy,
          text: lastAssistantText(session),
        })
        if (!decision.notify) return
        this.#inFlight.add(sessionId)
        void this.#push(sessionId, decision).finally(() => this.#inFlight.delete(sessionId))
        return
      }
      default:
    }
  }

  /**
   * Await every notification already in flight. Exists for deterministic tests.
   * @returns a promise for the settled pushes.
   */
  async settled() {
    while (this.#inFlight.size > 0) await new Promise(resolve => setTimeout(resolve, 0))
  }

  /**
   * Send one composed notification.
   * @param sessionId - originating session id, for logging.
   * @param decision - the composed payload from {@link decideTurnEndNotification}.
   */
  async #push(sessionId, decision) {
    try {
      await this.policy.send({ chat_id: decision.chatId, text: decision.text }, { sessionId, reason: decision.reason })
      try {
        this.logger?.info?.(`telegram: notified chat ${decision.chatId} about a ${decision.reason} turn in ${sessionId}`)
      } catch {
        /* logging must not fail a completed notification */
      }
    } catch (error) {
      this.warn(`turn-end notification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
