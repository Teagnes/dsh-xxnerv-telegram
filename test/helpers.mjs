/**
 * Test doubles: a fake Telegram Bot API origin and a fake HTTP CONNECT proxy.
 * @module test/helpers
 */
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer, connect as netConnect } from 'node:net'

/**
 * Start a fake Telegram Bot API origin.
 * @param options - optional custom handler `(request) => { status, body }`.
 * @returns `{ url, calls, close }` where `calls` records every request.
 */
export async function startFakeTelegram(options = {}) {
  const calls = []
  const handler = options.handler ?? (() => ({ status: 200, body: { ok: true, result: { message_id: 42, date: 1_700_000_000, chat: { id: 7 } } } }))
  const server = createHttpServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const call = { method: request.method, url: request.url, headers: request.headers, raw, json: safeJson(raw) }
      calls.push(call)
      if (options.hang === true) return
      const { status = 200, body, text } = handler(call) ?? {}
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(text ?? JSON.stringify(body ?? { ok: true, result: {} }))
    })
  })
  await new Promise(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    close: () => new Promise(resolve => {
      // A hanging request (the timeout case) would otherwise keep `close` pending.
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

/**
 * Start a fake HTTP `CONNECT` proxy that forwards tunnels to their authority.
 * @param options - `auth` (required `Proxy-Authorization` value) and `deny` (always refuse).
 * @returns `{ url, connects, close }` where `connects` records every CONNECT head.
 */
export async function startFakeProxy(options = {}) {
  const connects = []
  const sockets = new Set()
  const server = createNetServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    const onData = chunk => {
      buffer += chunk.toString('latin1')
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeListener('data', onData)
      const head = buffer.slice(0, end)
      const [requestLine, ...headerLines] = head.split('\r\n')
      const authority = requestLine.split(' ')[1]
      const headers = Object.fromEntries(headerLines.map(line => {
        const colon = line.indexOf(':')
        return [line.slice(0, colon).toLowerCase().trim(), line.slice(colon + 1).trim()]
      }))
      connects.push({ requestLine, authority, headers })
      if (options.auth !== undefined && headers['proxy-authorization'] !== options.auth) {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
        return
      }
      if (options.deny === true) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      const [host, port] = authority.split(':')
      const upstream = netConnect(Number(port), host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        const rest = buffer.slice(end + 4)
        if (rest.length > 0) upstream.write(Buffer.from(rest, 'latin1'))
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
    }
    socket.on('data', onData)
    socket.on('error', () => {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    connects,
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

/** Parse JSON without throwing. */
function safeJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
