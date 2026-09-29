/**
 * Configuration plumbing tests: volatile-reference unwrapping, masking, patch
 * building, and effective-config reading. No harness packages imported.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SETTINGS_NAMESPACE,
  buildConfigPatch,
  configBoolean,
  configNumber,
  configString,
  configValue,
  maskSecret,
  patchFieldNames,
  readEffectiveConfig,
  resolveChatId,
} from '../lib/config.js'

/** A stand-in for a volatile configuration reference. */
function ref(value) {
  return { get: () => value }
}

describe('configValue', () => {
  it('passes plain values through', () => {
    assert.equal(configValue('x'), 'x')
    assert.equal(configValue(7), 7)
    assert.equal(configValue(undefined), undefined)
  })

  it('unwraps volatile references', () => {
    assert.equal(configValue(ref('token')), 'token')
    assert.equal(configValue(ref(false)), false)
  })

  it('returns undefined when a reference cannot be read', () => {
    assert.equal(configValue({ get: () => { throw new Error('disposed') } }), undefined)
  })
})

describe('typed config readers', () => {
  it('reads strings from plain values and references, treating blank as unset', () => {
    assert.equal(configString(' a '), 'a')
    assert.equal(configString(ref('b')), 'b')
    assert.equal(configString(ref('  '), 'fallback'), 'fallback')
    assert.equal(configString(undefined, 'fallback'), 'fallback')
    assert.equal(configString(undefined), '')
  })

  it('reads positive numbers with a fallback', () => {
    assert.equal(configNumber(ref(25), 10), 25)
    assert.equal(configNumber('25', 10), 25)
    assert.equal(configNumber(ref(0), 10), 10)
    assert.equal(configNumber(undefined, 10), 10)
    assert.equal(configNumber('nope', 10), 10)
  })

  it('reads booleans without coercing strings', () => {
    assert.equal(configBoolean(ref(true), false), true)
    assert.equal(configBoolean(ref(false), true), false)
    assert.equal(configBoolean('true', false), false)
    assert.equal(configBoolean(undefined, true), true)
  })
})

describe('maskSecret', () => {
  it('reports presence without disclosing the secret', () => {
    assert.equal(maskSecret(''), '(未设置)')
    assert.equal(maskSecret(undefined), '(未设置)')
    assert.equal(maskSecret('short'), '(已设置，5 字符)')
    const masked = maskSecret('1100000000:AAH-FIXTURE-NOT-A-REAL-TOKEN-abcd')
    assert.match(masked, /^1100…abcd/)
    assert.ok(!masked.includes('FIXTURE'))
  })
})

describe('buildConfigPatch', () => {
  it('includes only the supplied fields', () => {
    assert.deepEqual(buildConfigPatch({}), {})
    assert.deepEqual(buildConfigPatch({ default_chat_id: ' 42 ' }), { defaultChatId: '42' })
    assert.deepEqual(
      buildConfigPatch({ bot_token: 't', notify_chat_id: '@c', proxy_url: ' http://127.0.0.1:7897 ' }),
      { botToken: 't', notifyChatId: '@c', proxyUrl: 'http://127.0.0.1:7897' },
    )
  })

  it('maps the auto-push switch strictly to a boolean', () => {
    assert.deepEqual(buildConfigPatch({ notify_on_turn_end: true }), { notifyOnTurnEnd: true })
    assert.deepEqual(buildConfigPatch({ notify_on_turn_end: false }), { notifyOnTurnEnd: false })
    assert.deepEqual(buildConfigPatch({ notify_on_turn_end: 'yes' }), { notifyOnTurnEnd: false })
  })

  it('reports changed field names', () => {
    assert.deepEqual(patchFieldNames(buildConfigPatch({ default_chat_id: 'x', proxy_url: 'y' })), ['defaultChatId', 'proxyUrl'])
    assert.deepEqual(patchFieldNames({}), [])
  })
})

describe('resolveChatId', () => {
  it('accepts static and live values', () => {
    assert.equal(resolveChatId(' 42 '), '42')
    assert.equal(resolveChatId(() => '@chan'), '@chan')
    assert.equal(resolveChatId(() => '  '), '')
    assert.equal(resolveChatId(undefined), '')
  })
})

describe('readEffectiveConfig', () => {
  it('reads a mixed plain/volatile config and falls back for absent fields', () => {
    const effective = readEffectiveConfig({
      botToken: ref('TOKEN'),
      defaultChatId: ref('42'),
      notifyChatId: ref(''),
      proxyUrl: 'http://127.0.0.1:7897',
      apiBase: ref('http://127.0.0.1:1234'),
      timeoutMs: ref(5000),
      notifyOnTurnEnd: ref(true),
      notifyMaxChars: undefined,
      notifyOnlyHumanSessions: undefined,
    })
    assert.equal(effective.botToken, 'TOKEN')
    assert.equal(effective.defaultChatId, '42')
    assert.equal(effective.notifyChatId, '42', 'an empty notify chat falls back to the default chat')
    assert.equal(effective.proxyUrl, 'http://127.0.0.1:7897')
    assert.equal(effective.apiBase, 'http://127.0.0.1:1234')
    assert.equal(effective.timeoutMs, 5000)
    assert.equal(effective.notifyOnTurnEnd, true)
    assert.equal(effective.notifyMaxChars, 600)
    assert.equal(effective.notifyOnlyHumanSessions, true)
  })

  it('uses library defaults for an empty config', () => {
    const effective = readEffectiveConfig({})
    assert.equal(effective.botToken, '')
    assert.equal(effective.apiBase, 'https://api.telegram.org')
    assert.equal(effective.timeoutMs, 15_000)
    assert.equal(effective.notifyOnTurnEnd, false)
    assert.equal(SETTINGS_NAMESPACE, 'xxnerv-telegram')
  })
})
