import { useEffect, useState } from 'react'
import { apiClient } from '../../api/client'
import './admin-summary-page.css'

type Api = { get: (path: string) => Promise<unknown>, post: (path: string, body: unknown) => Promise<unknown> }
type AdminSummary = { user: { id: string, name: string }, metrics: { completion: { plan: boolean, time: boolean }, planVarianceMinutes: number, coreWorkRatio: number | null } }
type TeamKeyword = { keyword: string, contributorCount: number, occurrenceCount: number }

export function toAdminSummaries(value: unknown): AdminSummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const row = item as Partial<AdminSummary>
    if (typeof row.user?.id !== 'string' || typeof row.user.name !== 'string' || typeof row.metrics?.planVarianceMinutes !== 'number' || typeof row.metrics.coreWorkRatio !== 'number' && row.metrics.coreWorkRatio !== null || typeof row.metrics.completion?.plan !== 'boolean' || typeof row.metrics.completion.time !== 'boolean') return []
    return [{ user: { id: row.user.id, name: row.user.name }, metrics: { completion: { plan: row.metrics.completion.plan, time: row.metrics.completion.time }, planVarianceMinutes: row.metrics.planVarianceMinutes, coreWorkRatio: row.metrics.coreWorkRatio } }]
  })
}

function toTeamKeywords(value: unknown): TeamKeyword[] {
  const response = value as { keywords?: unknown }
  if (!Array.isArray(response?.keywords)) return []
  return response.keywords.flatMap(item => {
    const keyword = item as Partial<TeamKeyword>
    return typeof keyword.keyword === 'string' && typeof keyword.contributorCount === 'number' && typeof keyword.occurrenceCount === 'number'
      ? [{ keyword: keyword.keyword, contributorCount: keyword.contributorCount, occurrenceCount: keyword.occurrenceCount }]
      : []
  })
}

function variance(minutes: number) { return minutes === 0 ? 'On plan' : `${Math.abs(minutes)} minutes ${minutes > 0 ? 'over' : 'under'} plan` }

export function AdminSummaryPage({ api = apiClient, businessDate = new Date().toISOString().slice(0, 10) }: { api?: Api, businessDate?: string }) {
  const [summaries, setSummaries] = useState<AdminSummary[]>([])
  const [keywords, setKeywords] = useState<TeamKeyword[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    void Promise.all([api.get(`/analytics/admin/members/${businessDate}`), api.post('/analytics/admin/team-keywords', { periodStart: businessDate, periodEnd: businessDate })])
      .then(([members, team]) => { setSummaries(toAdminSummaries(members)); setKeywords(toTeamKeywords(team)) })
      .catch(() => setError('Admin summaries could not be loaded.'))
  }, [api, businessDate])

  return <section className="workflow-page" aria-labelledby="admin-heading">
    <h1 id="admin-heading">Team summary</h1>
    {error && <p role="alert">{error}</p>}
    <section className="workflow-card" aria-labelledby="member-summary-heading"><h2 id="member-summary-heading">Member time summaries</h2>
      <ul>{summaries.map(summary => <li key={summary.user.id}><strong>{summary.user.name}</strong>: {variance(summary.metrics.planVarianceMinutes)}, {summary.metrics.coreWorkRatio === null ? 'no tracked time' : `${Math.round(summary.metrics.coreWorkRatio * 100)}% core work`}</li>)}</ul>
    </section>
    <section className="workflow-card" aria-labelledby="keywords-heading"><h2 id="keywords-heading">Team keywords</h2>
      <ul>{keywords.map(keyword => <li key={keyword.keyword}>{keyword.keyword} ({keyword.contributorCount} contributors)</li>)}</ul>
    </section>
  </section>
}
