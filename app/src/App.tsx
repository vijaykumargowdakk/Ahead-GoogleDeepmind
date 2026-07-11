import { useEffect, useMemo, useRef, useState } from 'react'
import './index.css'

type Network = 'good' | 'congested' | 'terrible'
type Screen = 'home' | 'utilities' | 'electricity' | 'water' | 'internet' | 'gas' | 'food' | 'cart' | 'shop' | 'deals' | 'orders' | 'summary' | 'receipt'
type EventType = 'prediction_made' | 'speculation_started' | 'shadow_hydrated' | 'branch_committed' | 'branch_rolled_back' | 'boundary_blocked'
type Telemetry = { type: EventType; detail: string; time: string }
type Action = { id: string; label: string; screen: Screen; speculatable: boolean; icon: string; apiPath?: string; subtitle?: string }
type Ranked = { actionId: string; confidence: number }
type UserPattern = { tapCounts: Record<string, number>; recentTaps: string[]; totalTaps: number }
type ShadowPayload = { branchId: string; actionId: string; path: string; ready: boolean; payload: unknown; latencyMs: number }
type Inspector = {
  systemPrompt: string
  userPrompt: string
  context: Record<string, unknown>
  raw: string
  fallbackReason?: string
}

const graph: Record<Screen, Action[]> = {
  home: [
    { id: 'open_utilities', label: 'Utilities', screen: 'utilities', speculatable: true, icon: '⚡', apiPath: '/api/super/utilities', subtitle: 'Bills due, usage, providers' },
    { id: 'open_food', label: 'Lunch run', screen: 'food', speculatable: true, icon: '🍱', apiPath: '/api/super/food', subtitle: 'Reorder and nearby food' },
    { id: 'open_shop', label: 'Daily deals', screen: 'shop', speculatable: true, icon: '🛒', apiPath: '/api/super/shop', subtitle: 'Offers, orders, cart' },
    { id: 'open_orders', label: 'Orders', screen: 'orders', speculatable: true, icon: '▤', apiPath: '/api/super/orders', subtitle: 'Receipts and tracking' },
  ],
  utilities: [
    { id: 'open_electricity_bill', label: 'Electricity', screen: 'electricity', speculatable: true, icon: '⚡', apiPath: '/api/bills/electricity', subtitle: 'BESCOM due Jul 14' },
    { id: 'open_water_bill', label: 'Water', screen: 'water', speculatable: true, icon: '◌', apiPath: '/api/bills/water', subtitle: 'BWSSB due Jul 18' },
    { id: 'open_internet_bill', label: 'Internet', screen: 'internet', speculatable: true, icon: '⌁', apiPath: '/api/bills/internet', subtitle: 'Fiber renewal' },
    { id: 'open_gas_bill', label: 'Gas', screen: 'gas', speculatable: true, icon: '▲', apiPath: '/api/bills/gas', subtitle: 'Cylinder refill' },
  ],
  electricity: [
    { id: 'review_electricity_payment', label: 'Review payment', screen: 'summary', speculatable: true, icon: '→', apiPath: '/api/review/electricity', subtitle: 'Prepare checkout' },
    { id: 'open_receipts', label: 'Past receipts', screen: 'orders', speculatable: true, icon: '▤', apiPath: '/api/receipts', subtitle: 'Payment history' },
  ],
  water: [{ id: 'review_water_payment', label: 'Review water bill', screen: 'summary', speculatable: true, icon: '→', apiPath: '/api/review/water', subtitle: 'Prepare checkout' }],
  internet: [{ id: 'review_internet_payment', label: 'Renew plan', screen: 'summary', speculatable: true, icon: '→', apiPath: '/api/review/internet', subtitle: 'Prepare checkout' }],
  gas: [{ id: 'review_gas_payment', label: 'Book refill', screen: 'summary', speculatable: true, icon: '→', apiPath: '/api/review/gas', subtitle: 'Prepare checkout' }],
  food: [
    { id: 'reorder_lunch', label: 'Reorder lunch', screen: 'cart', speculatable: true, icon: '↻', apiPath: '/api/food/reorder', subtitle: 'Paneer bowl from yesterday' },
    { id: 'browse_nearby_food', label: 'Browse nearby', screen: 'cart', speculatable: true, icon: '⌖', apiPath: '/api/food/nearby', subtitle: 'Fast restaurants' },
    { id: 'open_food_cart', label: 'Cart', screen: 'cart', speculatable: true, icon: '◫', apiPath: '/api/food/cart', subtitle: 'Ready to checkout' },
  ],
  cart: [{ id: 'checkout_food', label: 'Checkout lunch', screen: 'summary', speculatable: true, icon: '→', apiPath: '/api/review/food', subtitle: 'Prepare payment' }],
  shop: [
    { id: 'open_daily_deals', label: 'Daily deals', screen: 'deals', speculatable: true, icon: '%', apiPath: '/api/shop/deals', subtitle: 'Personalized offers' },
    { id: 'search_products', label: 'Search products', screen: 'deals', speculatable: true, icon: '⌕', apiPath: '/api/shop/search', subtitle: 'Recent interests' },
    { id: 'open_shop_orders', label: 'Orders', screen: 'orders', speculatable: true, icon: '▤', apiPath: '/api/super/orders', subtitle: 'Track shipments' },
  ],
  deals: [{ id: 'buy_daily_deal', label: 'Buy deal', screen: 'summary', speculatable: true, icon: '→', apiPath: '/api/review/deal', subtitle: 'Prepare checkout' }],
  orders: [{ id: 'back_home', label: 'Back home', screen: 'home', speculatable: true, icon: '←', apiPath: '/api/super/home', subtitle: 'Return to start' }],
  summary: [{ id: 'pay_now', label: 'Confirm payment', screen: 'receipt', speculatable: false, icon: '✓', subtitle: 'Human boundary' }],
  receipt: [{ id: 'back_home', label: 'Back home', screen: 'home', speculatable: true, icon: '←', apiPath: '/api/super/home', subtitle: 'Return to start' }],
}

const latency: Record<Network, number> = { good: 250, congested: 2500, terrible: 5000 }
const title: Record<Screen, string> = {
  home: 'AHEAD Super App',
  utilities: 'Utilities',
  electricity: 'Electricity bill',
  water: 'Water bill',
  internet: 'Internet plan',
  gas: 'Gas refill',
  food: 'Lunch delivery',
  cart: 'Smart cart',
  shop: 'Shopping',
  deals: 'Daily deals',
  orders: 'Orders',
  summary: 'Commit boundary',
  receipt: 'Receipt',
}

const emptyPattern: UserPattern = { tapCounts: {}, recentTaps: ['app_opened'], totalTaps: 0 }
const systemPrompt = 'Return JSON only: {"rankedActionIds":["exact_id"]}. Include every legal ID exactly once from most to least likely. Never invent IDs.'
const nodePos: Partial<Record<Screen, { x: number; y: number }>> = {
  home: { x: 60, y: 126 },
  utilities: { x: 190, y: 60 },
  food: { x: 190, y: 126 },
  shop: { x: 190, y: 192 },
  electricity: { x: 336, y: 36 },
  water: { x: 336, y: 84 },
  cart: { x: 336, y: 138 },
  deals: { x: 336, y: 202 },
  summary: { x: 480, y: 126 },
  receipt: { x: 610, y: 126 },
}

function readPattern(): UserPattern {
  try {
    const parsed = JSON.parse(localStorage.getItem('ahead.userPattern') || 'null')
    if (parsed && typeof parsed === 'object' && parsed.tapCounts && Array.isArray(parsed.recentTaps)) return parsed
  } catch { /* local memory is optional */ }
  return emptyPattern
}

function describePattern(pattern: UserPattern) {
  const top = Object.entries(pattern.tapCounts).sort((a, b) => b[1] - a[1]).slice(0, 4)
  if (!top.length) return 'new user; no completed taps yet'
  return `observed ${pattern.totalTaps} taps; habits: ${top.map(([id, count]) => `${id}=${count}`).join(', ')}`
}

function nextPattern(pattern: UserPattern, actionId: string): UserPattern {
  return {
    tapCounts: { ...pattern.tapCounts, [actionId]: (pattern.tapCounts[actionId] || 0) + 1 },
    recentTaps: [actionId, ...pattern.recentTaps].slice(0, 8),
    totalTaps: pattern.totalTaps + 1,
  }
}

function fallbackPrediction(screen: Screen, forcedWrong: boolean, pattern: UserPattern) {
  const actions = graph[screen]
  const time = new Date().getHours()
  const contextual = time >= 11 && time <= 14 && actions.find(a => a.id.includes('food') || a.id.includes('lunch'))?.id
  const habitual = actions.map(a => [a.id, pattern.tapCounts[a.id] || 0] as const).sort((a, b) => b[1] - a[1])[0]
  const bill = actions.find(a => a.id.includes('electricity'))?.id
  const preferred = habitual?.[1] ? habitual[0] : contextual || bill || actions[0].id
  const pick = forcedWrong && actions.length > 1 ? actions.find(a => a.id !== preferred)!.id : preferred
  return actions.map(action => ({ actionId: action.id, confidence: action.id === pick ? 0.82 : +(0.18 / Math.max(actions.length - 1, 1)).toFixed(2) }))
}

function screenCopy(screen: Screen) {
  if (screen === 'home') return { amount: '3 engines live', copy: 'Utilities, lunch, shopping, orders', accent: 'Intent router' }
  if (screen === 'food') return { amount: '24 min', copy: 'Paneer bowl is likely at lunch time', accent: 'Food context' }
  if (screen === 'shop' || screen === 'deals') return { amount: '42% off', copy: 'Deals and cart APIs can be warmed', accent: 'Commerce context' }
  if (screen === 'summary') return { amount: '₹1,248', copy: 'Speculation stops before irreversible payment', accent: 'Commit-only' }
  if (screen === 'receipt' || screen === 'orders') return { amount: 'Ready', copy: 'History and receipt state loaded', accent: 'Post-commit' }
  return { amount: '₹1,248', copy: 'Bills, provider metadata, and review payload', accent: 'Utility context' }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [ahead, setAhead] = useState(true)
  const [network, setNetwork] = useState<Network>('terrible')
  const [forceWrong, setForceWrong] = useState(false)
  const [branch, setBranch] = useState<{ id: string; actionId: string; state: 'idle' | 'speculating' | 'committed' | 'rolledback' }>({ id: 'B-000', actionId: 'none', state: 'idle' })
  const [events, setEvents] = useState<Telemetry[]>([])
  const [saved, setSaved] = useState(0)
  const [hits, setHits] = useState(0)
  const [misses, setMisses] = useState(0)
  const [loading, setLoading] = useState(false)
  const [prediction, setPrediction] = useState<Ranked[]>(() => fallbackPrediction('home', false, emptyPattern))
  const [predictor, setPredictor] = useState({ source: 'connecting', model: 'Detecting Ollama...', latencyMs: 0 })
  const [pattern, setPattern] = useState<UserPattern>(() => readPattern())
  const [shadow, setShadow] = useState<ShadowPayload | null>(null)
  const [inspector, setInspector] = useState<Inspector>({ systemPrompt, userPrompt: 'Waiting for first prediction...', context: {}, raw: 'pending' })
  const [race, setRace] = useState({ normalMs: latency.terrible, shadowMs: 0, status: 'standby' })
  const timer = useRef<number | undefined>(undefined)
  const branchId = useRef(0)
  const speculativeRequest = useRef<AbortController | null>(null)

  const log = (type: EventType, detail: string) => setEvents(prev => [{ type, detail, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }, ...prev].slice(0, 8))
  const predictedId = prediction[0]?.actionId
  const actionCards = graph[screen]
  const currentCopy = screenCopy(screen)
  const predictedAction = actionCards.find(action => action.id === predictedId)
  const score = hits + misses ? Math.round((hits / (hits + misses)) * 100) : 100

  useEffect(() => {
    window.clearTimeout(timer.current)
    speculativeRequest.current?.abort()
    let cancelled = false
    const run = async () => {
      const context = {
        screenId: screen,
        legalActionIds: graph[screen].map(action => action.id),
        legalActionHints: graph[screen].map(action => `${action.id}=${action.label}; ${action.subtitle || 'no hint'}`),
        hourOfDay: new Date().getHours(),
        dayOfMonth: 2,
        historySummary: describePattern(pattern),
        recentTaps: pattern.recentTaps,
        networkRttMs: latency[network],
      }
      const userPrompt = `Screen=${context.screenId}; legal=${context.legalActionIds.join(',')}; hour=${context.hourOfDay}; day=${context.dayOfMonth}; history=${context.historySummary}; recent=${context.recentTaps.join(',') || 'none'}; rtt=${context.networkRttMs}ms. Rank likely next tap.`
      let ranked = fallbackPrediction(screen, forceWrong, pattern)
      let source = 'heuristic'; let model = 'local heuristic'; let latencyMs = 0
      let raw = JSON.stringify({ rankedActionIds: ranked.map(item => item.actionId) })
      let fallbackReason: string | undefined
      setInspector({ systemPrompt, userPrompt, context, raw: 'waiting for Gemma/Ollama...' })
      try {
        const response = await fetch('/api/predict', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(context), signal: AbortSignal.timeout(15000) })
        if (!response.ok) throw new Error('predictor unavailable')
        const result = await response.json() as { ranked: Ranked[]; source: string; model?: string; latencyMs: number; raw?: string; fallbackReason?: string }
        ranked = [...result.ranked].sort((a, b) => b.confidence - a.confidence)
        source = result.source; model = result.model ?? 'local heuristic'; latencyMs = result.latencyMs; raw = result.raw ?? raw; fallbackReason = result.fallbackReason
        if (forceWrong && ranked.length > 1) {
          const firstId = ranked[0].actionId
          ranked[0] = { ...ranked[0], actionId: ranked[1].actionId }
          ranked[1] = { ...ranked[1], actionId: firstId }
        }
      } catch {
        fallbackReason = 'frontend_timeout_or_api_unavailable'
      }
      if (cancelled) return
      setPrediction(ranked); setPredictor({ source, model, latencyMs }); setInspector({ systemPrompt, userPrompt, context, raw, fallbackReason })
      if (!ahead) return
      const chosen = ranked[0]
      const action = graph[screen].find(item => item.id === chosen.actionId)
      if (!action?.speculatable || chosen.confidence < .5 || network === 'good') return
      const id = `B-${String(++branchId.current).padStart(3, '0')}`
      setBranch({ id, actionId: chosen.actionId, state: 'speculating' })
      setShadow({ branchId: id, actionId: chosen.actionId, path: action.apiPath || '/api/noop', ready: false, payload: { status: 'fetching' }, latencyMs: 0 })
      log('prediction_made', `${model} ranked ${chosen.actionId} at ${Math.round(chosen.confidence * 100)}%`)
      log('speculation_started', `${id} forked shadow memory for ${action.apiPath}`)
      const controller = new AbortController(); speculativeRequest.current = controller
      const started = performance.now()
      fetch(`${action.apiPath || '/api/noop'}?network=${network}`, { signal: controller.signal })
        .then(response => response.json())
        .then(payload => {
          if (cancelled) return
          const took = Math.round(performance.now() - started)
          setShadow({ branchId: id, actionId: chosen.actionId, path: action.apiPath || '/api/noop', ready: true, payload, latencyMs: took })
          log('shadow_hydrated', `${id} payload ready in ${took}ms`)
        })
        .catch(() => undefined)
    }
    run()
    return () => { cancelled = true; speculativeRequest.current?.abort(); window.clearTimeout(timer.current) }
  }, [screen, ahead, network, forceWrong, pattern])

  const navigate = (action: Action) => {
    const updatedPattern = nextPattern(pattern, action.id)
    localStorage.setItem('ahead.userPattern', JSON.stringify(updatedPattern))
    setPattern(updatedPattern)
    if (!action.speculatable) {
      log('boundary_blocked', 'COMMIT_ONLY: payment requires a fresh human tap')
      setBranch(b => ({ ...b, state: 'idle' }))
      setLoading(true)
      fetch('/api/pay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionId: action.id, humanConfirmed: true }) })
        .finally(() => { timer.current = window.setTimeout(() => { setLoading(false); setScreen(action.screen) }, 520) })
      return
    }
    const hit = ahead && action.id === predictedId && branch.state === 'speculating' && shadow?.ready
    if (hit) {
      setRace({ normalMs: latency[network], shadowMs: 16, status: 'shadow_commit_won' })
      setBranch(b => ({ ...b, state: 'committed' }))
      setHits(value => value + 1)
      setSaved(value => value + latency[network])
      log('branch_committed', `${branch.id} promoted from shadow memory; ${latency[network]}ms avoided`)
      setScreen(action.screen)
      return
    }
    if (ahead) {
      setBranch(b => ({ ...b, state: 'rolledback' }))
      setMisses(value => value + 1)
      log('branch_rolled_back', `${branch.id} discarded; wrong branch caused zero side effects`)
    }
    setRace({ normalMs: latency[network], shadowMs: 0, status: 'normal_network_wait' })
    setLoading(true)
    timer.current = window.setTimeout(() => { setLoading(false); setScreen(action.screen) }, latency[network])
  }

  const edges = useMemo(() => Object.entries(graph).flatMap(([from, actions]) => actions.map(action => ({ from: from as Screen, to: action.screen, id: action.id }))).filter(edge => nodePos[edge.from] && nodePos[edge.to]), [])

  return <main>
    <header>
      <div className="brand"><span>A</span><div>AHEAD <em>GEMMA SPECULATIVE ENGINE</em></div></div>
      <div className="offline">LOCAL GEMMA 4 · SHADOW STATE · ZERO SIDE EFFECTS</div>
    </header>

    <section className="layout">
      <article className="phone">
        <div className="notch" />
        <div className="phone-top"><small>9:41</small><b>● ● ●</b></div>
        <div className="app-head"><span className="avatar">P</span><div><small>AHEAD SUPER APP</small><h2>{title[screen]}</h2></div><span className="scan">⌁</span></div>
        {loading ? <div className="spinner"><i /> Normal request waiting on {network} network...</div> : <div className="phone-content">
          <div className="hero-card">
            <small>{currentCopy.accent}</small>
            <strong>{currentCopy.amount}</strong>
            <p>{currentCopy.copy}</p>
          </div>
          <p className="section-label">NEXT ACTIONS</p>
          {actionCards.map(action => <button className={action.id === predictedId && branch.state === 'speculating' ? 'service preloaded' : 'service'} key={action.id} onClick={() => navigate(action)}>
            <span className="service-icon">{action.icon}</span>
            <span>{action.label}<small>{action.subtitle || 'Speculatable route'}</small></span>
            {action.id === predictedId && branch.state === 'speculating' && <em>{shadow?.ready ? 'PRELOADED' : 'STAGING'}</em>}
            <b>›</b>
          </button>)}
          {screen === 'summary' && <p className="boundary">Human confirmation boundary: AHEAD can prepare checkout, but cannot pay.</p>}
        </div>}
        <nav><span>⌂<small>Home</small></span><span>⌁<small>X-Ray</small></span><span>◉<small>Profile</small></span></nav>
      </article>

      <aside className="dash">
        <div className="eyebrow">X-RAY ENGINE ROOM</div>
        <div className="headline"><h1>Speculation made visible <span>{(saved / 1000).toFixed(1)}s saved</span></h1><p>Gemma predicts the next legal tap, AHEAD hydrates shadow memory, then commits instantly only when the user actually chooses that branch.</p></div>

        <div className="grid stats">
          <div><small>PREDICTOR</small><b>{predictor.source === 'gemma4' ? 'Gemma 4' : predictor.source === 'gemma3' ? 'Gemma 3' : 'Heuristic'}</b><em>{predictor.model} · {predictor.latencyMs}ms</em></div>
          <div><small>NETWORK</small><b>{latency[network]}ms</b><em className={network}>● {network.toUpperCase()}</em></div>
          <div><small>ACCURACY</small><b>{score}%</b><em>{hits} commits · {misses} rollbacks</em></div>
        </div>

        <section className="panel graph-panel">
          <div className="panel-title"><span>DECISION GRAPH</span><small>{branch.state.toUpperCase()} · {branch.id}</small></div>
          <svg viewBox="0 0 680 250" role="img">
            {edges.map(edge => {
              const from = nodePos[edge.from]!
              const to = nodePos[edge.to]!
              const active = edge.id === predictedId
              return <line key={`${edge.from}-${edge.id}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={active ? 'edge active' : 'edge'} />
            })}
            {Object.entries(nodePos).map(([id, pos]) => <g key={id} className={screen === id ? 'node current' : id === predictedAction?.screen ? 'node predicted' : 'node'}>
              <circle cx={pos.x} cy={pos.y} r="14" />
              <text x={pos.x} y={pos.y + 31}>{id}</text>
            </g>)}
          </svg>
        </section>

        <div className="split">
          <section className="panel">
            <div className="panel-title"><span>GEMMA RANKING</span><small>{screen.toUpperCase()}</small></div>
            {prediction.map(item => <div className="prediction" key={item.actionId}><div><b>{actionCards.find(a => a.id === item.actionId)?.label || item.actionId}</b><span>{Math.round(item.confidence * 100)}%</span></div><i><u style={{ width: `${item.confidence * 100}%` }} /></i></div>)}
          </section>
          <section className="panel race">
            <div className="panel-title"><span>LATENCY RACE</span><small>{race.status}</small></div>
            <div><span>Normal request</span><i><u style={{ width: `${Math.min(100, latency[network] / 50)}%` }} /></i><b>{race.normalMs}ms</b></div>
            <div><span>Shadow commit</span><i><u className="fast" style={{ width: `${race.status === 'shadow_commit_won' ? 8 : 0}%` }} /></i><b>{race.status === 'shadow_commit_won' ? `${race.shadowMs}ms` : 'ready'}</b></div>
          </section>
        </div>

        <div className="split">
          <section className="panel json-panel">
            <div className="panel-title"><span>SHADOW MEMORY</span><small>{shadow?.ready ? 'HYDRATED' : 'WAITING'}</small></div>
            <pre>{JSON.stringify(shadow || { branchId: branch.id, state: 'no shadow branch yet' }, null, 2)}</pre>
          </section>
          <section className="panel json-panel">
            <div className="panel-title"><span>OLLAMA PIPELINE</span><small>{predictor.source}</small></div>
            <pre>{JSON.stringify({ system: inspector.systemPrompt, user: inspector.userPrompt, raw: inspector.raw, fallbackReason: inspector.fallbackReason }, null, 2)}</pre>
          </section>
        </div>

        <section className="panel events">
          <div className="panel-title"><span>EVENT STREAM</span><small>{describePattern(pattern)}</small></div>
          {events.length ? events.map((event, index) => <p key={`${event.time}-${index}`}><time>{event.time}</time><b>{event.type}</b>{event.detail}</p>) : <p>Runtime standing by...</p>}
        </section>

        <section className="controls">
          <label><input type="checkbox" checked={ahead} onChange={event => setAhead(event.target.checked)} /><span>AHEAD {ahead ? 'ON' : 'OFF'}</span></label>
          <select value={network} onChange={event => setNetwork(event.target.value as Network)}><option value="good">Good · 250ms</option><option value="congested">Congested · 2.5s</option><option value="terrible">Terrible · 5s</option></select>
          <button onClick={() => setForceWrong(value => !value)} className={forceWrong ? 'wrong active' : 'wrong'}>Force wrong branch</button>
          <button onClick={() => { localStorage.removeItem('ahead.userPattern'); setPattern(emptyPattern) }}>Reset memory</button>
        </section>
      </aside>
    </section>
  </main>
}
