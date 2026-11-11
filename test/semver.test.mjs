import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDrift, checkEngine, compareVersion, parseVersion, satisfies } from '../lib/semver.js'

test('parseVersion accepts release, prerelease, and build metadata', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] })
  assert.deepEqual(parseVersion('v0.2.1-rc.5'), { major: 0, minor: 2, patch: 1, pre: ['rc', '5'] })
  assert.deepEqual(parseVersion('1.0.0+build.7'), { major: 1, minor: 0, patch: 0, pre: [] })
  assert.equal(parseVersion('not-a-version'), null)
})

test('prerelease sorts below its release and legacy numeric compare reads releases correctly', () => {
  const rc = parseVersion('0.2.1-rc.5')
  const release = parseVersion('0.2.1')
  assert.equal(compareVersion(rc, release), -1)
  assert.equal(compareVersion(release, rc), 1)
  assert.equal(compareVersion(parseVersion('0.2.2'), parseVersion('0.2.1')), 1)
})

test('satisfies models the range syntax the scanner claims', () => {
  const version = parseVersion('1.5.0')
  assert.equal(satisfies(version, '^1.2.3'), true)
  assert.equal(satisfies(version, '~1.2.3'), false)
  assert.equal(satisfies(version, '>=1.0.0 <2.0.0'), true)
  assert.equal(satisfies(version, '1'), true)
  assert.equal(satisfies(version, '1.6'), false)
  assert.equal(satisfies(version, '*'), true)
})

test('satisfies reports null for syntax it does not model instead of guessing', () => {
  const version = parseVersion('1.0.0')
  assert.equal(satisfies(version, 'workspace:*'), null)
  assert.equal(satisfies(version, 'github:kute/repo'), null)
  assert.equal(satisfies(version, 'npm:other@^1.0.0'), null)
})

test('classifyDrift separates "permissive declaration" from "upstream moved"', () => {
  // Inside the declared range: nothing drifted, the range is just wide.
  assert.equal(classifyDrift('^1.2.3', '1.9.0').level, 'none')
  // Caret range cannot reach 2.x.
  assert.equal(classifyDrift('^1.2.3', '2.0.0').level, 'major')
  // Tilde range cannot reach a new minor.
  assert.equal(classifyDrift('~1.2.3', '1.5.0').level, 'minor')
  // Pin cannot take a patch bump.
  assert.equal(classifyDrift('1.2.3', '1.2.4').level, 'patch')
  // Unbounded declarations are never drift.
  assert.equal(classifyDrift('*', '9.9.9').level, 'none')
})

test('classifyDrift marks unanalyzable declarations as skipped with a reason', () => {
  const result = classifyDrift('workspace:^1.0.0', '1.0.1')
  assert.equal(result.level, 'skipped')
  assert.match(result.reason, /does not model/)
})

test('checkEngine flags a DSH version outside engines.dsh', () => {
  const union = '>=0.2.1-0 <0.3.0 || >=0.2.2-0 <0.3.0'
  assert.equal(checkEngine(union, '0.2.2-rc.1').level, 'none')
  assert.equal(checkEngine(union, '0.3.0').level, 'major')
  assert.equal(checkEngine('>=9.0.0', '0.2.1-rc.5').level, 'major')
  assert.equal(checkEngine(union, 'garbage').level, 'skipped')
})

test('a prerelease answers only to a range naming its own tuple (npm rule)', () => {
  const rc5 = parseVersion('0.2.1-rc.5')
  const rc22 = parseVersion('0.2.2-rc.1')
  // The obvious single clause admits neither: this is why engines.dsh is a union.
  assert.equal(satisfies(rc5, '>=0.2.1 <0.3.0'), false)
  assert.equal(satisfies(rc22, '>=0.2.1 <0.3.0'), false)
  // Each clause admits its own tuple only.
  assert.equal(satisfies(rc5, '>=0.2.1-0 <0.3.0'), true)
  assert.equal(satisfies(rc22, '>=0.2.1-0 <0.3.0'), false)
  assert.equal(satisfies(rc22, '>=0.2.2-0 <0.3.0'), true)
  // And a future minor's prerelease stays out.
  assert.equal(satisfies(parseVersion('0.3.0-rc.1'), '>=0.2.2-0 <0.3.0'), false)
})
