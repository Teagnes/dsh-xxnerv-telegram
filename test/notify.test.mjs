/**
 * Notification policy tests: which sessions notify, what the message contains,
 * truncation, coalescing, and failure handling. No harness packages imported.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TurnEndNotifier, composeNotification, decideTurnEndNotification, lastAssistantText } from '../lib/notify.js'

/** Build the folded state a decision reads. */
function state({ human = [], subagent = [], titles = {} } = {}) {
  return {
    humanSessions: new Set(human),
    subagentSessions: new Set(subagent),
    titles: new Map(Object.entries(titles)),
  }
}

/** A fake session whose derived history is the supplied messages. */
function session(id, messages = []) {
  return { id, deriveMessages: () => messages, snapshotEvents: () => [] }
}

describe('lastAssistantText', () => {
  it('returns the last assistant text blocks', () => {
    assert.equal(lastAssistantText(session('s', [
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'older' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'line 1' }, { type: 'text', text: 'line 2' }] },
    ])), 'line 1\nline 2')
  })

  it('ignores non-text blocks and skips a textless assistant message', () => {
    assert.equal(lastAssistantText(session('s', [
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'bash' }] },
    ])), 'answer')
  })

  it('degrades gracefully on missing, throwing, or malformed history', () => {
    assert.equal(lastAssistantText({ id: 's' }), '')
    assert.equal(lastAssistantText({ id: 's', deriveMessages: () => { throw new Error('disposed') } }), '')
    assert.equal(lastAssistantText({ id: 's', deriveMessages: () => null }), '')
    assert.equal(lastAssistantText(undefined), '')
  })
})

describe('composeNotification', () => {
  it('includes the reason, session label, and body', () => {
    const text = composeNotification({ label: 'Fix the build', reason: 'completed', body: 'Done.' })
    assert.match(text, /🤖 DSH 任务完成 · completed/)
    assert.match(text, /会话：Fix the build/)
    assert.match(text, /Done\./)
  })

  it('omits the separator when there is no body', () => {
    const text = composeNotification({ label: 's1', reason: 'blocked', body: '' })
    assert.ok(!text.includes('————'))
  })
})

describe('decideTurnEndNotification', () => {
  const policy = { chatId: '5', maxChars: 600, onlyHumanSessions: true }

  it('notifies a human-prompted session', () => {
    const decision = decideTurnEndNotification({
      sessionId: 's1',
      reason: 'completed',
      state: state({ human: ['s1'], titles: { s1: 'Task' } }),
      policy,
      text: 'all done',
    })
    assert.equal(decision.notify, true)
    assert.equal(decision.chatId, '5')
    assert.match(decision.text, /Task/)
    assert.match(decision.text, /all done/)
  })

  it('skips sessions no human prompted', () => {
    const decision = decideTurnEndNotification({ sessionId: 's2', reason: 'completed', state: state({ human: ['s1'] }), policy, text: 'x' })
    assert.equal(decision.notify, false)
    assert.match(decision.why, /human-prompted/)
  })

  it('skips subagent-backed sessions even when a human prompted them', () => {
    const decision = decideTurnEndNotification({
      sessionId: 's1',
      reason: 'completed',
      state: state({ human: ['s1'], subagent: ['s1'] }),
      policy,
      text: 'x',
    })
    assert.equal(decision.notify, false)
    assert.match(decision.why, /subagent/)
  })

  it('skips synthetic crash-repair and fork closers', () => {
    for (const reason of ['forked', 'interrupted']) {
      const decision = decideTurnEndNotification({ sessionId: 's1', reason, state: state({ human: ['s1'] }), policy, text: 'x' })
      assert.equal(decision.notify, false, reason)
      assert.match(decision.why, /synthetic/)
    }
  })

  it('skips when no chat id is configured', () => {
    const decision = decideTurnEndNotification({
      sessionId: 's1',
      reason: 'completed',
      state: state({ human: ['s1'] }),
      policy: { ...policy, chatId: '' },
      text: 'x',
    })
    assert.equal(decision.notify, false)
    assert.match(decision.why, /chat id/)
  })

  it('allows any session when onlyHumanSessions is false', () => {
    const decision = decideTurnEndNotification({
      sessionId: 's9',
      reason: 'error',
      state: state(),
      policy: { ...policy, onlyHumanSessions: false },
      text: 'boom',
    })
    assert.equal(decision.notify, true)
    assert.match(decision.text, /error/)
    assert.match(decision.text, /s9/)
  })

  it('truncates the body to the configured budget', () => {
    const decision = decideTurnEndNotification({
      sessionId: 's1',
      reason: 'completed',
      state: state({ human: ['s1'] }),
      policy: { ...policy, maxChars: 40 },
      text: 'y'.repeat(500),
    })
    assert.equal(decision.notify, true)
    assert.ok(decision.text.length < 200)
    assert.match(decision.text, /\[truncated\]/)
  })
})

describe('TurnEndNotifier', () => {
  /** Collect sends and logger calls for one notifier. */
  function harness(options = {}) {
    const sent = []
    const logs = { info: [], warn: [] }
    const notifier = new TurnEndNotifier({
      send: async (payload, context) => {
        sent.push({ payload, context })
        if (options.failSend === true) throw new Error('telegram unreachable')
      },
      chatId: '77',
      maxChars: 600,
      onlyHumanSessions: options.onlyHumanSessions ?? true,
      logger: { info: message => logs.info.push(message), warn: message => logs.warn.push(message) },
    })
    return { notifier, sent, logs }
  }

  const userEvent = { type: 'user/message', data: { source: { kind: 'user' } } }
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }

  it('sends once per finished turn of a human-prompted session', async () => {
    const { notifier, sent } = harness()
    const s = session('s1', [{ role: 'assistant', content: [{ type: 'text', text: '任务完成' }] }])
    notifier.observe(s, userEvent)
    notifier.observe(s, { type: 'session/title', data: { title: 'Build' } })
    notifier.observe(s, turnEnd)
    await notifier.settled()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].payload.chat_id, '77')
    assert.match(sent[0].payload.text, /Build/)
    assert.match(sent[0].payload.text, /任务完成/)
  })

  it('ignores turns of sessions with no human prompt', async () => {
    const { notifier, sent } = harness()
    notifier.observe(session('s2', []), { type: 'user/message', data: { source: { kind: 'cron' } } })
    notifier.observe(session('s2', []), turnEnd)
    await notifier.settled()
    assert.equal(sent.length, 0)
  })

  it('ignores sessions that established themselves as subagents', async () => {
    const { notifier, sent } = harness()
    const s = session('s3', [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }])
    notifier.observe(s, userEvent)
    notifier.observe(s, { type: 'subagent/descriptor', data: {} })
    notifier.observe(s, turnEnd)
    await notifier.settled()
    assert.equal(sent.length, 0)
  })

  it('reports transport failures through the logger without throwing', async () => {
    const { notifier, sent, logs } = harness({ failSend: true })
    const s = session('s4', [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }])
    notifier.observe(s, userEvent)
    notifier.observe(s, turnEnd)
    await notifier.settled()
    assert.equal(sent.length, 1)
    assert.equal(logs.warn.length, 1)
    assert.match(logs.warn[0], /turn-end notification failed: telegram unreachable/)
  })

  it('does not send overlapping notifications for one session', async () => {
    const sent = []
    let release
    const gate = new Promise(resolve => { release = resolve })
    const notifier = new TurnEndNotifier({
      send: async payload => { sent.push(payload); await gate },
      chatId: '77',
    })
    const s = session('s5', [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }])
    notifier.observe(s, userEvent)
    notifier.observe(s, turnEnd)
    notifier.observe(s, turnEnd)
    assert.equal(sent.length, 1)
    release()
    await notifier.settled()
    assert.equal(sent.length, 1)
  })

  it('requires a send function', () => {
    assert.throws(() => new TurnEndNotifier({}), /requires a send function/)
  })

  it('ignores events without a usable session id', async () => {
    const { notifier, sent } = harness()
    notifier.observe({}, userEvent)
    notifier.observe(undefined, turnEnd)
    await notifier.settled()
    assert.equal(sent.length, 0)
  })
})
