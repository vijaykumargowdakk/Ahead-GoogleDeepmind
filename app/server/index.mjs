import { createServer } from 'node:http'

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const requestedModel = process.env.AHEAD_MODEL || 'gemma4:e2b-it-qat'
const modelTimeoutMs = Number(process.env.AHEAD_MODEL_TIMEOUT_MS || 12000)
const delays = { good: 250, congested: 2500, terrible: 5000 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const payloads = {
  '/api/super/home': { modules: ['utilities', 'food', 'shopping', 'orders'], cachedAt: 'edge-shadow' },
  '/api/super/utilities': { due: [{ provider: 'BESCOM', amount: 1248 }, { provider: 'BWSSB', amount: 438 }, { provider: 'Airtel Fiber', amount: 999 }], bytes: 18240 },
  '/api/super/food': { hourSignal: 'lunch_window', reorder: { restaurant: 'Green Bowl', item: 'Paneer power bowl', etaMin: 24 }, nearby: 18 },
  '/api/super/shop': { deals: [{ sku: 'buds-pro', discount: 42 }, { sku: 'desk-lamp', discount: 28 }], cartItems: 1 },
  '/api/super/orders': { orders: [{ id: 'ORD-2048', status: 'out_for_delivery' }, { id: 'BILL-7784', status: 'paid_last_month' }] },
  '/api/bills/electricity': { provider: 'BESCOM', account: '7784', amount: 1248, dueDate: '2026-07-14', bytes: 11842 },
  '/api/bills/water': { provider: 'BWSSB', account: '2201', amount: 438, dueDate: '2026-07-18', bytes: 8210 },
  '/api/bills/internet': { provider: 'Airtel Fiber', plan: '300 Mbps', amount: 999, renewsOn: '2026-07-15', bytes: 10422 },
  '/api/bills/gas': { provider: 'Indane', refill: '14.2kg cylinder', amount: 915, earliestSlot: 'Tomorrow 10 AM', bytes: 9144 },
  '/api/review/electricity': { merchant: 'BESCOM', amount: 1248, fee: 0, commitOnly: true },
  '/api/review/water': { merchant: 'BWSSB', amount: 438, fee: 0, commitOnly: true },
  '/api/review/internet': { merchant: 'Airtel Fiber', amount: 999, fee: 0, commitOnly: true },
  '/api/review/gas': { merchant: 'Indane Gas', amount: 915, fee: 0, commitOnly: true },
  '/api/food/reorder': { restaurant: 'Green Bowl', items: ['Paneer power bowl', 'Lime soda'], total: 342, etaMin: 24 },
  '/api/food/nearby': { restaurants: [{ name: 'Green Bowl', etaMin: 24 }, { name: 'Dosa Lab', etaMin: 19 }, { name: 'Noodle Bar', etaMin: 31 }] },
  '/api/food/cart': { items: ['Paneer power bowl'], subtotal: 298, surge: 0 },
  '/api/review/food': { merchant: 'Green Bowl', amount: 342, fee: 12, commitOnly: true },
  '/api/shop/deals': { deals: [{ title: 'Earbuds Pro', price: 2499, discount: 42 }, { title: 'Desk Lamp', price: 1199, discount: 28 }] },
  '/api/shop/search': { query: 'recent interests', results: ['USB-C hub', 'Desk lamp', 'Running shoes'] },
  '/api/review/deal': { merchant: 'AHEAD Mall', amount: 2499, fee: 0, commitOnly: true },
  '/api/receipts': { receipts: [{ id: 'rcpt-0626', provider: 'BESCOM', amount: 1197, paidAt: '2026-06-02' }] },
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' })
  res.end(JSON.stringify(body))
}
const body = req => new Promise((resolve, reject) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk; if (raw.length > 50_000) reject(new Error('body too large')) })
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch (error) { reject(error) } })
})
const normalize = ranked => {
  const total = ranked.reduce((sum, item) => sum + Number(item.confidence || 0), 0)
  return ranked.sort((a, b) => b.confidence - a.confidence).map(item => ({ ...item, confidence: item.confidence / total }))
}
const heuristic = context => {
  const electrical = context.legalActionIds.find(id => id.includes('electricity'))
  const food = context.legalActionIds.find(id => id.includes('food') || id.includes('lunch'))
  const habitual = [...context.legalActionIds].sort((a, b) => {
    const left = Number((context.historySummary || '').match(new RegExp(`${a}=(\\d+)`))?.[1] || 0)
    const right = Number((context.historySummary || '').match(new RegExp(`${b}=(\\d+)`))?.[1] || 0)
    return right - left
  })[0]
  const review = context.legalActionIds.find(id => id.includes('review'))
  const preferred = review || ((context.hourOfDay || 0) >= 11 && (context.hourOfDay || 0) <= 14 && food) || ((context.historySummary || '').includes(`${habitual}=`) && habitual) || (context.dayOfMonth <= 4 && electrical) || context.legalActionIds[0]
  return normalize(context.legalActionIds.map(id => ({ actionId: id, confidence: id === preferred ? .82 : .18 / Math.max(context.legalActionIds.length - 1, 1) })))
}
async function availableModels() {
  try {
    const result = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1000) }).then(r => r.json())
    return result.models?.map(item => item.name) || []
  } catch { return [] }
}
async function chooseModel() {
  const models = await availableModels()
  if (models.includes(requestedModel)) return requestedModel
  return models.find(name => name.startsWith('gemma4:')) || models.find(name => name.startsWith('gemma3:')) || null
}

async function predict(context) {
  const fallback = { ranked: heuristic(context), latencyMs: 0, source: 'heuristic', model: null }
  const model = await chooseModel()
  if (!model) return fallback
  const started = performance.now()
  try {
    const response = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST', signal: AbortSignal.timeout(modelTimeoutMs), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, think: false, keep_alive: '20m', format: 'json',
        options: { temperature: 0, num_predict: 80, num_ctx: 1024 },
        messages: [
          { role: 'system', content: 'You are the intent predictor inside a mobile speculative execution runtime. Return JSON only: {"rankedActionIds":["exact_id"]}. Use only legal IDs. Rank by what the user is likely to tap next from the current screen. Strong signals: repeated local tap history, hour-of-day context, bill due dates, and action hints. Include every legal ID exactly once if possible.' },
          { role: 'user', content: `Current screen=${context.screenId}. Legal actions with hints=${(context.legalActionHints || context.legalActionIds).join(' | ')}. hour=${context.hourOfDay}; day=${context.dayOfMonth}; local behavior=${context.historySummary}; recent taps=${context.recentTaps.join(',') || 'none'}; network=${context.networkRttMs}ms. Rank next tap IDs, most likely first.` }
        ]
      })
    })
    if (!response.ok) throw new Error(`Ollama ${response.status}`)
    const data = await response.json()
    const parsed = JSON.parse(data.message.content)
    const legal = new Set(context.legalActionIds)
    if (!Array.isArray(parsed.rankedActionIds) || parsed.rankedActionIds.length < 1 || new Set(parsed.rankedActionIds).size !== parsed.rankedActionIds.length || parsed.rankedActionIds.some(id => !legal.has(id))) throw new Error('contract violation')
    // Some small models confidently return only the top choice. Preserve that
    // reasoning and deterministically append the remaining declared actions.
    const completeOrder = [...parsed.rankedActionIds, ...context.legalActionIds.filter(id => !parsed.rankedActionIds.includes(id))]
    const ranked = normalize(completeOrder.map((actionId, index) => ({ actionId, confidence: Math.pow(.35, index) })))
    return { ranked, latencyMs: Math.round(performance.now() - started), source: model.startsWith('gemma4') ? 'gemma4' : 'gemma3', model, raw: data.message.content }
  } catch (error) {
    return { ...fallback, latencyMs: Math.round(performance.now() - started), fallbackReason: error.name === 'TimeoutError' ? 'model_timeout' : `model_error:${error.message}` }
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {})
  const url = new URL(req.url, 'http://127.0.0.1')
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const model = await chooseModel()
      return json(res, 200, { ok: true, ollama: Boolean(model), model, requestedModel, mode: model ? 'local-model' : 'heuristic', modelTimeoutMs })
    }
    if (req.method === 'POST' && url.pathname === '/api/predict') return json(res, 200, await predict(await body(req)))
    if (req.method === 'GET' && payloads[url.pathname]) {
      const network = url.searchParams.get('network') in delays ? url.searchParams.get('network') : 'congested'
      const jitter = Math.round(delays[network] * (.88 + Math.random() * .24)); await sleep(jitter)
      return json(res, 200, { ...payloads[url.pathname], latencyMs: jitter, shadowSafe: true, servedFrom: 'simulated-mobile-api' })
    }
    if (req.method === 'POST' && url.pathname === '/api/pay') return json(res, 200, { receiptId: `AHD-${Date.now()}`, status: 'paid', humanConfirmed: true })
    return json(res, 404, { error: 'not_found' })
  } catch (error) { return json(res, 500, { error: error.message }) }
})

server.listen(Number(process.env.PORT || 8787), '127.0.0.1', () => console.log('AHEAD API listening at http://127.0.0.1:8787'))
