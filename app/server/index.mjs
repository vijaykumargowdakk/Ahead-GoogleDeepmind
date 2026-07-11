import { createServer } from 'node:http'

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const requestedModel = process.env.AHEAD_MODEL || 'gemma4:e2b-it-qat'
const modelTimeoutMs = Number(process.env.AHEAD_MODEL_TIMEOUT_MS || 12000)
const delays = { good: 250, congested: 2500, terrible: 5000 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
  const review = context.legalActionIds.find(id => id.includes('review'))
  const preferred = review || (context.dayOfMonth <= 4 && electrical) || context.legalActionIds[0]
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
          { role: 'system', content: 'Return JSON only: {"rankedActionIds":["exact_id"]}. Include every legal ID exactly once from most to least likely. Never invent IDs.' },
          { role: 'user', content: `Screen=${context.screenId}; legal=${context.legalActionIds.join(',')}; day=${context.dayOfMonth}; history=${context.historySummary}; recent=${context.recentTaps.join(',') || 'none'}; rtt=${context.networkRttMs}ms. Rank likely next tap.` }
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
    return { ranked, latencyMs: Math.round(performance.now() - started), source: model.startsWith('gemma4') ? 'gemma4' : 'gemma3', model }
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
    if (req.method === 'GET' && url.pathname === '/api/bills/electricity') {
      const network = url.searchParams.get('network') in delays ? url.searchParams.get('network') : 'congested'
      const jitter = Math.round(delays[network] * (.9 + Math.random() * .2)); await sleep(jitter)
      return json(res, 200, { provider: 'BESCOM', account: '7784', amount: 1248, dueDate: '2026-07-14', latencyMs: jitter, bytes: 11842 })
    }
    if (req.method === 'GET' && url.pathname === '/api/receipts') {
      const network = url.searchParams.get('network') in delays ? url.searchParams.get('network') : 'congested'; await sleep(delays[network])
      return json(res, 200, { receipts: [{ id: 'rcpt-0626', provider: 'BESCOM', amount: 1197, paidAt: '2026-06-02' }] })
    }
    if (req.method === 'POST' && url.pathname === '/api/pay') return json(res, 200, { receiptId: `AHD-${Date.now()}`, status: 'paid', humanConfirmed: true })
    return json(res, 404, { error: 'not_found' })
  } catch (error) { return json(res, 500, { error: error.message }) }
})

server.listen(Number(process.env.PORT || 8787), '127.0.0.1', () => console.log('AHEAD API listening at http://127.0.0.1:8787'))
