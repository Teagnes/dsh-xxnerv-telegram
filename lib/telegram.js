/**
 * Dependency-free Telegram Bot API client with optional HTTP CONNECT proxy support.
 *
 * The DSH host runs plain Node, whose global `fetch` ignores the macOS system
 * proxy. Networks that cannot reach `api.telegram.org` directly therefore need
 * an explicit proxy; this module implements the `CONNECT` tunnel with node
 * builtins only (`node:net` / `node:tls` / `node:http` / `node:https`), so the
 * plugin has no runtime dependencies and no global side effects.
 *
 * @module dsh-xxnerv-telegram/telegram
 */
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/** Telegram Bot API origin used unless `apiBase` overrides it. */
export const DEFAULT_API_BASE = 'https://api.telegram.org'

/** Telegram's hard limit for one `sendMessage` text payload. */
export const MAX_MESSAGE_CHARS = 4096

/**
 * Failure raised for transport faults, non-2xx responses, and Bot API `ok: false` replies.
 * `details.description` carries Telegram's own `description` when the API answered.
 */
export class TelegramError extends Error {
  /**
   * @param message - operator-facing failure summary.
   * @param details - optional structured context (`status`, `description`, `method`, `cause`).
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'TelegramError'
    this.status = details.status
    this.description = details.description
    this.method = details.method
  }
}

/**
 * Join an API base with a Bot API method path, tolerating a trailing slash.
 * @param apiBase - configured origin (`https://api.telegram.org` by default).
 * @param token - bot token.
 * @param method - Bot API method name (`sendMessage`, `getMe`, `getUpdates`, ...).
 * @returns the absolute request URL.
 */
export function botApiUrl(apiBase, token, method) {
  const base = String(apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  return `${base}/bot${token}/${method}`
}

/**
 * Normalize a configured proxy string into an absolute URL.
 * @param proxyUrl - `http://host:port` (credentials allowed), or empty for direct access.
 * @returns the parsed proxy URL, or `undefined` when no proxy is configured.
 * @throws {TelegramError} when the value is not a usable http(s) proxy URL.
 */
export function parseProxyUrl(proxyUrl) {
  if (proxyUrl === undefined || proxyUrl === null || String(proxyUrl).trim() === '') return undefined
  const raw = String(proxyUrl).trim()
  const candidate = raw.includes('://') ? raw : `http://${raw}`
  let parsed
  try {
    parsed = new URL(candidate)
  } catch (error) {
    throw new TelegramError(`invalid proxy URL ${JSON.stringify(proxyUrl)}`, { cause: error })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TelegramError(`unsupported proxy protocol ${JSON.stringify(parsed.protocol)}; use http:// or https:// (a SOCKS-only proxy is not supported)`)
  }
  if (parsed.hostname === '') throw new TelegramError(`invalid proxy URL ${JSON.stringify(proxyUrl)}: missing host`)
  return parsed
}

/** Default port for a proxy URL that omits one. */
function proxyPort(proxy) {
  if (proxy.port !== '') return Number(proxy.port)
  return proxy.protocol === 'https:' ? 443 : 80
}

/** `Proxy-Authorization` header value for a proxy URL carrying credentials, or `undefined`. */
function proxyAuthHeader(proxy) {
  if (proxy.username === '' && proxy.password === '') return undefined
  const user = decodeURIComponent(proxy.username)
  const pass = decodeURIComponent(proxy.password)
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

/**
 * Open a raw TCP tunnel to `host:port` through an HTTP `CONNECT` proxy.
 * @param options - proxy URL, target host/port, timeout, and an optional abort signal.
 * @returns the connected socket, positioned after the proxy's response head.
 * @throws {TelegramError} on proxy refusal, timeout, or abort.
 */
export function openTunnel({ proxyUrl, host, port, timeoutMs, signal }) {
  const proxy = parseProxyUrl(proxyUrl)
  if (proxy === undefined) throw new TelegramError('openTunnel requires a proxy URL')
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = netConnect({ host: proxy.hostname, port: proxyPort(proxy) })
    let buffer = Buffer.alloc(0)
    const fail = error => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(error instanceof TelegramError ? error : new TelegramError(`proxy ${proxy.host}:${proxyPort(proxy)} connection failed: ${error.message}`, { cause: error }))
    }
    const onAbort = () => fail(new TelegramError('telegram request aborted before the proxy tunnel was established'))
    const cleanup = () => {
      socket.setTimeout(0)
      socket.removeListener('connect', onConnect)
      socket.removeListener('data', onData)
      socket.removeListener('error', fail)
      socket.removeListener('timeout', onTimeout)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
    const onTimeout = () => fail(new TelegramError(`proxy CONNECT to ${host}:${port} timed out after ${timeoutMs}ms`))
    const onConnect = () => {
      const auth = proxyAuthHeader(proxy)
      const head = [
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        ...(auth === undefined ? [] : [`Proxy-Authorization: ${auth}`]),
        'Proxy-Connection: keep-alive',
        '',
        '',
      ].join('\r\n')
      socket.write(head)
    }
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buffer.length > 16384) fail(new TelegramError('proxy CONNECT response head exceeded 16 KiB'))
        return
      }
      const head = buffer.subarray(0, end).toString('latin1')
      const status = Number(head.split(' ')[1])
      if (status !== 200) {
        fail(new TelegramError(`proxy CONNECT to ${host}:${port} refused: ${head.split('\r\n')[0]}`, { status }))
        return
      }
      settled = true
      cleanup()
      const rest = buffer.subarray(end + 4)
      if (rest.length > 0) socket.unshift(rest)
      resolve(socket)
    }
    socket.setTimeout(timeoutMs, onTimeout)
    socket.once('connect', onConnect)
    socket.on('data', onData)
    socket.once('error', fail)
    if (signal !== undefined) {
      if (signal.aborted) {
        fail(new TelegramError('telegram request aborted before the proxy tunnel was established'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Upgrade an established tunnel (or a bare socket) to TLS for an https target.
 * @param socket - socket carrying the CONNECT tunnel.
 * @param host - target hostname; also the SNI server name.
 * @param timeoutMs - handshake deadline.
 * @returns the TLS socket after a successful handshake.
 */
function tlsOverSocket(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, servername: host })
    const onTimeout = () => {
      secure.destroy()
      reject(new TelegramError(`TLS handshake with ${host} timed out after ${timeoutMs}ms`))
    }
    secure.setTimeout(timeoutMs, onTimeout)
    secure.once('secureConnect', () => {
      secure.setTimeout(0)
      secure.removeListener('timeout', onTimeout)
      resolve(secure)
    })
    secure.once('error', error => {
      secure.setTimeout(0)
      reject(new TelegramError(`TLS handshake with ${host} failed: ${error.message}`, { cause: error }))
    })
  })
}

/**
 * Decode an HTTP/1.1 chunked body.
 * @param buffer - body bytes after the header block.
 * @returns the decoded payload.
 */
function decodeChunked(buffer) {
  const parts = []
  let offset = 0
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', offset)
    if (lineEnd === -1) break
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString('latin1').split(';')[0], 16)
    if (!Number.isFinite(size) || size < 0) break
    offset = lineEnd + 2
    if (size === 0) break
    parts.push(buffer.subarray(offset, offset + size))
    offset += size + 2
  }
  return Buffer.concat(parts)
}

/**
 * Parse a complete HTTP/1.1 response held in one buffer.
 * @param buffer - every byte the server sent.
 * @returns the status code and decoded body text.
 * @throws {TelegramError} when the header block is missing.
 */
export function parseHttpResponse(buffer) {
  const headEnd = buffer.indexOf('\r\n\r\n')
  if (headEnd === -1) throw new TelegramError('telegram response had no HTTP header block')
  const [statusLine, ...headerLines] = buffer.subarray(0, headEnd).toString('latin1').split('\r\n')
  const status = Number(statusLine.split(' ')[1])
  const headers = {}
  for (const line of headerLines) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  let body = buffer.subarray(headEnd + 4)
  if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) body = decodeChunked(body)
  else if (headers['content-length'] !== undefined) body = body.subarray(0, Number(headers['content-length']))
  return { status: Number.isFinite(status) ? status : 0, text: body.toString('utf8') }
}

/**
 * Perform one HTTP/1.1 exchange over an already-connected socket.
 *
 * The request is written and the response read directly instead of delegating to
 * `http(s).request` with a hand-made agent: a TLS socket that is already secure
 * does not satisfy Node's agent connection bookkeeping, which stalls the request.
 * `connection: close` means the response body ends at EOF; `content-length` and
 * chunked framing are both honored.
 *
 * @param options - target URL, method, headers, payload, timeout, and the socket to use.
 * @returns the status code and decoded response body.
 */
function exchangeOverSocket({ target, method, headers, payload, timeoutMs, socket }) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      try {
        resolve(parseHttpResponse(Buffer.concat(chunks)))
      } catch (error) {
        reject(error)
      }
    }
    const fail = error => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(error instanceof TelegramError ? error : new TelegramError(`telegram request failed: ${error.message}`, { cause: error }))
    }
    const onData = chunk => chunks.push(chunk)
    const onEnd = () => finish()
    const onClose = () => {
      if (chunks.length === 0) fail(new TelegramError('telegram connection closed before any response arrived'))
      else finish()
    }
    const timer = setTimeout(() => fail(new TelegramError(`telegram request timed out after ${timeoutMs}ms`)), timeoutMs)
    function cleanup() {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('end', onEnd)
      socket.removeListener('close', onClose)
      socket.removeListener('error', fail)
    }
    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.once('close', onClose)
    socket.once('error', fail)
    const headerLines = [
      `${method} ${`${target.pathname}${target.search}`} HTTP/1.1`,
      `host: ${target.host}`,
      'connection: close',
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      '',
      '',
    ].join('\r\n')
    socket.write(headerLines)
    if (payload !== undefined) socket.write(payload)
  })
}

/**
 * Perform one HTTP exchange, directly or through an HTTP CONNECT proxy.
 * @param options - absolute URL, HTTP method, headers, body, timeout, proxy URL, abort signal.
 * @returns the status code and response text.
 * @throws {TelegramError} on transport timeout, abort, or network failure.
 */
export async function httpExchange({ url, method = 'POST', headers = {}, body, timeoutMs = 15000, proxyUrl, signal }) {
  const target = new URL(url)
  const proxy = parseProxyUrl(proxyUrl)
  if (proxy === undefined) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new TelegramError(`telegram request timed out after ${timeoutMs}ms`)), timeoutMs)
    const onAbort = () => controller.abort(signal?.reason)
    if (signal !== undefined) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'follow' })
      return { status: response.status, text: await response.text() }
    } catch (error) {
      if (error instanceof TelegramError) throw error
      if (controller.signal.aborted) {
        const reason = signal?.aborted === true
          ? 'telegram request aborted'
          : `telegram request timed out after ${timeoutMs}ms. If this network blocks Telegram, set the plugin's proxyUrl (for example http://127.0.0.1:7897).`
        throw new TelegramError(reason, { cause: error })
      }
      throw new TelegramError(`cannot reach ${target.host}: ${error.message}. If this network blocks Telegram, set the plugin's proxyUrl (for example http://127.0.0.1:7897).`, { cause: error })
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }
  const host = target.hostname
  const port = target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port)
  const tunnel = await openTunnel({ proxyUrl: proxy.href, host, port, timeoutMs, signal })
  const socket = target.protocol === 'https:' ? await tlsOverSocket(tunnel, host, timeoutMs) : tunnel
  return await exchangeOverSocket({ target, method, headers, payload: body, timeoutMs, socket })
}

/**
 * Call one Bot API method and unwrap its `result`.
 * @param options - token, method, request body, and transport settings.
 * @returns the method's `result` payload.
 * @throws {TelegramError} when Telegram answers `ok: false` or the reply is not JSON.
 */
export async function callBotApi({ token, method, body, apiBase = DEFAULT_API_BASE, proxyUrl, timeoutMs = 15000, signal }) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new TelegramError('telegram botToken is not configured: set `botToken` on the telegram plugin row in the profile cordis.patch.yml', { method })
  }
  const payload = JSON.stringify(body ?? {})
  const { status, text } = await httpExchange({
    url: botApiUrl(apiBase, token.trim(), method),
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    body: payload,
    timeoutMs,
    proxyUrl,
    signal,
  })
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new TelegramError(`telegram ${method} returned non-JSON (HTTP ${status}): ${text.slice(0, 200)}`, { status, method, cause: error })
  }
  if (parsed?.ok !== true) {
    const description = typeof parsed?.description === 'string' ? parsed.description : text.slice(0, 200)
    throw new TelegramError(`telegram ${method} failed (HTTP ${status}): ${description}`, { status, method, description })
  }
  return parsed.result
}

/**
 * Truncate message text to Telegram's per-message limit.
 * @param text - raw message text.
 * @param maxChars - effective limit (defaults to Telegram's 4096).
 * @returns the text to send, plus whether truncation happened.
 */
export function clampMessageText(text, maxChars = MAX_MESSAGE_CHARS) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : MAX_MESSAGE_CHARS
  if (value.length <= limit) return { text: value, truncated: false }
  const marker = '…[truncated]'
  return { text: `${value.slice(0, Math.max(0, limit - marker.length))}${marker}`, truncated: true }
}
