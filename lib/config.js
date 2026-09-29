/**
 * Configuration plumbing shared by the plugin entry and its tools.
 *
 * A field declared with `.volatile()` reaches the plugin as a live reference
 * rather than a plain value, so every read goes through {@link configValue}.
 * Keeping these helpers pure lets the shell-free parts be unit tested.
 *
 * @module dsh-xxnerv-telegram/config
 */
import { DEFAULT_API_BASE } from './telegram.js'

/** Fallback settings namespace: the row id this bundle's patch declares. */
export const SETTINGS_NAMESPACE = 'xxnerv-telegram'

/**
 * Unwrap a possibly-volatile configuration reference.
 * @param raw - a plain value or a volatile reference exposing `get()`.
 * @returns the current value, or undefined when a reference cannot be read.
 */
export function configValue(raw) {
  if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      return raw.get()
    } catch {
      return undefined
    }
  }
  return raw
}

/**
 * Read a string field, treating unset and blank values alike.
 * @param raw - plain value or volatile reference.
 * @param fallback - value used when the field is empty.
 * @returns the trimmed string.
 */
export function configString(raw, fallback = '') {
  const value = configValue(raw)
  if (value === undefined || value === null) return fallback
  const text = String(value).trim()
  return text === '' ? fallback : text
}

/**
 * Read a numeric field, falling back when it is not a positive number.
 * @param raw - plain value or volatile reference.
 * @param fallback - value used when the field is unusable.
 * @returns a finite positive number.
 */
export function configNumber(raw, fallback) {
  const parsed = Number(configValue(raw))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Read a boolean field, falling back for anything that is not a boolean.
 * @param raw - plain value or volatile reference.
 * @param fallback - value used when the field is unset.
 * @returns the boolean value.
 */
export function configBoolean(raw, fallback) {
  const value = configValue(raw)
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Mask a secret for logs and tool output.
 * @param value - the secret, or undefined.
 * @returns a presence summary that never discloses the whole secret.
 */
export function maskSecret(value) {
  const secret = value === undefined || value === null ? '' : String(value)
  if (secret === '') return '(未设置)'
  if (secret.length <= 8) return `(已设置，${secret.length} 字符)`
  return `${secret.slice(0, 4)}…${secret.slice(-4)}（已设置，${secret.length} 字符）`
}

/**
 * Translate `xxnerv_telegram_config` arguments into a settings patch.
 *
 * Only fields the caller actually supplied are included, so a write never
 * clears an unrelated value.
 *
 * @param args - tool arguments.
 * @returns the patch for `ctx.settings.update`.
 */
export function buildConfigPatch(args = {}) {
  const patch = {}
  if (args.bot_token !== undefined) patch.botToken = String(args.bot_token).trim()
  if (args.default_chat_id !== undefined) patch.defaultChatId = String(args.default_chat_id).trim()
  if (args.notify_chat_id !== undefined) patch.notifyChatId = String(args.notify_chat_id).trim()
  if (args.proxy_url !== undefined) patch.proxyUrl = String(args.proxy_url).trim()
  if (args.notify_on_turn_end !== undefined) patch.notifyOnTurnEnd = args.notify_on_turn_end === true
  return patch
}

/**
 * Human-readable field names for the patch a caller requested.
 * @param patch - the patch from {@link buildConfigPatch}.
 * @returns the changed field names.
 */
export function patchFieldNames(patch) {
  return Object.keys(patch)
}

/**
 * Resolve a chat id that may be static or read live.
 * @param value - a string, or a function returning the current string.
 * @returns the trimmed chat id, or an empty string.
 */
export function resolveChatId(value) {
  const resolved = typeof value === 'function' ? value() : value
  if (resolved === undefined || resolved === null) return ''
  return String(resolved).trim()
}

/** Every configuration field this plugin declares, with its live accessor. */
export function readEffectiveConfig(config) {
  return {
    botToken: configString(config.botToken),
    defaultChatId: configString(config.defaultChatId),
    notifyChatId: configString(config.notifyChatId, configString(config.defaultChatId)),
    proxyUrl: configString(config.proxyUrl),
    apiBase: configString(config.apiBase, DEFAULT_API_BASE),
    timeoutMs: configNumber(config.timeoutMs, 15_000),
    notifyOnTurnEnd: configBoolean(config.notifyOnTurnEnd, false),
    notifyMaxChars: configNumber(config.notifyMaxChars, 600),
    notifyOnlyHumanSessions: configBoolean(config.notifyOnlyHumanSessions, true),
  }
}
