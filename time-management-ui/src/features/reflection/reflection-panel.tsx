import { useEffect, useState } from 'react'
import { apiClient } from '../../api/client'
import './reflection-panel.css'

type Api = {
  get: (path: string) => Promise<unknown>
  put: (path: string, body: { reflectionText: string }) => Promise<unknown>
}

type ReflectionPanelProps = { api?: Api, online?: boolean }

export function ReflectionPanel({ api = apiClient, online = true }: ReflectionPanelProps) {
  const [text, setText] = useState('')
  const [state, setState] = useState<'idle' | 'processing' | 'completed' | 'failed' | 'error'>('idle')

  useEffect(() => {
    void Promise.all([api.get('/reflections/today'), api.get('/reflections/today/status')]).then(([result, statusResult]) => {
      const response = result as { reflection?: { reflection_text?: string } | null, review?: unknown }
      const reflection = response.reflection
      if (reflection?.reflection_text) setText(reflection.reflection_text)
      if (response.review) setState('completed')
      else if ((statusResult as { status?: string }).status === 'FAILED') setState('failed')
      else if ((statusResult as { status?: string }).status === 'PROCESSING') setState('processing')
    }).catch(() => undefined)
  }, [api])

  async function save() {
    if (!online || !text.trim()) return
    setState('idle')
    try {
      await api.put('/reflections/today', { reflectionText: text.trim() })
      setState('processing')
    } catch {
      setState('error')
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
    <button disabled={!online || !text.trim()} onClick={() => void save()}>{state === 'failed' ? 'Retry AI review' : 'Save reflection'}</button>
  </section>
}
