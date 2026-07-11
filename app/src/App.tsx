import { useEffect, useRef, useState } from 'react'
import './index.css'

type Network = 'good' | 'congested' | 'terrible'
type Screen = 'home' | 'electricity' | 'summary' | 'receipt'
type EventType = 'prediction_made' | 'speculation_started' | 'branch_committed' | 'branch_rolled_back' | 'boundary_blocked'
type Telemetry = { type: EventType; detail: string; time: string }
type Action = { id: string; label: string; screen: Screen; speculatable: boolean; icon: string }
type UserPattern = { tapCounts: Record<string, number>; recentTaps: string[]; totalTaps: number }

const graph: Record<Screen, Action[]> = {
  home: [
    { id: 'open_electricity_bill', label: 'Electricity', screen: 'electricity', speculatable: true, icon: '⚡' },
    { id: 'open_mobile_recharge', label: 'Mobile recharge', screen: 'receipt', speculatable: true, icon: '◉' },
    { id: 'open_water_bill', label: 'Water bill', screen: 'receipt', speculatable: true, icon: '◌' },
    { id: 'open_receipts', label: 'Receipts', screen: 'receipt', speculatable: true, icon: '▤' },
  ],
  electricity: [
    { id: 'review_payment', label: 'Review payment', screen: 'summary', speculatable: true, icon: '→' },
    { id: 'open_receipts', label: 'Past receipts', screen: 'receipt', speculatable: true, icon: '▤' },
  ],
  summary: [{ id: 'pay_bill', label: 'Pay ₹1,248', screen: 'receipt', speculatable: false, icon: '✓' }],
  receipt: [{ id: 'back_home', label: 'Back to home', screen: 'home', speculatable: true, icon: '←' }],
}

const latency: Record<Network, number> = { good: 250, congested: 2500, terrible: 5000 }
const title: Record<Screen, string> = { home: 'Good morning, Priya', electricity: 'Electricity bill', summary: 'Payment summary', receipt: 'Activity' }
const emptyPattern: UserPattern = { tapCounts: {}, recentTaps: ['app_opened'], totalTaps: 0 }

function readPattern(): UserPattern {
  try {
    const parsed = JSON.parse(localStorage.getItem('ahead.userPattern') || 'null')
    if (parsed && typeof parsed === 'object' && parsed.tapCounts && Array.isArray(parsed.recentTaps)) return parsed
  } catch { /* corrupt local pattern should never break the demo */ }
  return emptyPattern
}

function describePattern(pattern: UserPattern) {
  const top = Object.entries(pattern.tapCounts).sort((a, b) => b[1] - a[1]).slice(0, 3)
  if (!top.length) return 'new user; no completed taps yet'
  return `observed ${pattern.totalTaps} taps; strongest habits: ${top.map(([id, count]) => `${id}=${count}`).join(', ')}`
}

function nextPattern(pattern: UserPattern, actionId: string): UserPattern {
  return {
    tapCounts: { ...pattern.tapCounts, [actionId]: (pattern.tapCounts[actionId] || 0) + 1 },
    recentTaps: [actionId, ...pattern.recentTaps].slice(0, 6),
    totalTaps: pattern.totalTaps + 1,
  }
}

function fallbackPrediction(screen: Screen, forcedWrong: boolean) {
  const actions = graph[screen]
  const habitual = screen === 'home' ? 'open_electricity_bill' : screen === 'electricity' ? 'review_payment' : actions[0].id
  const pick = forcedWrong && actions.length > 1 ? actions.find(a => a.id !== habitual)!.id : habitual
  return actions.map(action => ({ actionId: action.id, confidence: action.id === pick ? 0.82 : +(0.18 / Math.max(actions.length - 1, 1)).toFixed(2) }))
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [ahead, setAhead] = useState(true)
  const [network, setNetwork] = useState<Network>('terrible')
  const [forceWrong, setForceWrong] = useState(false)
  const [branch, setBranch] = useState<{ id: string; actionId: string; state: 'idle' | 'speculating' | 'committed' | 'rolledback' }>({ id: '—', actionId: '—', state: 'idle' })
  const [events, setEvents] = useState<Telemetry[]>([])
  const [saved, setSaved] = useState(0)
  const [hits, setHits] = useState(0)
  const [misses, setMisses] = useState(0)
  const [loading, setLoading] = useState(false)
  const [prediction, setPrediction] = useState(() => fallbackPrediction('home', false))
  const [predictor, setPredictor] = useState({ source: 'connecting', model: 'Detecting Ollama…', latencyMs: 0 })
  const [pattern, setPattern] = useState<UserPattern>(() => readPattern())
  const timer = useRef<number | undefined>(undefined)
  const branchId = useRef(0)
  const speculativeRequest = useRef<AbortController | null>(null)

  const log = (type: EventType, detail: string) => setEvents(prev => [{ type, detail, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }, ...prev].slice(0, 6))
  const predictedId = prediction[0]?.actionId

  useEffect(() => {
    window.clearTimeout(timer.current)
    speculativeRequest.current?.abort()
    let cancelled = false
    const run = async () => {
      const context = { screenId: screen, legalActionIds: graph[screen].map(action => action.id), dayOfMonth: 2, historySummary: describePattern(pattern), recentTaps: pattern.recentTaps, networkRttMs: latency[network] }
      let ranked = fallbackPrediction(screen, forceWrong)
      let source = 'heuristic'; let model = 'local heuristic'; let latencyMs = 0
      try {
        const response = await fetch('/api/predict', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(context), signal: AbortSignal.timeout(15000) })
        if (!response.ok) throw new Error('predictor unavailable')
        const result = await response.json() as { ranked: typeof ranked; source: string; model?: string; latencyMs: number }
        ranked = [...result.ranked].sort((a, b) => b.confidence - a.confidence)
        source = result.source; model = result.model ?? 'local heuristic'; latencyMs = result.latencyMs
        if (forceWrong && ranked.length > 1) {
          const firstId = ranked[0].actionId
          ranked[0] = { ...ranked[0], actionId: ranked[1].actionId }
          ranked[1] = { ...ranked[1], actionId: firstId }
        }
      } catch { /* reliability floor: deterministic local predictor */ }
      if (cancelled) return
      setPrediction(ranked); setPredictor({ source, model, latencyMs })
      if (!ahead) return
      const chosen = ranked[0]
      const action = graph[screen].find(item => item.id === chosen.actionId)
      if (!action?.speculatable || chosen.confidence < .5 || network === 'good') return
      const id = `B-${String(++branchId.current).padStart(3, '0')}`
      setBranch({ id, actionId: chosen.actionId, state: 'speculating' })
      log('prediction_made', `${model} ranked ${chosen.actionId} · ${Math.round(chosen.confidence * 100)}%`)
      log('speculation_started', `${id} staged APIs in isolated shadow state`)
      const controller = new AbortController(); speculativeRequest.current = controller
      const path = chosen.actionId.includes('receipt') ? '/api/receipts' : '/api/bills/electricity'
      fetch(`${path}?network=${network}`, { signal: controller.signal }).catch(() => undefined)
    }
    run()
    return () => { cancelled = true; speculativeRequest.current?.abort(); window.clearTimeout(timer.current) }
    // predictor is intentionally re-run on every screen transition
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, ahead, network, forceWrong, pattern])

  const navigate = (action: Action) => {
    const updatedPattern = nextPattern(pattern, action.id)
    localStorage.setItem('ahead.userPattern', JSON.stringify(updatedPattern))
    setPattern(updatedPattern)
    if (!action.speculatable) {
      log('boundary_blocked', 'COMMIT_ONLY: payment requires a human tap')
      setBranch(b => ({ ...b, state: 'idle' }))
      setLoading(true)
      fetch('/api/pay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: 1248, provider: 'BESCOM', humanConfirmed: true }) })
        .finally(() => { timer.current = window.setTimeout(() => { setLoading(false); setScreen('receipt') }, 500) })
      return
    }
    const hit = ahead && action.id === predictedId && branch.state === 'speculating'
    if (hit) {
      setBranch(b => ({ ...b, state: 'committed' }))
      setHits(v => v + 1); setSaved(v => v + latency[network])
      log('branch_committed', `${branch.id} atomically promoted · ${latency[network] / 1000}s saved`)
      setScreen(action.screen)
    } else {
      if (ahead) { setBranch(b => ({ ...b, state: 'rolledback' })); setMisses(v => v + 1); log('branch_rolled_back', `${branch.id} discarded · requests aborted · 0 side effects`) }
      setLoading(true)
      timer.current = window.setTimeout(() => { setLoading(false); setScreen(action.screen) }, latency[network])
    }
  }

  const score = hits + misses ? Math.round((hits / (hits + misses)) * 100) : 100
  const actionCards = graph[screen]
  return <main>
    <header><div className="brand"><span>A</span>AHEAD <em>SPECULATIVE RUNTIME</em></div><div className="offline">● LOCAL-FIRST · OFFLINE READY</div></header>
    <section className="layout">
      <article className="phone"><div className="notch" /><div className="phone-top"><small>9:41</small><b>● ● ●</b></div>
        <div className="app-head"><span className="avatar">P</span><div><small>AHEAD PAY</small><h2>{title[screen]}</h2></div><span>⌁</span></div>
        {loading ? <div className="spinner"><i /> Loading on {network} network…</div> : <div className="phone-content">
          {screen === 'home' && <><div className="balance"><small>THIS MONTH'S BILLS</small><strong>₹ 1,248.00</strong><p>Due in 3 days</p></div><p className="section-label">PAY OR RECHARGE</p>{actionCards.map(a => <button className="service" key={a.id} onClick={() => navigate(a)}><span className="service-icon">{a.icon}</span><span>{a.label}<small>{a.id === 'open_electricity_bill' ? '₹1,248 due Jul 14' : 'Quick & secure'}</small></span><b>›</b></button>)}</>}
          {screen === 'electricity' && <><div className="bill-card"><span>⚡</span><small>BESCOM · ACCOUNT 7784</small><strong>₹ 1,248.00</strong><p>July 2026 · Due Jul 14</p></div><p className="hint">Your bill is ready. AHEAD has safely prepared the next screen.</p>{actionCards.map(a => <button className="primary" key={a.id} onClick={() => navigate(a)}>{a.label} <b>→</b></button>)}</>}
          {screen === 'summary' && <><div className="summary"><small>PAYING TO</small><h3>Bangalore Electricity Supply Co.</h3><hr/><div><span>Bill amount</span><b>₹1,248.00</b></div><div><span>Convenience fee</span><b>₹0</b></div><hr/><div className="total"><span>Total</span><b>₹1,248.00</b></div></div><p className="boundary">HUMAN CONFIRMATION REQUIRED</p><button className="pay" onClick={() => navigate(actionCards[0])}>Pay ₹1,248 <span>↗</span></button></>}
          {screen === 'receipt' && <><div className="receipt"><span>✓</span><h2>Payment complete</h2><strong>₹1,248.00</strong><p>BESCOM · Jul 11, 2026</p></div><button className="primary" onClick={() => navigate(actionCards[0])}>Back to home</button></>}
        </div>}<nav><span>⌂<small>Home</small></span><span>◫<small>History</small></span><span>◉<small>Profile</small></span></nav>
      </article>
      <aside className="dash"><div className="eyebrow">LIVE RUNTIME INSTRUMENTATION</div><h1>Waiting eliminated <span>{(saved / 1000).toFixed(1)}s</span></h1><p className="sub">A CPU branch predictor, applied to human interaction.</p>
        <div className="grid stats"><div><small>PREDICTOR</small><b>{predictor.source === 'gemma4' ? 'Gemma 4' : predictor.source === 'gemma3' ? 'Gemma 3' : 'Heuristic'}</b><em>LOCAL · {predictor.latencyMs}ms</em></div><div><small>NETWORK RTT</small><b>{latency[network]}ms</b><em className={network}>● {network.toUpperCase()}</em></div><div><small>HIT RATE</small><b>{score}%</b><em>{hits} hits · {misses} misses</em></div></div>
        <section className="panel"><div className="panel-title"><span>INTENT PREDICTION</span><small>SCREEN: {screen.toUpperCase()}</small></div>{prediction.map(p => <div className="prediction" key={p.actionId}><div><b>{graph[screen].find(a => a.id === p.actionId)?.label}</b><span>{Math.round(p.confidence * 100)}%</span></div><i><u style={{ width: `${p.confidence * 100}%` }} /></i></div>)}</section>
        <section className="panel"><div className="panel-title"><span>LOCAL USER PATTERN</span><small>{pattern.totalTaps} taps learned</small></div><p className="pattern-copy">{describePattern(pattern)}</p><p className="pattern-copy">Recent: {pattern.recentTaps.join(' → ')}</p></section>
        <section className="panel lifecycle"><div className="panel-title"><span>BRANCH LIFECYCLE</span><small>{branch.id}</small></div><div className="steps"><b className="done">1<br/><small>PREDICTED</small></b><i/><b className={branch.state !== 'idle' ? 'done' : ''}>2<br/><small>SHADOW</small></b><i/><b className={branch.state === 'committed' ? 'green' : branch.state === 'rolledback' ? 'red' : ''}>3<br/><small>{branch.state === 'rolledback' ? 'ROLLED BACK' : branch.state === 'committed' ? 'COMMITTED' : 'CHECK'}</small></b></div>{branch.state === 'rolledback' && <p className="rollback">↶ ROLLED BACK · requests aborted · 0 side effects</p>}{branch.state === 'committed' && <p className="commit">✓ ATOMIC COMMIT · screen swapped instantly</p>}</section>
        <section className="panel events"><div className="panel-title"><span>EVENT STREAM</span><small>typed telemetry</small></div>{events.length ? events.map((e, i) => <p key={i}><time>{e.time}</time><b>{e.type}</b>{e.detail}</p>) : <p>Runtime standing by…</p>}</section>
        <section className="controls"><label><input type="checkbox" checked={ahead} onChange={e => setAhead(e.target.checked)} /><span>AHEAD {ahead ? 'ON' : 'OFF'}</span></label><select value={network} onChange={e => setNetwork(e.target.value as Network)}><option value="good">Good · 250ms</option><option value="congested">Congested · 2.5s</option><option value="terrible">Terrible · 5s</option></select><button onClick={() => setForceWrong(v => !v)} className={forceWrong ? 'wrong active' : 'wrong'}>⚠ Force wrong prediction</button></section>
      </aside>
    </section><footer><span>SAFE BY CONSTRUCTION</span> · Actions are declared <code>speculatable</code> or <code>commit_only</code>. The shadow executor cannot cross the payment boundary.</footer>
  </main>
}
