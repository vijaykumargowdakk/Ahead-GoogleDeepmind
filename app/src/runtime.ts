/** SDK core: deliberately framework-independent and safe to embed in a native shell. */
export type ActionDef = {
  id: string
  targetScreen: string
  apiCalls: { method: 'GET'; path: string }[]
  speculatable: boolean
}

export type PredictContext = {
  screenId: string
  legalActionIds: string[]
  dayOfMonth: number
  historySummary: string
  recentTaps: string[]
  networkRttMs: number
}

export type Prediction = {
  ranked: { actionId: string; confidence: number }[]
  latencyMs: number
  source: 'gemma' | 'heuristic'
}

export interface Predictor { predict(context: PredictContext): Promise<Prediction> }

export class HeuristicPredictor implements Predictor {
  async predict(context: PredictContext): Promise<Prediction> {
    const electric = context.legalActionIds.find(id => id.includes('electricity'))
    const preferred = context.dayOfMonth <= 4 && electric ? electric : context.legalActionIds[0]
    const ranked = context.legalActionIds.map(id => ({ actionId: id, confidence: id === preferred ? 0.82 : 0.18 / Math.max(context.legalActionIds.length - 1, 1) }))
    return { ranked, latencyMs: 0, source: 'heuristic' }
  }
}

export class GemmaPredictor implements Predictor {
  constructor(private fallback: Predictor, private endpoint = 'http://localhost:11434/api/chat') {}
  async predict(context: PredictContext): Promise<Prediction> {
    const started = performance.now()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 2500)
    try {
      const prompt = `Rank legal next actions. Return JSON only: [{"actionId":"...","confidence":0.0}]. Screen: ${context.screenId}. Legal: ${context.legalActionIds.join(', ')}. Day: ${context.dayOfMonth}. History: ${context.historySummary}. Recent: ${context.recentTaps.join(', ')}. RTT: ${context.networkRttMs}ms.`
      const response = await fetch(this.endpoint, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gemma4:e2b-it-qat', stream: false, options: { temperature: 0 }, messages: [{ role: 'system', content: 'Respond only with valid JSON.' }, { role: 'user', content: prompt }] }) })
      const payload = await response.json() as { message?: { content?: string } }
      const raw = payload.message?.content?.replace(/```json|```/g, '').trim() ?? ''
      const ranked = JSON.parse(raw) as Prediction['ranked']
      if (!Array.isArray(ranked) || ranked.some(p => !context.legalActionIds.includes(p.actionId) || !Number.isFinite(p.confidence))) throw new Error('invalid model contract')
      const total = ranked.reduce((sum, item) => sum + item.confidence, 0)
      if (total <= 0) throw new Error('empty confidences')
      return { ranked: ranked.map(item => ({ ...item, confidence: item.confidence / total })), latencyMs: Math.round(performance.now() - started), source: 'gemma' }
    } catch {
      return this.fallback.predict(context)
    } finally { window.clearTimeout(timeout) }
  }
}

export class ShadowRuntime<T> {
  private branches = new Map<string, { controller: AbortController; staged: T }>()
  speculate(branchId: string, action: ActionDef, staged: T) {
    if (!action.speculatable) throw new Error(`Safety boundary: ${action.id} is commit_only`)
    const controller = new AbortController()
    this.branches.set(branchId, { controller, staged })
    return controller.signal
  }
  commit(branchId: string): T | undefined { const branch = this.branches.get(branchId); this.branches.delete(branchId); return branch?.staged }
  rollback(branchId: string): boolean { const branch = this.branches.get(branchId); if (!branch) return false; branch.controller.abort(); this.branches.delete(branchId); return true }
}
