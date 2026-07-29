import { useEffect, useState } from 'react'
import { apiClient } from '../../api/client'
import './reflection-panel.css'

type Api = {
  get: (path: string) => Promise<unknown>
  put: (path: string, body: { reflectionText: string }) => Promise<unknown>
  post: (path: string, body: Record<string, never>) => Promise<unknown>
}

type ReflectionPanelProps = { api?: Api, online?: boolean }

type AiStatus = 'NOT_STARTED' | 'PROCESSING' | 'COMPLETED' | 'FAILED'

function stateFromStatus(status: unknown): 'processing' | 'completed' | 'failed' | null {
  if (status === 'PROCESSING') return 'processing'
  if (status === 'COMPLETED') return 'completed'
  if (status === 'FAILED') return 'failed'
  return null
}

function applyReflectionResponse(response: unknown, setText: (text: string) => void, setState: (state: 'processing' | 'completed' | 'failed') => void) {
  const value = response as { reflection?: { reflection_text?: string } | null, review?: unknown }
  if (value.reflection?.reflection_text) setText(value.reflection.reflection_text)
  if (value.review) setState('completed')
}

export function ReflectionPanel({ api = apiClient, online = true }: ReflectionPanelProps) {
  const [text, setText] = useState('')
  const [state, setState] = useState<'idle' | 'processing' | 'completed' | 'failed' | 'error'>('idle')

  useEffect(() => {
    void Promise.allSettled([api.get('/reflections/today'), api.get('/reflections/today/status')]).then(([reflectionResult, statusResult]) => {
      if (reflectionResult.status === 'fulfilled') applyReflectionResponse(reflectionResult.value, setText, setState)
      if (statusResult.status === 'fulfilled') {
        const next = stateFromStatus((statusResult.value as { status?: AiStatus }).status)
        if (next) setState(next)
      }
    })
  }, [api])

  useEffect(() => {
    if (state !== 'processing') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const maxAttempts = 5
    const poll = async () => {
      try {
        const response = await api.get('/reflections/today/status') as { status?: AiStatus }
        if (cancelled) return
        const next = stateFromStatus(response.status)
        if (next === 'completed') {
          setState('completed')
          void api.get('/reflections/today').then(value => applyReflectionResponse(value, setText, setState)).catch(() => undefined)
          return
        }
        if (next === 'failed') { setState('failed'); return }
      } catch {
        // A later bounded retry may still return the authoritative terminal state.
      }
      attempts += 1
      if (!cancelled && attempts < maxAttempts) timer = setTimeout(poll, Math.min(250 * 2 ** attempts, 2_000))
    }
    timer = setTimeout(poll, 250)
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [api, state])

  function saveResult(result: unknown) {
    const response = result as { ai?: { status?: AiStatus } }
    const next = stateFromStatus(response.ai?.status)
    setState(next || 'processing')
  }

  async function save() {
    if (!online || !text.trim()) return
    setState('idle')
    try {
      saveResult(await api.put('/reflections/today', { reflectionText: text.trim() }))
    } catch {
      setState('error')
    }
  }

  async function retryAiReview() {
    if (!online) return
    try {
      saveResult(await api.post('/reflections/today/retry', {}))
    } catch {
      setState('failed')
    }
  }

  return <section className="workflow-card reflection-panel" id="reflection" aria-labelledby="reflection-heading">
    <h2 id="reflection-heading">Daily reflection</h2>
    <p>Use one note for preparation, wins, problems, plan variance, and tomorrow.</p>
    <label htmlFor="daily-reflection">Daily reflection</label>
    <textarea id="daily-reflection" value={text} onChange={event => setText(event.target.value)} rows={9} />
    {!online && <p className="offline-notice" role="status">Offline: reflections are not queued. Reconnect before saving.</p>}
    {state === 'processing' && <p role="status">AI review is processing. Your original reflection is saved.</p>}
    {state === 'completed' && <p role="status">AI review is ready below.</p>}
    {state === 'failed' && <p role="alert">AI review could not be completed. Your original reflection remains available.</p>}
    {state === 'error' && <p role="alert">Reflection could not be saved. Your text remains here so you can retry.</p>}
    <button disabled={!online || !text.trim()} onClick={() => void (state === 'failed' ? retryAiReview() : save())}>{state === 'failed' ? 'Retry AI review' : 'Save reflection'}</button>
  </section>
}
