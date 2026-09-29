/**
 * Client tests: direct transport, HTTP CONNECT proxy transport, Bot API error
 * mapping, timeouts, and text clamping. No harness packages are imported.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  DEFAULT_API_BASE,
  MAX_MESSAGE_CHARS,
  TelegramError,
  botApiUrl,
  callBotApi,
  clampMessageText,
  httpExchange,
  parseProxyUrl,
} from '../lib/telegram.js'
import { startFakeProxy, startFakeTelegram } from './helpers.mjs'

describe('botApiUrl', () => {
  it('builds method URLs and tolerates a trailing slash on the base', () => {
    assert.equal(botApiUrl(DEFAULT_API_BASE, 'T', 'sendMessage'), 'https://api.telegram.org/botT/sendMessage')
    assert.equal(botApiUrl('https://example.test/', 'T', 'getMe'), 'https://example.test/botT/getMe')
  })
})

describe('parseProxyUrl', () => {
  it('accepts http, https, and bare host:port forms', () => {
    assert.equal(parseProxyUrl('http://127.0.0.1:7897').port, '7897')
    assert.equal(parseProxyUrl('127.0.0.1:7897').hostname, '127.0.0.1')
    assert.equal(parseProxyUrl('https://proxy.test').protocol, 'https:')
  })

  it('treats empty values as no proxy', () => {
    assert.equal(parseProxyUrl(''), undefined)
    assert.equal(parseProxyUrl('   '), undefined)
    assert.equal(parseProxyUrl(undefined), undefined)
  })

  it('rejects unsupported protocols with an actionable message', () => {
    assert.throws(() => parseProxyUrl('socks5://127.0.0.1:1080'), error => {
      assert.ok(error instanceof TelegramError)
      assert.match(error.message, /unsupported proxy protocol/)
      assert.match(error.message, /SOCKS/)
      return true
    })
  })
})

describe('clampMessageText', () => {
  it('leaves short text untouched', () => {
    assert.deepEqual(clampMessageText('hi'), { text: 'hi', truncated: false })
  })

  it('truncates over-long text within the limit and marks it', () => {
    const { text, truncated } = clampMessageText('x'.repeat(MAX_MESSAGE_CHARS + 100))
    assert.equal(truncated, true)
    assert.ok(text.length <= MAX_MESSAGE_CHARS)
    assert.match(text, /\[truncated\]$/)
  })
})

describe('callBotApi without a proxy', () => {
  /** @type {Awaited<ReturnType<typeof startFakeTelegram>>} */
  let telegram
  before(async () => { telegram = await startFakeTelegram() })
  after(async () => { await telegram.close() })

  it('posts JSON to the method URL and unwraps result', async () => {
    const result = await callBotApi({
      token: 'TOKEN',
      method: 'sendMessage',
      body: { chat_id: '7', text: 'hello' },
      apiBase: telegram.url,
    })
    assert.equal(result.message_id, 42)
    const [call] = telegram.calls
    assert.equal(call.method, 'POST')
    assert.equal(call.url, '/botTOKEN/sendMessage')
    assert.equal(call.headers['content-type'], 'application/json')
    assert.deepEqual(call.json, { chat_id: '7', text: 'hello' })
  })

  it('maps ok:false replies to TelegramError carrying the description', async () => {
    const failing = await startFakeTelegram({
      handler: () => ({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } }),
    })
    try {
      await assert.rejects(
        callBotApi({ token: 'T', method: 'sendMessage', body: {}, apiBase: failing.url }),
        error => {
          assert.ok(error instanceof TelegramError)
          assert.equal(error.status, 400)
          assert.equal(error.description, 'Bad Request: chat not found')
          assert.match(error.message, /chat not found/)
          return true
        },
      )
    } finally {
      await failing.close()
    }
  })

  it('reports a non-JSON body instead of crashing', async () => {
    const broken = await startFakeTelegram({ handler: () => ({ status: 502, text: '<html>bad gateway</html>' }) })
    try {
      await assert.rejects(
        callBotApi({ token: 'T', method: 'getMe', body: {}, apiBase: broken.url }),
        error => {
          assert.ok(error instanceof TelegramError)
          assert.match(error.message, /non-JSON \(HTTP 502\)/)
          return true
        },
      )
    } finally {
      await broken.close()
    }
  })

  it('refuses to call without a token', async () => {
    await assert.rejects(callBotApi({ token: '  ', method: 'getMe', body: {}, apiBase: telegram.url }), /botToken is not configured/)
  })

  it('times out instead of hanging', async () => {
    const hanging = await startFakeTelegram({ hang: true })
    try {
      await assert.rejects(
        callBotApi({ token: 'T', method: 'getMe', body: {}, apiBase: hanging.url, timeoutMs: 150 }),
        error => {
          assert.ok(error instanceof TelegramError)
          assert.match(error.message, /timed out after 150ms/)
          return true
        },
      )
    } finally {
      await hanging.close()
    }
  })

  it('explains the proxy remedy when the host is unreachable', async () => {
    const closed = await startFakeTelegram()
    const deadUrl = closed.url
    await closed.close()
    await assert.rejects(
      callBotApi({ token: 'T', method: 'getMe', body: {}, apiBase: deadUrl, timeoutMs: 1000 }),
      error => {
        assert.ok(error instanceof TelegramError)
        assert.match(error.message, /cannot reach 127\.0\.0\.1/)
        assert.match(error.message, /proxyUrl/)
        return true
      },
    )
  })

  it('honours an aborted caller signal', async () => {
    const hanging = await startFakeTelegram({ hang: true })
    try {
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        callBotApi({ token: 'T', method: 'getMe', body: {}, apiBase: hanging.url, signal: controller.signal, timeoutMs: 5000 }),
        /aborted/,
      )
    } finally {
      await hanging.close()
    }
  })
})

describe('callBotApi through an HTTP CONNECT proxy', () => {
  it('tunnels the request to the origin', async () => {
    const telegram = await startFakeTelegram()
    const proxy = await startFakeProxy()
    try {
      const result = await callBotApi({
        token: 'T',
        method: 'sendMessage',
        body: { chat_id: '9', text: 'via proxy' },
        apiBase: telegram.url,
        proxyUrl: proxy.url,
      })
      assert.equal(result.message_id, 42)
      assert.equal(proxy.connects.length, 1)
      assert.equal(proxy.connects[0].authority, `127.0.0.1:${telegram.port}`)
      assert.deepEqual(telegram.calls[0].json, { chat_id: '9', text: 'via proxy' })
    } finally {
      await proxy.close()
      await telegram.close()
    }
  })

  it('sends Proxy-Authorization for a proxy URL with credentials', async () => {
    const telegram = await startFakeTelegram()
    const expected = `Basic ${Buffer.from('user:secret').toString('base64')}`
    const proxy = await startFakeProxy({ auth: expected })
    try {
      await callBotApi({ token: 'T', method: 'getMe', body: {}, apiBase: telegram.url, proxyUrl: `http://user:secret@127.0.0.1:${proxy.port}` })
      assert.equal(proxy.connects.length, 1)
      assert.equal(proxy.connects[0].headers['proxy-authorization'], expected)
    } finally {
      await proxy.close()
      await telegram.close()
    }
  })

  it('surfaces a refused CONNECT', async () => {
    const telegram = await startFakeTelegram()
    const proxy = await startFakeProxy({ deny: true })
    try {
      await assert.rejects(
        callBotApi({ token: 'T', method: 'getMe', body: {}, apiBase: telegram.url, proxyUrl: proxy.url }),
        error => {
          assert.ok(error instanceof TelegramError)
          assert.match(error.message, /proxy CONNECT .* refused: HTTP\/1\.1 403 Forbidden/)
          return true
        },
      )
    } finally {
      await proxy.close()
      await telegram.close()
    }
  })

  it('fails with a clear error when the proxy is not listening', async () => {
    const telegram = await startFakeTelegram()
    const proxy = await startFakeProxy()
    const deadProxyUrl = proxy.url
    await proxy.close()
    try {
      await assert.rejects(
        callBotApi({ token: 'T', method: 'getMe', body: {}, apiBase: telegram.url, proxyUrl: deadProxyUrl, timeoutMs: 1000 }),
        error => {
          assert.ok(error instanceof TelegramError)
          assert.match(error.message, /connection failed/)
          return true
        },
      )
    } finally {
      await telegram.close()
    }
  })
})

describe('httpExchange', () => {
  it('returns the raw status and body', async () => {
    const telegram = await startFakeTelegram({ handler: () => ({ status: 418, text: 'teapot' }) })
    try {
      const response = await httpExchange({ url: `${telegram.url}/anything`, method: 'GET' })
      assert.equal(response.status, 418)
      assert.equal(response.text, 'teapot')
    } finally {
      await telegram.close()
    }
  })
})
