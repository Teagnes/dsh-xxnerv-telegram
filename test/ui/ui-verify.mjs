/**
 * Headless-Chrome verification of the Telegram configuration page.
 *
 * Drives the real web client over the DevTools Protocol: open the app with its
 * auth token, click the sidebar's Plugins panel, open this plugin's card, open
 * the `telegram` row's Configure page, and report the rendered controls plus a
 * screenshot. This verifies the browser half end to end — registration, the
 * Configure control, and the form itself — without a human at the screen.
 *
 * Usage: node ui-verify.mjs <appUrl> <outPng> [debugPort]
 */
import { writeFileSync } from 'node:fs'

const [appUrl, outDir, debugPortArg] = process.argv.slice(2)
if (appUrl === undefined || outDir === undefined) {
  console.error('usage: node ui-verify.mjs <appUrl> <outDir> [debugPort]')
  process.exit(2)
}
const debugPort = Number(debugPortArg ?? 9333)

/** Sleep. */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Find the debugger websocket of the first page target. */
async function pageTarget() {
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      const targets = await response.json()
      const page = targets.find(target => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return page
    } catch {
      /* Chrome is still starting. */
    }
    if (Date.now() > deadline) throw new Error('no Chrome page target appeared')
    await sleep(200)
  }
}

/** Connect to one target and expose request/response plus event waiting. */
async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true })
  })
  let nextId = 0
  const pending = new Map()
  const listeners = new Set()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error !== undefined) reject(new Error(`${message.error.message}`))
      else resolve(message.result)
      return
    }
    for (const listener of listeners) listener(message)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const waitFor = (method, timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(listener)
      reject(new Error(`timed out waiting for ${method}`))
    }, timeoutMs)
    const listener = message => {
      if (message.method !== method) return
      clearTimeout(timer)
      listeners.delete(listener)
      resolve(message.params)
    }
    listeners.add(listener)
  })
  return { send, waitFor, close: () => socket.close() }
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
  }
  return result.result.value
}

/** Click the deepest element whose trimmed text equals the label. */
const clickByTextExpression = label => `(() => {
  const wanted = ${JSON.stringify(label)};
  const nodes = [...document.querySelectorAll('button, a, [role="button"], li, div, span, p')]
    .filter(el => (el.textContent ?? '').trim() === wanted);
  if (nodes.length === 0) return 'not-found';
  nodes.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
  nodes[0].click();
  return 'clicked';
})()`

/** Click the first element matching a selector. */
const clickSelectorExpression = selector => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (el === null) return 'not-found';
  el.click();
  return 'clicked';
})()`

/** Report what the page currently shows for this plugin. */
const inspectExpression = `(() => {
  const inputs = [...document.querySelectorAll('input')].map(input => ({
    id: input.id,
    type: input.type,
    value: input.type === 'password' ? (input.value === '' ? '' : '<redacted>') : input.value,
    disabled: input.disabled,
  }));
  const configureLabels = [...document.querySelectorAll('button')]
    .map(button => button.getAttribute('aria-label'))
    .filter(label => label !== null && /telegram/i.test(label));
  return {
    title: document.title,
    telegramInputs: inputs.filter(input => input.id.startsWith('xxnerv-telegram-')),
    anyInputs: inputs.length,
    configureLabels,
    bodyText: document.body.innerText.slice(0, 4000),
  };
})()`

const target = await pageTarget()
const session = await connect(target.webSocketDebuggerUrl)
await session.send('Page.enable')
await session.send('Runtime.enable')
await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })

const steps = []
const screenshots = []
/**
 * Click away any blocking overlay before a capture.
 *
 * A profile without a configured model shows the first-run API-key dialog, and
 * some builds show a preview/announcement notice on top of the page; both are
 * environment noise, and a capture that includes them documents the wrong thing.
 */
async function dismissOverlays() {
  // Overlays can stack (preview notice, then the first-run API-key dialog), so
  // keep clicking until a round finds nothing left to dismiss.
  for (let round = 0; round < 4; round += 1) {
    const clicked = await evaluate(session, `(() => {
      const labels = ['稍后配置', 'Configure later', 'Later', '继续', 'Continue', '知道了', 'Got it'];
      const clicked = [];
      for (const button of [...document.querySelectorAll('button')]) {
        const text = (button.textContent ?? '').trim();
        if (!labels.includes(text) || button.disabled || button.offsetParent === null) continue;
        button.click();
        clicked.push(text);
      }
      return clicked;
    })()`)
    if (!Array.isArray(clicked) || clicked.length === 0) return
    console.log(`dismissed overlay: ${JSON.stringify(clicked)}`)
    await sleep(600)
  }
}
/** Capture one labelled screenshot into the output directory. */
async function shot(name) {
  await dismissOverlays()
  const capture = await session.send('Page.captureScreenshot', { format: 'png' })
  const path = `${outDir}/${name}.png`
  writeFileSync(path, Buffer.from(capture.data, 'base64'))
  screenshots.push(path)
  console.log(`screenshot: ${path}`)
}
console.log(`navigating to ${appUrl}`)
await session.send('Page.navigate', { url: appUrl })
await sleep(6000)

/** Record one labelled DOM probe. */
async function probe(label, expression) {
  const value = await evaluate(session, expression)
  steps.push({ label, value })
  console.log(`${label}: ${JSON.stringify(value)}`)
  return value
}

// The app shell may need a moment before the sidebar exists.
for (let attempt = 0; attempt < 20; attempt += 1) {
  const ready = await evaluate(session, `document.querySelectorAll('button').length`)
  if (ready > 3) break
  await sleep(500)
}

// A profile without a configured model shows the first-run API-key dialog; it is
// environment noise for this check, so dismiss it before capturing anything.
await probe('dismiss-onboarding', `(() => {
  const button = [...document.querySelectorAll('button')].find(b => ['稍后配置', 'Configure later', 'Later'].includes((b.textContent ?? '').trim()));
  if (button === undefined) return 'none';
  button.click();
  return 'dismissed';
})()`)
await sleep(800)

const panels = await probe('panels', `[...document.querySelectorAll('button, a, [role="button"]')].map(el => (el.textContent ?? '').trim()).filter(Boolean).slice(0, 40)`)
const pluginsLabel = panels.includes('插件') ? '插件' : panels.includes('Plugins') ? 'Plugins' : undefined
console.log(`plugins panel label: ${pluginsLabel ?? 'not found'}`)
if (pluginsLabel !== undefined) {
  await probe('open-plugins', clickByTextExpression(pluginsLabel))
  await sleep(2500)
  await probe('card', `(() => {
    const card = document.querySelector('[data-plugin-package="dsh-xxnerv-telegram"]');
    return card === null ? 'not-found' : 'present';
  })()`)
  await shot('1-plugins-list')
  // The card's own View control names the package, which is a precise target;
  // falling back to the card itself keeps the step working if it is renamed.
  const labelsMatching = pattern => `[...document.querySelectorAll('button')]
    .map(b => b.getAttribute('aria-label'))
    .filter(l => l !== null && ${pattern}.test(l))`
  const viewLabels = await evaluate(session, labelsMatching('/^(查看|View) .*dsh-xxnerv-telegram/i'))
  if (viewLabels.length > 0) {
    await probe('open-detail', clickSelectorExpression(`button[aria-label="${viewLabels[0]}"]`))
  } else {
    await probe('open-card', clickSelectorExpression('[data-plugin-package="dsh-xxnerv-telegram"]'))
  }
  await sleep(2000)

  // The row's Configure control appears once the package detail is open.
  const configure = await evaluate(session, labelsMatching('/^(配置|Configure) .*(telegram|dsh-xxnerv-telegram)/i'))
  steps.push({ label: 'configure-controls', value: configure })
  console.log(`configure-controls: ${JSON.stringify(configure)}`)
  await shot('2-plugin-card')
  if (configure.length > 0) {
    await probe('open-configure', clickSelectorExpression(`button[aria-label="${configure[0]}"]`))
    await sleep(2500)
  }
}
const final = await probe('page', inspectExpression)
await shot('3-telegram-config')

// Optional write round-trip: type into the token and/or default-chat controls,
// press Save, and let the shell runner assert what reached the profile patch.
const saveChat = process.env.UI_SAVE_VALUE ?? ''
const saveToken = process.env.UI_SAVE_TOKEN ?? ''
const hasControl = id => final.telegramInputs.some(input => input.id === id)
if ((saveChat !== '' || saveToken !== '') && hasControl('xxnerv-telegram-defaultChatId')) {
  /** Type into one control the way a person would (native setter + input event). */
  const typeInto = async (id, value) => evaluate(session, `(() => {
    const input = document.getElementById(${JSON.stringify(id)});
    if (input === null) return 'missing';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`)
  if (saveToken !== '') {
    const typedToken = await typeInto('xxnerv-telegram-botToken', saveToken)
    steps.push({ label: 'typed-token', value: typedToken === saveToken ? 'mask replaced by the typed token' : typedToken })
    console.log(`typed-token: ${JSON.stringify(typedToken === saveToken ? 'mask replaced' : typedToken)}`)
  }
  if (saveChat !== '') {
    const typedChat = await typeInto('xxnerv-telegram-defaultChatId', saveChat)
    steps.push({ label: 'typed-chat', value: typedChat })
    console.log(`typed-chat: ${JSON.stringify(typedChat)}`)
  }
  await sleep(500)
  await shot('4-staged')
  const saved = await evaluate(session, `(() => {
    const button = [...document.querySelectorAll('button')].find(b => ['保存', 'Save'].includes((b.textContent ?? '').trim()));
    if (button === undefined) return 'no-save-button';
    if (button.disabled) return 'save-disabled';
    button.click();
    return 'clicked';
  })()`)
  steps.push({ label: 'save', value: saved })
  console.log(`save: ${JSON.stringify(saved)}`)
  await sleep(3000)
  await shot('5-after-save')
  const after = await evaluate(session, `(() => ({
    token: document.getElementById('xxnerv-telegram-botToken')?.value ?? null,
    chat: document.getElementById('xxnerv-telegram-defaultChatId')?.value ?? null,
  }))()`)
  steps.push({ label: 'after-save', value: after })
  console.log(`after-save: ${JSON.stringify(after)}`)
}
console.log(`RESULT ${JSON.stringify({ panels: panels.slice(0, 12), screenshots, final: { telegramInputs: final.telegramInputs, bodyText: final.bodyText.slice(0, 700) } })}`)
session.close()
process.exit(0)
