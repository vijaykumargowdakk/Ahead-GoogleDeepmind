import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ShadowRuntime, type ActionDef } from '../src/runtime.ts'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const serverSource = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')

test('irreversible actions are commit-only and have no speculative API path', () => {
  for (const actionId of ['pay_now', 'confirm_transfer']) {
    const declaration = appSource.split('\n').find(line => line.includes(`id: '${actionId}'`))
    assert.ok(declaration, `${actionId} must exist in the action graph`)
    assert.match(declaration, /speculatable: false/)
    assert.doesNotMatch(declaration, /apiPath:/)
  }
})

test('SDK shadow runtime rejects a commit-only action', () => {
  const runtime = new ShadowRuntime({ prepared: true })
  const payment: ActionDef = { id: 'pay_now', targetScreen: 'receipt', apiCalls: [], speculatable: false }
  assert.throws(() => runtime.speculate('B-PAY', payment, { prepared: true }), /commit_only/)
})

test('payment endpoint accepts only explicit POST requests', () => {
  assert.match(serverSource, /req\.method === 'POST' && url\.pathname === '\/api\/pay'/)
  assert.doesNotMatch(serverSource, /payloads\['\/api\/pay'\]/)
})

test('network simulation is deterministic and speculative traffic is marked', () => {
  assert.doesNotMatch(serverSource, /Math\.random/)
  assert.match(appSource, /'X-Speculative': '1'/)
})
