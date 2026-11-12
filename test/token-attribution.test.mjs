import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TokenAttribution, formatTokenUsage, sourceKindOf } from '../lib/token-attribution.js'

const session = { id: 'session-1' }

function event(seq, kind, shape = 'nested') {
  return shape === 'nested'
    ? { seq, data: { message: { role: 'user', source: { kind } } } }
    : { seq, data: { role: 'user', source: { kind } } }
}

test('sourceKindOf reads both payload shapes and refuses to guess', () => {
  assert.equal(sourceKindOf(event(1, 'user')), 'user')
  assert.equal(sourceKindOf(event(1, 'mcp-memory', 'flat')), 'mcp-memory')
  assert.equal(sourceKindOf({ seq: 1, data: { message: { role: 'user' } } }), null)
  assert.equal(sourceKindOf({ seq: 1, data: 'not-an-object' }), null)
  assert.equal(sourceKindOf({}), null)
})

test('measure attributes node tokens to the recorded producer kind', () => {
  const attribution = new TokenAttribution()
  attribution.observe(session, event(1, 'system-prompt'))
  attribution.observe(session, event(2, 'user'))
  attribution.observe(session, event(3, 'tool'))

  const meter = {
    measure: () => ({
      totalTokens: 5000,
      surfaceTokens: 3000,
      nodes: [
        { seq: 1, tokens: 1000 },
        { seq: 2, tokens: 500 },
        { seq: 3, tokens: 1500 },
      ],
    }),
  }

  const [usage] = attribution.measure(meter)
  assert.equal(usage.session, 'session-1')
  assert.equal(usage.surfaceTokens, 3000)
  assert.equal(usage.totalTokens, 5000)
  assert.deepEqual(usage.byKind, { 'system-prompt': 1000, user: 500, tool: 1500 })
  assert.equal(usage.unknownTokens, 0)
})

test('nodes without a recorded kind are reported as unattributed, never guessed', () => {
  const attribution = new TokenAttribution()
  attribution.observe(session, event(1, 'user'))
  const meter = {
    measure: () => ({ totalTokens: 900, surfaceTokens: 900, nodes: [{ seq: 1, tokens: 400 }, { seq: 99, tokens: 500 }] }),
  }
  const [usage] = attribution.measure(meter)
  assert.equal(usage.unknownTokens, 500)
  assert.deepEqual(usage.byKind, { user: 400 })
})

test('a failing meter degrades to no rows instead of throwing', () => {
  const warnings = []
  const attribution = new TokenAttribution({ warn: (message) => warnings.push(message) })
  attribution.observe(session, event(1, 'user'))
  const usages = attribution.measure({
    measure: () => {
      throw new Error('meter offline')
    },
  })
  assert.deepEqual(usages, [])
  assert.match(warnings[0], /token measurement failed: meter offline/)
})

test('the session registry is bounded', () => {
  const attribution = new TokenAttribution()
  for (let index = 0; index < 25; index += 1) {
    attribution.observe({ id: `session-${index}` }, event(1, 'user'))
  }
  assert.equal(attribution.size(), 20)
  const meter = { measure: () => ({ totalTokens: 1, surfaceTokens: 1, nodes: [] }) }
  const usages = attribution.measure(meter, 50)
  // Newest first: the last observed session must survive.
  assert.equal(usages[0].session, 'session-24')
})

test('formatTokenUsage orders kinds by tokens and marks unattributed', () => {
  const text = formatTokenUsage(
    [
      {
        session: 'session-1',
        totalTokens: 2000,
        surfaceTokens: 1800,
        byKind: { user: 300, 'system-prompt': 1200 },
        unknownTokens: 300,
        nodes: 4,
      },
    ],
    5,
  )
  assert.match(text, /session-1: 1800 surface \/ 2000 total over 4 node\(s\)/)
  assert.match(text, /system-prompt 1200, user 300, unattributed 300 \(events keelwatch did not observe\)/)
})

test('no observations reports that instead of an empty table', () => {
  assert.match(formatTokenUsage([], 5), /no requests observed yet/)
})
