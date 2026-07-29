import { useEffect, useState } from 'react'
import { apiClient } from '../../api/client'
import { ReflectionPanel } from '../reflection/reflection-panel'
import './personal-review-page.css'

type Api = {
  get: (path: string) => Promise<unknown>
  put?: (path: string, body: { reflectionText: string }) => Promise<unknown>
  post?: (path: string, body: Record<string, never>) => Promise<unknown>
}
type Metrics = { completion: { plan: boolean, time: boolean, reflection: boolean }, planVarianceMinutes: number, coreWorkRatio: number | null }

function completionLabel(completion: Metrics['completion']): string {
  const complete = [completion.plan && 'Plan', completion.time && 'time', completion.reflection && 'reflection'].filter(Boolean)
  const pending = [!completion.plan && 'plan', !completion.time && 'time', !completion.reflection && 'reflection'].filter(Boolean)
  return `${complete.length ? `${complete.join(' and ')} complete` : 'Nothing complete'}${pending.length ? `; ${pending.join(' and ')} pending` : ''}`
}

function varianceLabel(minutes: number): string {
  if (minutes === 0) return 'On plan'
  return `${Math.abs(minutes)} minutes ${minutes < 0 ? 'under' : 'over'} plan`
}

export function PersonalReviewPage({ api = apiClient, online = true }: { api?: Api, online?: boolean }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void api.get('/analytics/personal/today').then(result => setMetrics((result as { metrics: Metrics }).metrics))
      .catch(() => setError('Personal review could not be loaded.'))
  }, [api])

  return <section className="workflow-page" aria-labelledby="review-heading">
    <h1 id="review-heading">Personal review</h1>
    {error && <p role="alert">{error}</p>}
    {metrics ? <section aria-label="Daily metrics" className="review-metrics">
      <article><h2>Completion</h2><p>{completionLabel(metrics.completion)}</p></article>
      <article><h2>Plan variance</h2><p>{varianceLabel(metrics.planVarianceMinutes)}</p></article>
      <article><h2>Core-work ratio</h2><p>{metrics.coreWorkRatio === null ? 'No tracked time yet' : `${(metrics.coreWorkRatio * 100).toFixed(1)}% of tracked time`}</p></article>
    </section> : !error && <p role="status">Loading personal review?</p>}
    <ReflectionPanel api={{ get: api.get, put: api.put ?? apiClient.put, post: api.post ?? apiClient.post }} online={online} />
  </section>
}
