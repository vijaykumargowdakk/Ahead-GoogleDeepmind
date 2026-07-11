import assert from 'node:assert/strict'
import test from 'node:test'
import { measuredSavings, resolveTap } from '../src/runtime.ts'

test('ready matching branch commits atomically', () => {
  assert.equal(resolveTap({ ahead: true, actionId: 'open_food_app', branchActionId: 'open_food_app', branchState: 'ready', shadowReady: true }), 'commit')
})

test('matching tap during staging joins the existing request', () => {
  assert.equal(resolveTap({ ahead: true, actionId: 'open_food_app', branchActionId: 'open_food_app', branchState: 'speculating', shadowReady: false }), 'join')
})

test('wrong tap rolls back the active branch', () => {
  assert.equal(resolveTap({ ahead: true, actionId: 'open_banking_app', branchActionId: 'open_food_app', branchState: 'ready', shadowReady: true }), 'rollback')
})

test('AHEAD off always uses the baseline path', () => {
  assert.equal(resolveTap({ ahead: false, actionId: 'open_food_app', branchActionId: 'open_food_app', branchState: 'ready', shadowReady: true }), 'baseline')
})

test('saved-time metrics use measured latency and never go negative', () => {
  assert.equal(measuredSavings(3000, 12), 2988)
  assert.equal(measuredSavings(8, 12), 0)
})

