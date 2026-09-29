/**
 * Browser half of `dsh-xxnerv-telegram`: the Telegram configuration page on the
 * web client's Plugins page.
 *
 * The page registers into the Plugins page's `plugins.row.config` slot under
 * `<package name>#<row id>` (`dsh-xxnerv-telegram#xxnerv-telegram`), which gives the
 * `telegram` row a **Configure** control; opening it renders the staged form
 * below. Values are written through the shared settings form
 * (`ctx.configForms.get('xxnerv-telegram')`) on Save only, and the bot token rides the
 * `role('secret')` path: the Host never sends the stored token, so the control
 * starts blank, reports only whether one is configured, and writes nothing when
 * left blank.
 *
 * This file is the package's `exports["./client"]` bundle, discovered from the
 * `dsh.client` declaration in package.json. It is hand-written in the served
 * `window.__ModuleLoader__.load` form, so the package needs no build step.
 *
 * Modules requested here must be in the shell's frozen baseline
 * (`react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-ui-primitives`).
 *
 * @module dsh-xxnerv-telegram/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-xxnerv-telegram',
  factory: require => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const { jsx, jsxs } = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Dictionary namespace owned by this page. */
    const NS = 'settings.xxnerv-telegram'
    /** Profile entry id this page edits; the bundle's patch declares the same id. */
    const ENTRY = 'xxnerv-telegram'
    /** `plugins.row.config` key: bundle package name plus the row id. */
    const ROW_KEY = 'dsh-xxnerv-telegram#xxnerv-telegram'
    /**
     * What the token control shows in place of a stored secret.
     *
     * The Host never sends the token, so an empty control would read as "not
     * configured"; the filled mask says "a token is stored" while staying a
     * value the user can simply type over.
     */
    const SECRET_MASK = '*'.repeat(16)
    /** Services the page needs from the browser runtime. */
    const inject = ['slots', 'locale', 'configForms']

    /** English copy. */
    const en = {
      title: 'Telegram',
      description: 'Send messages and turn-end notifications through a Telegram bot.',
      botToken: 'Bot token',
      botTokenHint: 'From @BotFather. A row of * means one is stored; typing a new token replaces it, and saving a blank field keeps it.',
      configured: 'Configured',
      notConfigured: 'Not configured',
      defaultChatId: 'Default chat',
      defaultChatIdHint: 'Chat id or @channelusername used when a message names no target.',
      notifyChatId: 'Notification chat',
      notifyChatIdHint: 'Chat that turn-end notifications go to. Blank falls back to the default chat.',
      proxyUrl: 'Proxy URL',
      proxyUrlHint: 'HTTP CONNECT proxy for reaching api.telegram.org, e.g. http://127.0.0.1:7897. Blank connects directly.',
      notifyOnTurnEnd: 'Notify when a turn ends',
      notifyOnTurnEndHint: 'Push the finished turn’s last answer to Telegram. Only sessions a person prompted.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'The Telegram plugin is not loaded, so it cannot be configured right now.',
    }

    /** Simplified Chinese copy. */
    const zh = {
      title: 'Telegram',
      description: '通过 Telegram bot 发送消息与任务完成通知。',
      botToken: 'Bot Token',
      botTokenHint: '来自 @BotFather。显示一串 * 表示已保存；直接输入新值会整体替换，留空保存则保持不变。',
      configured: '已设置',
      notConfigured: '未设置',
      defaultChatId: '默认会话',
      defaultChatIdHint: '消息未指定目标时使用的 chat id 或 @频道用户名。',
      notifyChatId: '通知会话',
      notifyChatIdHint: '任务完成推送发往的会话；留空则回落到默认会话。',
      proxyUrl: '代理地址',
      proxyUrlHint: '访问 api.telegram.org 的 HTTP CONNECT 代理，例如 http://127.0.0.1:7897；留空为直连。',
      notifyOnTurnEnd: '每轮结束推送',
      notifyOnTurnEndHint: '把该轮最后的回答推送到 Telegram；只推送人发起过的会话。',
      overridden: '已覆盖',
      reset: '恢复默认',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      readOnly: '本部署的设置为只读。',
      unavailable: 'Telegram 插件当前未加载，暂时无法配置。',
    }

    /**
     * A boolean field inside the namespace section, staged as text.
     *
     * `SettingsFormModel` ships number and text specs only; a switch needs the
     * same `{field, format, parse}` shape so saving writes a real boolean.
     * @param field - field name inside the namespace section.
     * @returns the field's conversion spec.
     */
    function settingsBooleanField(field) {
      return {
        field,
        format: value => (value === true ? 'true' : 'false'),
        parse: text => {
          const trimmed = text.trim()
          if (trimmed === 'true') return { kind: 'set', value: true }
          if (trimmed === 'false') return { kind: 'set', value: false }
          return undefined
        },
      }
    }

    /**
     * Stage the Telegram namespace over the shared settings form.
     *
     * The form owns the drafts, the override marks, and the revision-fenced
     * save; this controller only projects the fields the page renders and reads
     * the secret marker the Host publishes for the token.
     */
    class TelegramCardController {
      /**
       * @param scope - the shared configuration form of the `telegram` entry.
       * @param mirror - the shared describe face, whose namespaces carry the secret markers.
       */
      constructor(scope, mirror) {
        this.mirror = mirror
        this.form = new primitives.SettingsFormModel(scope, [
          primitives.settingsTextField('botToken'),
          primitives.settingsTextField('defaultChatId'),
          primitives.settingsTextField('notifyChatId'),
          primitives.settingsTextField('proxyUrl'),
          settingsBooleanField('notifyOnTurnEnd'),
        ])
        this.store = this.form.bind(() => this.projection())
        this.unsubscribe = mirror.subscribe(() => {
          this.store.set(this.projection())
        })
      }

      /**
       * Whether the Host reports a stored bot token.
       *
       * The token never rides a response: the namespace view carries a marker
       * per secret position instead, which is all this badge needs.
       * @returns the configured flag.
       */
      tokenConfigured() {
        const view = this.mirror.getSnapshot().view
        const namespace = view?.namespaces.find(candidate => candidate.ns === ENTRY)
        return (namespace?.secrets ?? []).some(secret => secret.path?.[0] === 'botToken' && secret.set === true)
      }

      /**
       * Build the snapshot the page's component reads.
       * @returns the form state plus one entry per rendered control.
       */
      projection() {
        return {
          ...this.form.shell(),
          botToken: this.form.field('botToken'),
          botTokenConfigured: this.tokenConfigured(),
          defaultChatId: this.form.field('defaultChatId'),
          notifyChatId: this.form.field('notifyChatId'),
          proxyUrl: this.form.field('proxyUrl'),
          notifyOnTurnEnd: this.form.field('notifyOnTurnEnd'),
        }
      }

      /**
       * Build the props face the slot registration injects.
       * @returns the page's snapshot hook and the form actions.
       */
      inject() {
        return {
          hooks: { telegramCard: this.store },
          ...this.form.actions(),
        }
      }

      /** Release the mirror subscription and the form's own subscriptions. */
      dispose() {
        this.unsubscribe()
        this.form.dispose()
      }
    }

    /**
     * Mount the Telegram configuration page.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'telegram: dictionaries')

      const controller = new TelegramCardController(ctx.configForms.get(ENTRY), ctx.configForms.describe())
      ctx.effect(() => () => controller.dispose(), 'telegram: form subscription')

      /**
       * Render the row's one-liner, or its configurable form.
       * @param props - the page's view, the injected snapshot hook, and form actions.
       * @returns the summary line or the settings form.
       */
      function TelegramCard(props) {
        const state = props.useTelegramCard(snapshot => snapshot)
        const read = typeof props.t === 'function' ? props.t : t
        if (props.view === 'summary') return read('description')

        const disabled = !state.writable
        const labels = {
          unavailable: read('unavailable'),
          readOnly: read('readOnly'),
          saveFailed: read('saveFailed'),
          save: read('save'),
          saving: read('saving'),
        }
        /**
         * Render one text control over the shared form.
         * @param field - namespace field name.
         * @param label - control label.
         * @param hint - supporting copy.
         * @returns the control.
         */
        const textField = (field, label, hint) => jsx(primitives.SettingsValueField, {
          id: `xxnerv-telegram-${field}`,
          key: field,
          label,
          hint,
          overriddenLabel: read('overridden'),
          resetLabel: read('reset'),
          disabled,
          ...state[field],
          onEdit: value => props.edit(field, value),
          onReset: () => props.resetField(field),
        })

        // A stored secret arrives as a marker, not a value, so the control shows
        // the mask until the user types something of their own.
        const tokenText = state.botToken.text !== ''
          ? state.botToken.text
          : (state.botTokenConfigured ? SECRET_MASK : '')
        const toggle = state.notifyOnTurnEnd
        return jsxs(primitives.SettingsForm, {
          labels,
          state,
          onSave: props.save,
          onDiscard: props.discard,
          children: [
            jsx(primitives.SettingsSecretField, {
              id: 'xxnerv-telegram-botToken',
              key: 'botToken',
              label: read('botToken'),
              hint: read('botTokenHint'),
              stateLabel: state.botTokenConfigured ? read('configured') : read('notConfigured'),
              configured: state.botTokenConfigured,
              disabled,
              text: tokenText,
              onEdit: value => props.edit('botToken', value.replace(/\*/g, '')),
            }),
            textField('defaultChatId', read('defaultChatId'), read('defaultChatIdHint')),
            textField('notifyChatId', read('notifyChatId'), read('notifyChatIdHint')),
            textField('proxyUrl', read('proxyUrl'), read('proxyUrlHint')),
            jsxs('div', {
              key: 'notifyOnTurnEnd',
              style: {
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: '12px',
                padding: '10px 0',
              },
              children: [
                jsxs('div', {
                  children: [
                    jsx('div', { style: { fontSize: '13px' }, children: read('notifyOnTurnEnd') }),
                    jsx('p', {
                      style: { margin: '4px 0 0', fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
                      children: read('notifyOnTurnEndHint'),
                    }),
                  ],
                }),
                jsxs('div', {
                  style: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 },
                  children: [
                    toggle.overridden ? jsx(primitives.Tag, { tone: 'neutral', children: read('overridden') }) : null,
                    toggle.overridden ? jsx('button', {
                      type: 'button',
                      disabled,
                      onClick: () => props.resetField('notifyOnTurnEnd'),
                      style: {
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        font: 'inherit',
                        fontSize: '12px',
                        opacity: 0.8,
                        cursor: disabled ? 'default' : 'pointer',
                        textDecoration: 'underline',
                      },
                      children: read('reset'),
                    }) : null,
                    jsx(primitives.Switch, {
                      checked: toggle.text === 'true',
                      disabled,
                      label: read('notifyOnTurnEnd'),
                      onChange: value => props.edit('notifyOnTurnEnd', String(value)),
                    }),
                  ],
                }),
              ],
            }),
          ],
        })
      }

      ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_KEY,
        order: 10,
        locale: NS,
        inject: () => controller.inject(),
      }, TelegramCard))), 'telegram: configuration page')
    }

    exports.NS = NS
    exports.ENTRY = ENTRY
    exports.ROW_KEY = ROW_KEY
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
