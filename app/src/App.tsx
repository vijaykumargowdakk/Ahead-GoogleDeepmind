import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import './index.css'

type Network = 'good' | 'congested' | 'terrible'
type ScenarioId = 'lunch' | 'dinner' | 'payday' | 'monthEnd' | 'billDue'
type Screen = 'home' | 'food' | 'biryani' | 'pasta' | 'banking' | 'investments' | 'balance' | 'transfer' | 'utilities' | 'electricity' | 'water' | 'shop' | 'summary' | 'receipt'
type BranchState = 'idle' | 'speculating' | 'committed' | 'rolledback'
type EventType = 'prediction_made' | 'speculation_started' | 'image_preloaded' | 'shadow_hydrated' | 'branch_committed' | 'branch_rolled_back' | 'boundary_blocked'
type Action = { id: string; label: string; screen: Screen; speculatable: boolean; icon: string; apiPath?: string; subtitle: string; appTint?: string }
type Ranked = { actionId: string; confidence: number }
type Telemetry = { type: EventType; detail: string; time: string }
type ShadowPayload = { branchId: string; actionId: string; path: string; ready: boolean; payload: Record<string, unknown>; latencyMs: number; imageUrl?: string }
type Inspector = { systemPrompt: string; userPrompt: string; context: Record<string, unknown>; raw: string; fallbackReason?: string }

const scenarios: Record<ScenarioId, { label: string; hour: number; day: number; signal: string; targets: Partial<Record<Screen, string>> }> = {
  lunch: { label: 'Lunch Break (1:00 PM)', hour: 13, day: 11, signal: 'Lunch hour: user usually opens Food and orders Biryani.', targets: { home: 'open_food_app', food: 'order_biryani', biryani: 'checkout_biryani', summary: 'pay_now', receipt: 'back_home' } },
  dinner: { label: 'Dinner Time (8:00 PM)', hour: 20, day: 11, signal: 'Dinner hour: user usually opens Food and orders Pasta.', targets: { home: 'open_food_app', food: 'order_pasta', pasta: 'checkout_pasta', summary: 'pay_now', receipt: 'back_home' } },
  payday: { label: 'Payday (1st)', hour: 10, day: 1, signal: 'Salary credited: user usually opens Banking and checks investments.', targets: { home: 'open_banking_app', banking: 'view_investments', investments: 'back_home_from_investments', summary: 'pay_now', receipt: 'back_home' } },
  monthEnd: { label: 'Month End (28th)', hour: 18, day: 28, signal: 'Month end budget check: user usually opens Banking and checks balance.', targets: { home: 'open_banking_app', banking: 'check_balance', balance: 'transfer_from_balance', transfer: 'confirm_transfer', receipt: 'back_home' } },
  billDue: { label: 'Bill Due (14th)', hour: 9, day: 14, signal: 'Electricity bill due today: user usually opens Utilities and pays electricity.', targets: { home: 'open_utilities_app', utilities: 'open_electricity_bill', electricity: 'review_electricity_payment', summary: 'pay_now', receipt: 'back_home' } },
}

const graph: Record<Screen, Action[]> = {
  home: [
    { id: 'open_food_app', label: 'Food', screen: 'food', speculatable: true, icon: 'Food', apiPath: '/api/apps/food', subtitle: 'Meals and reorders', appTint: '#ff7658' },
    { id: 'open_banking_app', label: 'Banking', screen: 'banking', speculatable: true, icon: 'Bank', apiPath: '/api/apps/banking', subtitle: 'Balance, transfer, invest', appTint: '#66e7a8' },
    { id: 'open_utilities_app', label: 'Utilities', screen: 'utilities', speculatable: true, icon: 'Bill', apiPath: '/api/apps/utilities', subtitle: 'Electricity and water', appTint: '#66d9ff' },
    { id: 'open_shop_app', label: 'Shop', screen: 'shop', speculatable: true, icon: 'Shop', apiPath: '/api/apps/shop', subtitle: 'Orders and deals', appTint: '#b896ff' },
  ],
  food: [
    { id: 'order_biryani', label: 'Order Biryani', screen: 'biryani', speculatable: true, icon: 'Biryani', apiPath: '/api/food/biryani', subtitle: 'Lunch special, image + menu preload' },
    { id: 'order_pasta', label: 'Order Pasta', screen: 'pasta', speculatable: true, icon: 'Pasta', apiPath: '/api/food/pasta', subtitle: 'Dinner favorite, image + menu preload' },
    { id: 'browse_restaurants', label: 'Browse nearby', screen: 'food', speculatable: true, icon: 'Map', apiPath: '/api/food/nearby', subtitle: 'Fallback discovery path' },
  ],
  biryani: [{ id: 'checkout_biryani', label: 'Checkout Biryani', screen: 'summary', speculatable: true, icon: 'Pay', apiPath: '/api/review/biryani', subtitle: 'Prepare order checkout' }],
  pasta: [{ id: 'checkout_pasta', label: 'Checkout Pasta', screen: 'summary', speculatable: true, icon: 'Pay', apiPath: '/api/review/pasta', subtitle: 'Prepare order checkout' }],
  banking: [
    { id: 'view_investments', label: 'Investments', screen: 'investments', speculatable: true, icon: 'Grow', apiPath: '/api/banking/investments', subtitle: 'Payday portfolio view' },
    { id: 'check_balance', label: 'Check balance', screen: 'balance', speculatable: true, icon: 'Cash', apiPath: '/api/banking/balance', subtitle: 'Month-end budget view' },
    { id: 'transfer_money', label: 'Transfer', screen: 'transfer', speculatable: true, icon: 'Send', apiPath: '/api/banking/transfer', subtitle: 'Prepare contacts, no transfer' },
  ],
  investments: [{ id: 'back_home_from_investments', label: 'Back home', screen: 'home', speculatable: true, icon: 'Home', apiPath: '/api/apps/home', subtitle: 'Return to home screen' }],
  balance: [{ id: 'transfer_from_balance', label: 'Transfer money', screen: 'transfer', speculatable: true, icon: 'Send', apiPath: '/api/banking/transfer', subtitle: 'Prepare transfer form' }],
  transfer: [{ id: 'confirm_transfer', label: 'Confirm transfer', screen: 'receipt', speculatable: false, icon: 'Lock', subtitle: 'Human confirmation required' }],
  utilities: [
    { id: 'open_electricity_bill', label: 'Electricity', screen: 'electricity', speculatable: true, icon: 'Power', apiPath: '/api/bills/electricity', subtitle: 'Due on the 14th' },
    { id: 'open_water_bill', label: 'Water', screen: 'water', speculatable: true, icon: 'Water', apiPath: '/api/bills/water', subtitle: 'Lower urgency bill' },
  ],
  electricity: [{ id: 'review_electricity_payment', label: 'Review payment', screen: 'summary', speculatable: true, icon: 'Pay', apiPath: '/api/review/electricity', subtitle: 'Prepare bill checkout' }],
  water: [{ id: 'review_water_payment', label: 'Review water bill', screen: 'summary', speculatable: true, icon: 'Pay', apiPath: '/api/review/water', subtitle: 'Prepare bill checkout' }],
  shop: [
    { id: 'browse_daily_deals', label: 'Daily deals', screen: 'summary', speculatable: true, icon: 'Deal', apiPath: '/api/shop/deals', subtitle: 'Offers staged before opening' },
    { id: 'view_shop_orders', label: 'Track orders', screen: 'receipt', speculatable: true, icon: 'Box', apiPath: '/api/shop/orders', subtitle: 'Recent order status' },
  ],
  summary: [{ id: 'pay_now', label: 'Confirm payment', screen: 'receipt', speculatable: false, icon: 'Lock', subtitle: 'Commit-only side effect' }],
  receipt: [{ id: 'back_home', label: 'Back home', screen: 'home', speculatable: true, icon: 'Home', apiPath: '/api/apps/home', subtitle: 'Reset demo path' }],
}

const latency: Record<Network, number> = { good: 250, congested: 1400, terrible: 3000 }
const title: Record<Screen, string> = {
  home: 'iPhone Home',
  food: 'Food',
  biryani: 'Biryani ready',
  pasta: 'Pasta ready',
  banking: 'Banking',
  investments: 'Investments',
  balance: 'Balance',
  transfer: 'Transfer',
  utilities: 'Utilities',
  electricity: 'Electricity bill',
  water: 'Water bill',
  shop: 'Shop',
  summary: 'Commit boundary',
  receipt: 'Done',
}
const nodePos: Partial<Record<Screen, { x: number; y: number }>> = {
  home: { x: 52, y: 155 },
  food: { x: 178, y: 50 },
  banking: { x: 178, y: 120 },
  utilities: { x: 178, y: 205 },
  shop: { x: 178, y: 275 },
  biryani: { x: 342, y: 30 },
  pasta: { x: 342, y: 72 },
  investments: { x: 342, y: 112 },
  balance: { x: 342, y: 152 },
  transfer: { x: 342, y: 192 },
  electricity: { x: 342, y: 232 },
  water: { x: 342, y: 275 },
  summary: { x: 520, y: 150 },
  receipt: { x: 680, y: 150 },
}
const systemPrompt = 'You are Gemma inside AHEAD, a mobile speculative execution runtime. Return JSON only: {"rankedActionIds":["exact_id"]}. Use only legal IDs and rank the next likely tap.'

function scenarioMemory(scenario: ScenarioId, screen: Screen) {
  const config = scenarios[scenario]
  const target = config.targets[screen]
  return target ? `scenario target for this screen is ${target}; ${config.signal}` : config.signal
}

function scenarioHash(scenario: string, screen: string, length: number) {
  let hash = 2166136261
  for (const character of `${scenario}:${screen}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  return length ? hash % length : 0
}

function chooseFallbackAction(input: { legalActionIds: string[]; scenario: string; screenId: string; scenarioTarget?: string; hourOfDay: number; dayOfMonth: number; historySummary?: string }) {
  const legal = input.legalActionIds
  if (input.scenarioTarget && legal.includes(input.scenarioTarget)) return input.scenarioTarget
  const contextual = input.screenId === 'food'
    ? legal.find(id => input.hourOfDay >= 18 ? id.includes('pasta') : input.hourOfDay >= 11 && input.hourOfDay <= 14 ? id.includes('biryani') : false)
    : input.screenId === 'banking'
      ? legal.find(id => input.dayOfMonth <= 2 ? id.includes('investment') : input.dayOfMonth >= 27 ? id.includes('balance') : false)
      : input.screenId === 'utilities' && input.dayOfMonth === 14
        ? legal.find(id => id.includes('electricity'))
        : undefined
  if (contextual) return contextual
  const habitual = legal.reduce<{ id?: string; count: number }>((best, id) => {
    const count = Number((input.historySummary || '').match(new RegExp(`${id}=(\\d+)`))?.[1] || 0)
    return count > best.count ? { id, count } : best
  }, { count: 0 }).id
  return habitual || legal[scenarioHash(input.scenario, input.screenId, legal.length)]
}

function fallbackPrediction(screen: Screen, forcedWrong: boolean, scenario: ScenarioId) {
  const actions = graph[screen]
  const config = scenarios[scenario]
  const preferred = chooseFallbackAction({ legalActionIds: actions.map(action => action.id), scenario, screenId: screen, scenarioTarget: config.targets[screen], hourOfDay: config.hour, dayOfMonth: config.day, historySummary: scenarioMemory(scenario, screen) })
  const pick = forcedWrong && actions.length > 1 ? actions.find(action => action.id !== preferred)!.id : preferred
  return actions.map(action => ({ actionId: action.id, confidence: action.id === pick ? 0.82 : +(0.18 / Math.max(actions.length - 1, 1)).toFixed(2) }))
}

function screenHero(screen: Screen, scenario: ScenarioId, shadow: ShadowPayload | null) {
  const imageUrl = screen === 'biryani' ? '/food/biryani.png' : screen === 'pasta' ? '/food/pasta.png' : undefined
  if (screen === 'home') return { eyebrow: scenarios[scenario].label, value: 'Choose an app', copy: 'AHEAD predicts before the app opens.', imageUrl }
  if (screen === 'food') return { eyebrow: 'Deep food branch', value: scenario === 'dinner' ? 'Dinner context' : 'Lunch context', copy: 'Gemma chooses Biryani at lunch and Pasta at dinner.', imageUrl }
  if (screen === 'biryani' || screen === 'pasta') return { eyebrow: shadow?.ready ? 'Image came from shadow memory' : 'Menu loaded', value: screen === 'biryani' ? 'Hyderabadi Biryani' : 'Creamy Tomato Pasta', copy: 'The rich media asset is already decoded, so there is no pop-in.', imageUrl }
  if (screen === 'banking') return { eyebrow: 'Banking branch', value: scenario === 'payday' ? 'Payday signal' : 'Month-end signal', copy: 'Gemma switches between Investments and Balance from date context.', imageUrl }
  if (screen === 'investments') return { eyebrow: 'Payday prediction', value: 'Portfolio +2.8%', copy: 'Investment dashboard was safely prefetched.', imageUrl }
  if (screen === 'balance') return { eyebrow: 'Month-end prediction', value: 'Balance Rs 82,440', copy: 'Balance view was safely prefetched without side effects.', imageUrl }
  if (screen === 'utilities') return { eyebrow: 'Bill due signal', value: 'Due today', copy: 'The 14th points Gemma to Electricity.', imageUrl }
  if (screen === 'shop') return { eyebrow: 'Commerce branch', value: 'Deals and orders', copy: 'Shop now follows its own visible path before checkout or tracking.', imageUrl }
  if (screen === 'summary') return { eyebrow: 'Safety boundary', value: 'Human tap required', copy: 'AHEAD can prepare checkout but cannot cross the commit boundary.', imageUrl }
  if (screen === 'receipt') return { eyebrow: 'Committed', value: 'Done', copy: 'Side effects happen only after explicit user action.', imageUrl }
  return { eyebrow: 'Shadow safe', value: title[screen], copy: 'Prefetched data is isolated until the branch is chosen.', imageUrl }
}

export default function App() {
  const [scenario, setScenario] = useState<ScenarioId>('lunch')
  const [screen, setScreen] = useState<Screen>('home')
  const [network, setNetwork] = useState<Network>('terrible')
  const [ahead, setAhead] = useState(true)
  const [forceWrong, setForceWrong] = useState(false)
  const [branch, setBranch] = useState<{ id: string; actionId: string; state: BranchState }>({ id: 'B-000', actionId: 'none', state: 'idle' })
  const [prediction, setPrediction] = useState<Ranked[]>(() => fallbackPrediction('home', false, 'lunch'))
  const [predictor, setPredictor] = useState({ source: 'connecting', model: 'Detecting Ollama...', latencyMs: 0, diagnostic: 'checking local runtime' as string | undefined })
  const [shadow, setShadow] = useState<ShadowPayload | null>(null)
  const [events, setEvents] = useState<Telemetry[]>([])
  const [saved, setSaved] = useState(0)
  const [hits, setHits] = useState(0)
  const [misses, setMisses] = useState(0)
  const [loading, setLoading] = useState(false)
  const [traversedEdges, setTraversedEdges] = useState<string[]>([])
  const [race, setRace] = useState({ normalMs: latency.terrible, shadowMs: 0, status: 'standby' })
  const [inspector, setInspector] = useState<Inspector>({ systemPrompt, userPrompt: 'Waiting for prediction...', context: {}, raw: 'pending' })
  const timer = useRef<ReturnType<typeof window.setTimeout> | undefined>(undefined)
  const branchId = useRef(0)
  const speculativeRequest = useRef<AbortController | null>(null)
  const stagingPromise = useRef<Promise<ShadowPayload | null> | null>(null)

  const actions = graph[screen]
  const predictedId = prediction[0]?.actionId
  const predictedAction = actions.find(action => action.id === predictedId)
  const score = hits + misses ? Math.round((hits / (hits + misses)) * 100) : 100
  const hero = screenHero(screen, scenario, shadow)

  const log = (type: EventType, detail: string) => setEvents(previous => [{ type, detail, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }, ...previous].slice(0, 8))

  useEffect(() => {
    window.clearTimeout(timer.current)
    speculativeRequest.current?.abort()
    stagingPromise.current = null
    let cancelled = false
    const run = async () => {
      const config = scenarios[scenario]
      const context = {
        scenario,
        scenarioLabel: config.label,
        scenarioSignal: config.signal,
        scenarioTarget: config.targets[screen] || 'none',
        screenId: screen,
        legalActionIds: actions.map(action => action.id),
        legalActionHints: actions.map(action => `${action.id}=${action.label}; ${action.subtitle}`),
        hourOfDay: config.hour,
        dayOfMonth: config.day,
        historySummary: scenarioMemory(scenario, screen),
        recentTaps: [screen, scenario],
        networkRttMs: latency[network],
      }
      const userPrompt = `Scenario=${context.scenarioLabel}; signal=${context.scenarioSignal}; screen=${screen}; legal=${context.legalActionHints.join(' | ')}; hour=${context.hourOfDay}; day=${context.dayOfMonth}; target_hint=${context.scenarioTarget}; network=${context.networkRttMs}ms. Rank the next tap.`
      let ranked = fallbackPrediction(screen, forceWrong, scenario)
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
        if (forceWrong && ranked.length > 1) ranked = [ranked[1], ranked[0], ...ranked.slice(2)]
      } catch {
        fallbackReason = 'frontend_timeout_or_api_unavailable'
      }
      if (cancelled) return
      setPrediction(ranked); setPredictor({ source, model, latencyMs, diagnostic: fallbackReason }); setInspector({ systemPrompt, userPrompt, context, raw, fallbackReason })
      const chosen = ranked[0]
      const action = graph[screen].find(item => item.id === chosen.actionId)
      if (!ahead || !action?.speculatable || chosen.confidence < .5 || network === 'good') return
      const id = `B-${String(++branchId.current).padStart(3, '0')}`
      const path = action.apiPath || '/api/apps/home'
      const controller = new AbortController()
      speculativeRequest.current = controller
      setBranch({ id, actionId: chosen.actionId, state: 'speculating' })
      setShadow({ branchId: id, actionId: chosen.actionId, path, ready: false, payload: { status: 'fetching' }, latencyMs: 0 })
      log('prediction_made', `${model} ranked ${chosen.actionId} at ${Math.round(chosen.confidence * 100)}%`)
      log('speculation_started', `${id} started JSON + media preload for ${path}`)
      const started = performance.now()
      const stage = async () => {
        try {
          const response = await fetch(`${path}?network=${network}&speculative=1`, { signal: controller.signal })
          if (!response.ok) throw new Error(`shadow request ${response.status}`)
          const payload = await response.json() as Record<string, unknown>
          if (cancelled || controller.signal.aborted) return null
          const took = Math.round(performance.now() - started)
          const imageUrl = typeof payload.imageUrl === 'string' ? payload.imageUrl : undefined
          if (imageUrl) {
            const image = new Image()
            image.src = imageUrl
            await image.decode().catch(() => undefined)
            if (cancelled || controller.signal.aborted) return null
            log('image_preloaded', `${id} decoded ${imageUrl}`)
          }
          const hydrated = { branchId: id, actionId: chosen.actionId, path, ready: true, payload, latencyMs: took, imageUrl }
          setShadow(hydrated)
          log('shadow_hydrated', `${id} fast shadow ready in ${took}ms`)
          return hydrated
        } catch {
          return null
        }
      }
      stagingPromise.current = stage()
    }
    run()
    return () => { cancelled = true; speculativeRequest.current?.abort(); window.clearTimeout(timer.current) }
  }, [screen, scenario, network, ahead, forceWrong])

  const chooseScenario = (next: ScenarioId) => {
    setScenario(next)
    setScreen('home')
    setShadow(null)
    setBranch({ id: 'B-000', actionId: 'none', state: 'idle' })
    setTraversedEdges([])
    setRace({ normalMs: latency[network], shadowMs: 0, status: 'scenario_reset' })
  }

  const recordTraversal = (action: Action) => {
    if (action.screen === 'home') setTraversedEdges([])
    else setTraversedEdges(previous => [...previous, `${screen}:${action.id}`].slice(-10))
  }

  const commitShadow = (action: Action, staged: ShadowPayload) => {
    setRace({ normalMs: latency[network], shadowMs: staged.imageUrl ? 12 : 18, status: staged.imageUrl ? 'image_shadow_commit_won' : 'shadow_commit_won' })
    setBranch(current => ({ ...current, state: 'committed' }))
    setHits(value => value + 1)
    setSaved(value => value + latency[network])
    log('branch_committed', `${branch.id} promoted instantly; ${latency[network]}ms avoided`)
    setLoading(false)
    setScreen(action.screen)
  }

  const navigate = async (action: Action) => {
    recordTraversal(action)
    if (!action.speculatable) {
      log('boundary_blocked', 'COMMIT_ONLY: irreversible payment/transfer needs a human tap')
      setLoading(true)
      fetch('/api/pay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionId: action.id, humanConfirmed: true }) })
        .finally(() => { timer.current = window.setTimeout(() => { setLoading(false); setScreen(action.screen) }, 420) })
      return
    }
    const matchingBranch = ahead && action.id === predictedId && branch.state === 'speculating'
    if (matchingBranch) {
      let staged = shadow?.ready ? shadow : null
      if (!staged && stagingPromise.current) {
        setRace({ normalMs: latency[network], shadowMs: 0, status: 'joining_fast_shadow' })
        staged = await stagingPromise.current
      }
      if (staged?.ready) {
        commitShadow(action, staged)
        return
      }
    }
    if (ahead) {
      setBranch(current => ({ ...current, state: 'rolledback' }))
      setMisses(value => value + 1)
      log('branch_rolled_back', `${branch.id} discarded safely; no side effects crossed`)
    }
    setRace({ normalMs: latency[network], shadowMs: 0, status: 'normal_network_wait' })
    setLoading(true)
    timer.current = window.setTimeout(() => { setLoading(false); setScreen(action.screen) }, latency[network])
  }

  const edges = useMemo(() => Object.entries(graph)
    .flatMap(([from, items]) => items.map(item => ({ from: from as Screen, to: item.screen, id: item.id })))
    .filter(edge => nodePos[edge.from] && nodePos[edge.to] && edge.from !== edge.to && !edge.id.startsWith('back_home')), [])

  return <main>
    <header><div className="brand"><span>A</span><div>AHEAD <em>V3 GEMMA SPECULATIVE ENGINE</em></div></div><div className="offline">IOS HOME · DEEP BRANCHES · IMAGE PRELOAD</div></header>
    <section className="layout">
      <article className="phone">
        <div className="notch" /><div className="phone-top"><small>9:41</small><b>● ● ●</b></div>
        <div className="app-head"><span className="avatar">P</span><div><small>{scenarios[scenario].label}</small><h2>{title[screen]}</h2></div><span className="scan">⌁</span></div>
        {loading ? <div className="phone-content"><div className="skeleton-screen"><i /><b /><b /><b /><span /></div></div> : <div className="phone-content scroll">
          <div className={hero.imageUrl ? 'hero-card media' : 'hero-card'}>{hero.imageUrl && <img src={hero.imageUrl} alt="" />}<small>{hero.eyebrow}</small><strong>{hero.value}</strong><p>{hero.copy}</p></div>
          {screen === 'home' ? <div className="ios-grid">{actions.map(action => <button className={action.id === predictedId && branch.state === 'speculating' ? 'app-icon preloaded' : 'app-icon'} key={action.id} onClick={() => navigate(action)} style={{ '--tint': action.appTint } as CSSProperties}><span>{action.icon}</span><b>{action.label}</b>{action.id === predictedId && branch.state === 'speculating' && <em>{shadow?.ready ? 'PRELOADED' : 'STAGING'}</em>}</button>)}</div> : <>
            <p className="section-label">NEXT INSIDE {title[screen].toUpperCase()}</p>
            {actions.map(action => <button className={action.id === predictedId && branch.state === 'speculating' ? 'service preloaded' : 'service'} key={action.id} onClick={() => navigate(action)}><span className="service-icon">{action.icon}</span><span>{action.label}<small>{action.subtitle}</small></span>{action.id === predictedId && branch.state === 'speculating' && <em>{shadow?.ready ? 'PRELOADED' : 'STAGING'}</em>}<b>›</b></button>)}
          </>}
          {screen === 'summary' && <p className="boundary">AHEAD can preload the review screen, but payment and transfer confirmation are commit-only.</p>}
        </div>}
        <nav><span>⌂<small>Home</small></span><span>⌁<small>X-Ray</small></span><span>◉<small>Profile</small></span></nav>
      </article>

      <aside className="dash">
        <div className="eyebrow">V3 X-RAY ENGINE ROOM</div>
        <div className="headline"><h1>Deep intent prediction <span>{(saved / 1000).toFixed(1)}s saved</span></h1><p>Gemma predicts app launch, then predicts inside the app. AHEAD preloads JSON and rich media into shadow memory before the user taps.</p></div>
        <div className="grid stats"><div><small>PREDICTOR</small><b>{predictor.source === 'gemma4' ? 'Gemma 4' : predictor.source === 'gemma3' ? 'Gemma 3' : 'Heuristic'}</b><em>{predictor.model} · {predictor.latencyMs}ms</em>{predictor.diagnostic && <small title={predictor.diagnostic}>↳ {predictor.diagnostic.replaceAll('_', ' ')}</small>}</div><div><small>NETWORK</small><b>{latency[network]}ms</b><em className={network}>● {network.toUpperCase()}</em></div><div><small>ACCURACY</small><b>{score}%</b><em>{hits} commits · {misses} rollbacks</em></div></div>
        <section className="controls"><label><input type="checkbox" checked={ahead} onChange={event => setAhead(event.target.checked)} /><span>AHEAD {ahead ? 'ON' : 'OFF'}</span></label><select value={scenario} onChange={event => chooseScenario(event.target.value as ScenarioId)}>{Object.entries(scenarios).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}</select><select value={network} onChange={event => setNetwork(event.target.value as Network)}><option value="good">Good · 250ms</option><option value="congested">Congested · 1.4s</option><option value="terrible">Terrible · 3s</option></select><button onClick={() => setForceWrong(value => !value)} className={forceWrong ? 'wrong active' : 'wrong'}>Force wrong branch</button></section>
        <section className="panel graph-panel"><div className="panel-title"><span>DECISION GRAPH</span><small>{branch.state.toUpperCase()} · {branch.id}</small></div><svg viewBox="0 0 720 320">{edges.map(edge => { const from = nodePos[edge.from]!; const to = nodePos[edge.to]!; const active = edge.from === screen && edge.id === predictedId; const traversed = traversedEdges.includes(`${edge.from}:${edge.id}`); return <line key={`${edge.from}-${edge.id}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={`edge${traversed ? ' traversed' : ''}${active ? ' active' : ''}`} /> })}{Object.entries(nodePos).map(([id, pos]) => <g key={id} className={screen === id ? 'node current' : predictedAction?.screen === id ? 'node predicted' : 'node'}><circle cx={pos.x} cy={pos.y} r="14" /><text x={pos.x} y={pos.y + 31}>{id}</text></g>)}</svg></section>
        <div className="split"><section className="panel json-panel"><div className="panel-title"><span>SHADOW MEMORY</span><small>{shadow?.imageUrl ? 'IMAGE + JSON' : shadow?.ready ? 'JSON' : 'WAITING'}</small></div><pre>{JSON.stringify(shadow || { state: 'no shadow branch yet' }, null, 2)}</pre></section><section className="panel json-panel"><div className="panel-title"><span>OLLAMA PIPELINE</span><small>{scenario}</small></div><pre>{JSON.stringify({ user: inspector.userPrompt, raw: inspector.raw, fallbackReason: inspector.fallbackReason }, null, 2)}</pre></section></div>
        <section className="panel events"><div className="panel-title"><span>EVENT STREAM</span><small>{scenarios[scenario].signal}</small></div>{events.length ? events.map((event, index) => <p key={`${event.time}-${index}`}><time>{event.time}</time><b>{event.type}</b>{event.detail}</p>) : <p>Runtime standing by...</p>}</section>
        <div className="split"><section className="panel"><div className="panel-title"><span>GEMMA RANKING</span><small>{screen.toUpperCase()}</small></div>{prediction.map(item => <div className="prediction" key={item.actionId}><div><b>{actions.find(action => action.id === item.actionId)?.label || item.actionId}</b><span>{Math.round(item.confidence * 100)}%</span></div><i><u style={{ width: `${item.confidence * 100}%` }} /></i></div>)}</section><section className="panel race"><div className="panel-title"><span>LATENCY RACE</span><small>{race.status}</small></div><div><span>Normal request</span><i><u style={{ width: `${Math.min(100, latency[network] / 30)}%` }} /></i><b>{race.normalMs}ms</b></div><div><span>Shadow commit</span><i><u className="fast" style={{ width: `${race.status.includes('won') ? 8 : 0}%` }} /></i><b>{race.status.includes('won') ? `${race.shadowMs}ms` : 'ready'}</b></div></section></div>
      </aside>
    </section>
  </main>
}
