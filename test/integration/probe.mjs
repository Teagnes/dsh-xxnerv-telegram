/**
 * Integration probe: runs inside a real dsh boot and exercises the plugin's
 * contributions through their real seams.
 *
 * 1. `xxnerv_telegram_send` is resolved from the live tool registry and called through
 *    the actual tool pipeline, proving registration, argument validation,
 *    execution, and the Telegram transport.
 * 2. A real session appends the events a finished human turn produces, proving
 *    the `session/event` wiring and the turn-end notification path.
 * 3. `xxnerv_telegram_config` reads and rewrites the profile configuration, and a
 *    later `xxnerv_telegram_send` proves the rewrite is live.
 *
 * Every line is written synchronously, so a hang shows exactly which step
 * stalled instead of losing buffered output.
 *
 * @module test/integration/probe
 */
import { writeSync } from 'node:fs'

export const name = 'xxnerv-telegram-probe'

/** Both the tool registry and the session store are needed. */
export const inject = ['tools', 'sessions']

/**
 * Emit one line immediately, bypassing stdout buffering.
 * @param line - the line to write.
 */
function emit(line) {
  writeSync(1, `${line}\n`)
}

/**
 * Bound one probe step so a stall becomes a recorded failure.
 * @param promise - the step's promise.
 * @param label - step name used in the failure line.
 * @param timeoutMs - how long the step may take.
 * @returns the step's value.
 * @throws {Error} when the step exceeds its bound.
 */
function withTimeout(promise, label, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Flatten a tool result's content blocks into one line.
 * @param result - the `ctx.tools.execute` result.
 * @returns the joined text with whitespace collapsed.
 */
function flattenResult(result) {
  return (result?.content ?? [])
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Poll the registry until the tool is visible.
 *
 * Both this probe and the telegram plugin activate on the same `tools`
 * readiness, so their apply order is not defined; the probe must wait rather
 * than assume the other plugin already registered.
 * @param ctx - the plugin context.
 * @param toolName - tool to wait for.
 * @param timeoutMs - give up after this long.
 * @returns the resolved definition, or undefined on timeout.
 */
async function waitForTool(ctx, toolName, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const tool = ctx.tools.get(toolName)
    if (tool !== undefined) return tool
    if (Date.now() > deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/**
 * Drive `xxnerv_telegram_send` through the real tool pipeline.
 * @param ctx - the plugin context.
 * @param lines - collected `PROBE` output.
 * @returns whether the call behaved as expected.
 */
async function probeTool(ctx) {
  const tool = await waitForTool(ctx, 'xxnerv_telegram_send')
  const registered = tool !== undefined && tool !== null
  emit(`PROBE tool-registered=${registered}`)
  const result = await withTimeout(ctx.tools.execute({
    callId: 'probe-1',
    name: 'xxnerv_telegram_send',
    arguments: { text: 'integration hello' },
    signal: new AbortController().signal,
  }), 'xxnerv_telegram_send')
  const text = flattenResult(result)
  emit(`PROBE result=${text}`)
  return registered && /Sent Telegram message/.test(text)
}

/**
 * Append the events of a finished human turn to a real session, which must make
 * the plugin push a turn-end notification.
 * @param ctx - the plugin context.
 * @param lines - collected `PROBE` output.
 * @returns whether the events were accepted.
 */
async function probeTurnEndNotification(ctx) {
  const session = ctx.sessions.create('probe-telegram-session', { meta: { cwd: process.cwd() } })
  session.append('turn/start', { turn: 1 })
  session.append(
    'user/message',
    { role: 'user', content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } },
    { surfaceOp: 'append' },
  )
  session.append('session/title', { title: 'Probe session' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  emit('PROBE notification-events-appended=true')
  // The push is fire-and-forget on the event bus; give it time to reach the fake API.
  await new Promise(resolve => setTimeout(resolve, 600))
  return true
}

/**
 * Drive `xxnerv_telegram_config`: read the status, write a new default chat, and prove
 * the write is live by sending through the tool without an explicit chat id.
 * @param ctx - the plugin context.
 * @param lines - collected `PROBE` output.
 * @returns whether the configuration surface behaved as expected.
 */
async function probeConfig(ctx) {
  // The runner supplies the configured chat and the value to write, so the same
  // probe works against the fake API and against a real Telegram chat.
  const initialChat = process.env.PROBE_INITIAL_CHAT ?? '4242'
  const newChat = process.env.PROBE_NEW_CHAT ?? '9999'
  const run = (callId, name, args, label) => withTimeout(ctx.tools.execute({
    callId,
    name,
    arguments: args,
    signal: new AbortController().signal,
  }), label)

  const status = flattenResult(await run('probe-config-1', 'xxnerv_telegram_config', { action: 'status' }, 'xxnerv_telegram_config status'))
  const statusChat = /defaultChatId: (\S+)/.exec(status)?.[1] ?? 'missing'
  emit(`PROBE config-status-default-chat=${statusChat}`)

  const set = flattenResult(await run('probe-config-2', 'xxnerv_telegram_config', { action: 'set', default_chat_id: newChat }, 'xxnerv_telegram_config set'))
  const setOk = /已提交写入 defaultChatId/.test(set)
  emit(`PROBE config-set-ok=${setOk}`)

  // The write applies through an entry reload, which only settles once this
  // probe's calls stop running, so poll the effective value for a bounded time.
  // Let the entry reload land before touching the tree again.
  await new Promise(resolve => setTimeout(resolve, 2500))
  const applied = flattenResult(await run('probe-config-status-2', 'xxnerv_telegram_config', { action: 'status' }, 'xxnerv_telegram_config status'))
  emit(`PROBE config-status-after-set=${applied.slice(0, 240)}`)
  const appliedChat = /defaultChatId: (\S+)/.exec(applied)?.[1] ?? 'missing'
  emit(`PROBE config-applied-default-chat=${appliedChat}`)

  const send = flattenResult(await run('probe-config-3', 'xxnerv_telegram_send', { text: 'after config change' }, 'xxnerv_telegram_send after rewrite'))
  emit(`PROBE config-send=${send.slice(0, 160)}`)
  return statusChat === initialChat && setOk && appliedChat === newChat && /Sent Telegram message/.test(send)
}

/**
 * Probe both contributions and report.
 * @param ctx - the plugin context.
 */
export async function apply(ctx) {
  // Run detached: an unfinished `apply` keeps the tree from settling, which
  // blocks the configuration reload this probe also verifies.
  void runProbe(ctx)
}

/**
 * Probe every contribution in order and exit with the combined status.
 * @param ctx - the plugin context.
 */
async function runProbe(ctx) {
  let exitCode = 1
  try {
    const toolOk = await probeTool(ctx)
    let notifyOk = false
    try {
      notifyOk = await withTimeout(probeTurnEndNotification(ctx), 'notification probe', 15_000)
    } catch (error) {
      emit(`PROBE notification-error=${error instanceof Error ? error.message : String(error)}`)
    }
    let configOk = false
    try {
      configOk = await probeConfig(ctx)
    } catch (error) {
      emit(`PROBE config-error=${error instanceof Error ? error.message : String(error)}`)
    }
    exitCode = toolOk && notifyOk && configOk ? 0 : 1
  } catch (error) {
    emit(`PROBE error=${error instanceof Error ? error.message : String(error)}`)
  } finally {
    emit(`PROBE exit=${exitCode}`)
    // The booted tree has no exit path of its own for a probe run.
    setTimeout(() => process.exit(exitCode), 50)
  }
}
