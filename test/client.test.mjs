/**
 * Browser-half smoke test.
 *
 * The client bundle cannot run for real without a DOM, so this evaluates it
 * with stubbed platform modules (`react/jsx-runtime`,
 * `@deepseek-ai/dsh-client-ui-primitives`) and asserts the wiring contract it
 * must satisfy: the loader id, the exported `apply`/`inject`, the dictionary
 * registration, the `plugins.row.config` registration keyed by
 * `<package>#<row>`, the injected props face, and that rendering both views
 * produces a tree without touching anything outside the primitives.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

/** Minimal stand-in for the shared settings form the real primitives provide. */
class SettingsFormModelStub {
  /** @param scope - the settings scope. @param specs - the section field specs. */
  constructor(scope, specs) {
    this.scope = scope
    this.specs = specs
    this.staged = new Map()
    this.listeners = new Set()
    this.disposed = false
  }

  /** @returns the card-level state. */
  shell() {
    return { available: true, writable: true, dirty: this.staged.size > 0, invalid: false, saving: false, failed: false }
  }

  /** @param field - field name. @returns one control's state. */
  field(field) {
    const spec = this.specs.find(candidate => candidate.field === field)
    assert.ok(spec !== undefined, `unknown field ${field}`)
    const staged = this.staged.get(field)
    if (staged !== undefined) return { text: staged.text, overridden: true, invalid: false }
    return { text: spec.format(this.scope.getSnapshot().value?.[field]), overridden: false, invalid: false }
  }

  /** @returns the form actions, publishing after each staged edit like the real model. */
  actions() {
    return {
      edit: (field, text) => {
        this.staged.set(field, { text })
        this.publish()
      },
      resetField: field => {
        this.staged.set(field, { text: '', clear: true })
        this.publish()
      },
      save: () => { this.saved = true },
      discard: () => {
        this.staged.clear()
        this.publish()
      },
    }
  }

  /** Notify every bound projection. */
  publish() {
    for (const listener of this.listeners) listener()
  }

  /** @param project - projection builder. @returns a snapshot store. */
  bind(project) {
    const store = {
      value: project(),
      set: value => { store.value = value },
      getSnapshot: () => store.value,
      subscribe: () => () => {},
    }
    this.listeners.add(() => store.set(project()))
    return store
  }

  /** Mark the model disposed. */
  dispose() {
    this.disposed = true
  }
}

/** Platform-module stubs the bundle may request. */
const primitivesStub = {
  SettingsFormModel: SettingsFormModelStub,
  SettingsForm: 'SettingsForm',
  SettingsValueField: 'SettingsValueField',
  SettingsSecretField: 'SettingsSecretField',
  Switch: 'Switch',
  Tag: 'Tag',
  settingsTextField: field => ({
    field,
    format: value => (typeof value === 'string' ? value : ''),
    parse: text => (text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: text.trim() }),
  }),
}

/**
 * Evaluate the client bundle with stub modules.
 * @returns the captured loader registration.
 */
function loadClientBundle() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
  const jsxs = (type, props, key) => ({ type, props: props ?? {}, key, many: true })
  const requireStub = specifier => {
    if (specifier === 'react/jsx-runtime') return { jsx, jsxs, Fragment: 'Fragment' }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
    throw new Error(`client bundle requested an undeclared module: ${specifier}`)
  }
  const windowStub = { __ModuleLoader__: { load: value => { registration = value } } }
  // eslint-disable-next-line no-new-func -- the served bundle is a script, not a module
  new Function('window', 'require', source)(windowStub, requireStub)
  assert.ok(registration !== undefined, 'the bundle registered no module')
  return registration
}

/** A fake browser context recording every contribution. */
function fakeContext({ scopeValue = { botToken: undefined, defaultChatId: '@chan', notifyChatId: '', proxyUrl: '', notifyOnTurnEnd: false }, secrets = [{ path: ['botToken'], set: true }] } = {}) {
  const record = { dictionaries: [], slots: [], effects: 0, disposed: 0 }
  const scope = { getSnapshot: () => ({ value: scopeValue, revision: 3, writable: true }), subscribe: () => () => {} }
  const mirrorView = { writable: true, namespaces: [{ ns: 'xxnerv-telegram', secrets, revision: 3, value: scopeValue }] }
  const mirror = { getSnapshot: () => ({ view: mirrorView }), subscribe: () => () => {} }
  const ctx = {
    effect: callback => {
      record.effects += 1
      const dispose = callback()
      return () => {
        record.disposed += 1
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: {
      bind: ns => key => `${ns}.${key}`,
      register: (ns, dictionaries) => {
        record.dictionaries.push({ ns, dictionaries })
      },
    },
    configForms: {
      get: () => scope,
      describe: () => mirror,
      whileServed: (namespaces, register) => {
        record.whileServed = [...namespaces]
        const dispose = register(new Set(namespaces))
        return () => dispose?.()
      },
    },
    slots: {
      inject: (key, callback) => {
        record.injectKey = key
        return callback()
      },
      register: (options, component) => {
        record.slots.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, record, scope }
}

describe('client bundle registration', () => {
  it('registers the package id and exports the browser plugin face', () => {
    const registration = loadClientBundle()
    assert.equal(registration.id, 'dsh-xxnerv-telegram')
    assert.equal(typeof registration.factory, 'function')
    const exported = registration.factory(specifier => {
      if (specifier === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}) }
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
      throw new Error(specifier)
    })
    assert.equal(typeof exported.apply, 'function')
    assert.deepEqual(exported.inject, ['slots', 'locale', 'configForms'])
    assert.equal(exported.NS, 'settings.xxnerv-telegram')
    assert.equal(exported.ROW_KEY, 'dsh-xxnerv-telegram#xxnerv-telegram')
  })

  it('requests only baseline modules', () => {
    const registration = loadClientBundle()
    const requested = []
    registration.factory(specifier => {
      requested.push(specifier)
      if (specifier === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}) }
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
      throw new Error(specifier)
    })
    assert.deepEqual(requested.sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react/jsx-runtime'])
  })
})

describe('client bundle activation', () => {
  it('registers dictionaries, the row page, and keys it to the telegram row', () => {
    const { ctx, record } = fakeContext()
    const exported = loadClientBundle().factory(specifier => {
      if (specifier === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) }
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
      throw new Error(specifier)
    })
    exported.apply(ctx)

    assert.deepEqual(record.dictionaries.map(entry => entry.ns), ['settings.xxnerv-telegram'])
    assert.deepEqual(Object.keys(record.dictionaries[0].dictionaries).sort(), ['en', 'zh'])
    assert.equal(record.injectKey, 'plugins.row.config')
    assert.equal(record.slots.length, 1)
    const [registration] = record.slots
    assert.equal(registration.options.name, 'plugins.row.config')
    assert.equal(registration.options.key, 'dsh-xxnerv-telegram#xxnerv-telegram')
    assert.equal(registration.options.locale, 'settings.xxnerv-telegram')
    assert.equal(typeof registration.options.inject, 'function')
  })

  it('injects the snapshot hook and the form actions, and disposes cleanly', () => {
    const { ctx, record } = fakeContext()
    const exported = loadClientBundle().factory(specifier => {
      if (specifier === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) }
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
      throw new Error(specifier)
    })
    exported.apply(ctx)
    const injected = record.slots[0].options.inject()
    assert.deepEqual(Object.keys(injected.hooks), ['telegramCard'])
    for (const action of ['edit', 'resetField', 'save', 'discard']) assert.equal(typeof injected[action], 'function', action)
    assert.equal(injected.hooks.telegramCard.getSnapshot().botTokenConfigured, true)
    assert.equal(injected.hooks.telegramCard.getSnapshot().defaultChatId.text, '@chan')
  })
})

describe('client bundle rendering', () => {
  /** Render one view through the registered component. */
  const render = (view, options) => {
    const { ctx, record } = fakeContext(options)
    const exported = loadClientBundle().factory(specifier => {
      if (specifier === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) }
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
      throw new Error(specifier)
    })
    exported.apply(ctx)
    const registration = record.slots[0]
    const injected = registration.options.inject()
    const props = {
      view,
      t: key => key,
      useTelegramCard: selector => selector(injected.hooks.telegramCard.getSnapshot()),
      ...injected,
    }
    return { tree: registration.component(props), props, injected, store: injected.hooks.telegramCard }
  }

  it('renders the one-liner for the summary view', () => {
    const { tree } = render('summary')
    assert.equal(tree, 'description')
  })

  it('renders the settings form with every control for the page view', () => {
    const { tree } = render('page')
    assert.equal(tree.type, 'SettingsForm')
    const types = tree.props.children.map(child => child.type)
    assert.deepEqual(types, ['SettingsSecretField', 'SettingsValueField', 'SettingsValueField', 'SettingsValueField', 'div'])
    const [, defaultChat, notifyChat, proxy] = tree.props.children
    assert.equal(defaultChat.props.text, '@chan')
    assert.equal(notifyChat.props.text, '')
    assert.equal(proxy.props.text, '')
    const secret = tree.props.children[0]
    assert.equal(secret.props.configured, true)
    assert.equal(secret.props.stateLabel, 'configured')
    assert.equal(secret.props.text, '*'.repeat(16), 'a stored token shows as a mask, never as the value')
  })

  it('leaves the token control blank when nothing is stored', () => {
    const { tree } = render('page', { secrets: [{ path: ['botToken'], set: false }] })
    assert.equal(tree.props.children[0].props.text, '')
  })

  it('strips the mask when a replacement token is typed', () => {
    const { tree, store } = render('page')
    tree.props.children[0].props.onEdit(`${'*'.repeat(16)}1100000000:AAF-NEW`)
    assert.equal(store.getSnapshot().botToken.text, '1100000000:AAF-NEW')
    tree.props.children[0].props.onEdit('1100000000:AAF-OTHER')
    assert.equal(store.getSnapshot().botToken.text, '1100000000:AAF-OTHER')
  })

  it('stages a blank draft for an emptied token control, which writes nothing', () => {
    const { tree, store } = render('page')
    tree.props.children[0].props.onEdit('')
    assert.equal(store.getSnapshot().botToken.text, '', 'an empty draft never stages the mask as the token')
  })

  it('reads the token badge from the Host secret markers', () => {
    const { tree } = render('page', { secrets: [{ path: ['botToken'], set: false }] })
    assert.equal(tree.props.children[0].props.configured, false)
    assert.equal(tree.props.children[0].props.stateLabel, 'notConfigured')
  })

  it('stages edits through the injected form actions', () => {
    const { tree, store } = render('page')
    tree.props.children[1].props.onEdit('@other')
    assert.equal(store.getSnapshot().defaultChatId.text, '@other')
    tree.props.children[1].props.onReset()
    assert.equal(store.getSnapshot().defaultChatId.text, '')
    const toggle = tree.props.children[4].props.children[1].props.children[2]
    toggle.props.onChange(true)
    assert.equal(store.getSnapshot().notifyOnTurnEnd.text, 'true')
  })

  it('maps the boolean switch through a strict set/parse spec', () => {
    const captured = []
    const Original = primitivesStub.SettingsFormModel
    primitivesStub.SettingsFormModel = class extends Original {
      /** @param scope - the settings scope. @param specs - the section field specs. */
      constructor(scope, specs) {
        super(scope, specs)
        captured.push(specs)
      }
    }
    try {
      render('page')
    } finally {
      primitivesStub.SettingsFormModel = Original
    }
    assert.equal(captured.length, 1)
    const specs = captured[0]
    assert.deepEqual(
      specs.map(spec => spec.field),
      ['botToken', 'defaultChatId', 'notifyChatId', 'proxyUrl', 'notifyOnTurnEnd'],
    )
    const booleanSpec = specs.find(spec => spec.field === 'notifyOnTurnEnd')
    assert.deepEqual(booleanSpec.parse('true'), { kind: 'set', value: true })
    assert.deepEqual(booleanSpec.parse('false'), { kind: 'set', value: false })
    assert.equal(booleanSpec.parse('maybe'), undefined)
    assert.equal(booleanSpec.format(true), 'true')
    assert.equal(booleanSpec.format(undefined), 'false')
  })
})
