import { useEffect, useMemo, useState } from 'react'
import { apiClient } from '../../api/client'
import { clearActiveTimer, loadActiveTimer, saveActiveTimer, type ActiveTimerDisplay } from '../../shared/timer-local-state'
import { useConnectivity } from '../../shared/use-connectivity'
import './today-page.css'

type Api = {
  get: (path: string) => Promise<unknown>
  post: (path: string, body?: Record<string, unknown>) => Promise<unknown>
  put: (path: string, body?: Record<string, unknown>) => Promise<unknown>
  patch: (path: string, body?: Record<string, unknown>) => Promise<unknown>
  delete: (path: string) => Promise<unknown>
}
type Category = { id: string, name: string }
type CrmResult = { type: string, id: string, label: string }
type PlanAllocation = { standardCategoryId: string, personalCategoryId?: string, plannedMinutes: number }
type AuthoritativeEntry = {
  id: string
  standard_category_id: string
  started_at: string
  linked_entity_type: string | null
  linked_entity_id: string | null
  linked_entity_label: string | null
}

type TodayPageProps = {
  api?: Api
  online?: boolean
  requestId?: () => string
  now?: () => number
}

function commandId(): string {
  return window.crypto.randomUUID?.() ?? `timer-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function currentTime(): number { return Date.now() }

function formatElapsed(startedAt: string, current: number): string {
  const totalSeconds = Math.max(0, Math.floor((current - Date.parse(startedAt)) / 1000))
  const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, '0')
  const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0')
  const seconds = (totalSeconds % 60).toString().padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

function localFromEntry(entry: AuthoritativeEntry): ActiveTimerDisplay {
  return {
    entryId: entry.id,
    categoryId: entry.standard_category_id,
    startedAt: entry.started_at,
    crm: entry.linked_entity_type && entry.linked_entity_id && entry.linked_entity_label
      ? { type: entry.linked_entity_type, id: entry.linked_entity_id, label: entry.linked_entity_label }
      : null
  }
}

function entryCrm(entry: ActiveTimerDisplay): CrmResult | null {
  return entry.crm ? { ...entry.crm } : null
}

export function TodayPage({ api = apiClient, online, requestId = commandId, now = currentTime }: TodayPageProps) {
  const isOnline = useConnectivity(online)
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState('')
  const [availableMinutes, setAvailableMinutes] = useState('480')
  const [planAllocations, setPlanAllocations] = useState<PlanAllocation[]>([])
  const [variance, setVariance] = useState<number | null>(null)
  const [timer, setTimer] = useState<ActiveTimerDisplay | null>(() => loadActiveTimer())
  const [crmQuery, setCrmQuery] = useState('')
  const [crmResults, setCrmResults] = useState<CrmResult[]>([])
  const [selectedCrm, setSelectedCrm] = useState<CrmResult | null>(() => timer ? entryCrm(timer) : null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [timerNow, setTimerNow] = useState(() => now())
  const [timerBusy, setTimerBusy] = useState(false)

  const categoryName = useMemo(() => categories.find(category => category.id === timer?.categoryId)?.name ?? 'Selected category', [categories, timer])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [categoryData, planData] = await Promise.all([
          api.get('/categories'),
          api.get('/plans/today')
        ]) as [{ standard: Category[] }, { plan: { available_minutes: number } | null, allocations: Array<{ standard_category_id?: string, standardCategoryId?: string, personal_category_id?: string | null, personalCategoryId?: string | null, planned_minutes?: number, plannedMinutes?: number }>, varianceMinutes: number }]
        if (cancelled) return
        setCategories(categoryData.standard)
        const storedTimer = loadActiveTimer()
        setSelectedCategoryId(current => current || storedTimer?.categoryId || categoryData.standard[0]?.id || '')
        if (planData.plan) setAvailableMinutes(String(planData.plan.available_minutes))
        const validCategoryIds = new Set(categoryData.standard.map(category => category.id))
        const loadedAllocations = (planData.allocations || []).flatMap(allocation => {
          const standardCategoryId = allocation.standardCategoryId ?? allocation.standard_category_id
          if (!standardCategoryId || !validCategoryIds.has(standardCategoryId)) return []
          const personalCategoryId = allocation.personalCategoryId ?? allocation.personal_category_id ?? undefined
          return [{ standardCategoryId, ...(personalCategoryId ? { personalCategoryId } : {}), plannedMinutes: allocation.plannedMinutes ?? allocation.planned_minutes ?? 0 }]
        })
        setPlanAllocations(loadedAllocations.length > 0 ? loadedAllocations : (categoryData.standard[0] ? [{ standardCategoryId: categoryData.standard[0].id, plannedMinutes: 0 }] : []))
        setVariance(planData.varianceMinutes || null)
        if (isOnline) await reconcile()
        if (!cancelled) setError('')
      } catch {
        if (!cancelled) setError('Today data could not be loaded. Try again when the CRM connection is available.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
    // Reconciliation intentionally runs once when this page opens or reconnects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, isOnline])

  async function reconcile() {
    const current = loadActiveTimer()
    const response = await api.post('/entries/timer/reconcile', {
      displayedEntryId: current?.entryId ?? null,
      displayedStartedAt: current?.startedAt ?? null
    }) as { matches: boolean, authoritativeEntry: AuthoritativeEntry | null }
    if (response.authoritativeEntry) {
      const serverTimer = localFromEntry(response.authoritativeEntry)
      const serverIsNewer = !current || Date.parse(serverTimer.startedAt) > Date.parse(current.startedAt)
      if (serverIsNewer) {
        saveActiveTimer(serverTimer)
        setTimer(serverTimer)
        setSelectedCategoryId(serverTimer.categoryId)
        setSelectedCrm(entryCrm(serverTimer))
        if (!response.matches) setMessage('Timer display updated from the newer server timer.')
      } else if (current && !response.matches) {
        setTimer(current)
        setSelectedCategoryId(current.categoryId)
        setSelectedCrm(entryCrm(current))
        setMessage(Date.parse(current.startedAt) > Date.parse(serverTimer.startedAt)
          ? 'The local timer is newer than the server timer. Review records before recovery.'
          : 'The local and server timers conflict. Review records before recovery.')
      }
    } else if (current) {
      setTimer(current)
      setMessage('This local timer could not be confirmed. Recover it only after checking your records.')
    } else {
      clearActiveTimer()
      setTimer(null)
    }
  }

  useEffect(() => {
    if (!crmQuery.trim() || !isOnline) {
      setCrmResults([])
      return
    }
    const handle = window.setTimeout(() => {
      void api.get(`/crm-links?q=${encodeURIComponent(crmQuery)}&limit=10`)
        .then(result => setCrmResults((result as { data: CrmResult[] }).data))
        .catch(() => setCrmResults([]))
    }, 200)
    return () => window.clearTimeout(handle)
  }, [api, crmQuery, isOnline])

  useEffect(() => {
    if (!timer) return
    setTimerNow(now())
    const interval = window.setInterval(() => setTimerNow(now()), 1000)
    return () => window.clearInterval(interval)
  }, [now, timer])

  async function savePlan() {
    if (!isOnline) return
    if (planAllocations.length === 0) return setError('Choose a category before saving the plan.')
    setError('')
    try {
      const result = await api.put('/plans/today', {
        availableMinutes: Number(availableMinutes),
        allocations: planAllocations.map(allocation => ({
          standardCategoryId: allocation.standardCategoryId,
          ...(allocation.personalCategoryId ? { personalCategoryId: allocation.personalCategoryId } : {}),
          plannedMinutes: allocation.plannedMinutes
        }))
      }) as { warning: { differenceMinutes: number } | null }
      setMessage(result.warning ? `Plan saved with a ${Math.abs(result.warning.differenceMinutes)} minute difference.` : 'Plan saved.')
    } catch {
      setError('Plan could not be saved. Your existing plan has not been changed.')
    }
  }

  async function timerCommand() {
    if (!isOnline) return setMessage('Offline: timer commands are unavailable; the running display remains visible.')
    if (timerBusy) return
    if (!timer && !selectedCategoryId) return setError('Choose a category before starting a timer.')
    const action = timer ? '/entries/timer/switch' : '/entries/timer/start'
    const body = { requestId: requestId(), standardCategoryId: selectedCategoryId, ...(selectedCrm ? { crmLink: { type: selectedCrm.type, id: selectedCrm.id } } : {}) }
    setError('')
    setTimerBusy(true)
    try {
      await api.post(action, body)
      await reconcile()
    } catch {
      setError('Timer command could not be completed. Check the current timer before trying again.')
    } finally {
      setTimerBusy(false)
    }
  }

  async function stopTimer() {
    if (!isOnline) return setMessage('Offline: timer commands are unavailable; the running display remains visible.')
    if (timerBusy) return
    setError('')
    setTimerBusy(true)
    try {
      await api.post('/entries/timer/stop', { requestId: requestId() })
      clearActiveTimer()
      setTimer(null)
      setSelectedCrm(null)
      setMessage('Timer stopped.')
    } catch {
      setError('Timer could not be stopped. Check the current timer before trying again.')
    } finally {
      setTimerBusy(false)
    }
  }

  if (loading) return <section className="workflow-page" aria-labelledby="today-heading"><h1 id="today-heading">Today</h1><p role="status">Loading today’s plan and timer…</p></section>

  return <section className="workflow-page" aria-labelledby="today-heading">
    <h1 id="today-heading">Today</h1>
    {!isOnline && <p className="offline-notice" role="status">Offline: plan, manual entry, and reflection changes are unavailable.</p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}

    <section className="workflow-card" aria-labelledby="timer-heading">
      <h2 id="timer-heading">Timer</h2>
      {timer && <><p className="running-timer">Running: {categoryName} {timer.crm && <span>{timer.crm.type}: {timer.crm.label}</span>}</p><p>Elapsed: {formatElapsed(timer.startedAt, timerNow)}</p></>}
      <label>Category<select aria-label="Timer category" value={selectedCategoryId} onChange={event => setSelectedCategoryId(event.target.value)}>
        {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select></label>
      <label>Optional CRM link<input value={crmQuery} onChange={event => setCrmQuery(event.target.value)} /></label>
      {selectedCrm && <p>Linked: {selectedCrm.type}: {selectedCrm.label} <button type="button" onClick={() => setSelectedCrm(null)}>Clear CRM link</button></p>}
      {crmResults.length > 0 && <div aria-label="CRM search results" role="listbox">{crmResults.map(result => <button aria-selected="false" key={`${result.type}-${result.id}`} role="option" type="button" onClick={() => { setSelectedCrm(result); setCrmQuery(''); setCrmResults([]) }}>{result.type}: {result.label}</button>)}</div>}
      <div className="timer-actions">
        <button className="primary-timer" disabled={timerBusy} onClick={() => void timerCommand()}>{timer ? 'Switch timer' : 'Start timer'}</button>
        {timer && <button className="stop-timer" disabled={timerBusy} onClick={() => void stopTimer()}>Stop timer</button>}
      </div>
    </section>

    <section className="workflow-card" aria-labelledby="plan-heading">
      <h2 id="plan-heading">Daily plan</h2>
      {variance !== null && <p role="status">{variance} minutes differ from the plan.</p>}
      <label>Available minutes<input aria-label="Available minutes" type="number" min="0" max="1440" value={availableMinutes} onChange={event => setAvailableMinutes(event.target.value)} /></label>
      {planAllocations.map((allocation, index) => {
        const category = categories.find(item => item.id === allocation.standardCategoryId)
        const label = planAllocations.length === 1 ? 'Planned minutes' : `${category?.name ?? 'Category'} planned minutes`
        return <label key={`${allocation.standardCategoryId}-${allocation.personalCategoryId ?? 'standard'}-${index}`}>{label}<input aria-label={label} type="number" min="0" max="1440" value={allocation.plannedMinutes} onChange={event => setPlanAllocations(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, plannedMinutes: Number(event.target.value) } : item))} /></label>
      })}
      <button onClick={() => void savePlan()}>Save plan</button>
    </section>
  </section>
}
