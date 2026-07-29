import { useEffect, useState } from 'react'
import { apiClient } from '../../api/client'
import './records-page.css'

type Api = {
  get: (path: string) => Promise<unknown>
  post: (path: string, body?: Record<string, unknown>) => Promise<unknown>
  put: (path: string, body?: Record<string, unknown>) => Promise<unknown>
  patch: (path: string, body?: Record<string, unknown>) => Promise<unknown>
  delete: (path: string) => Promise<unknown>
}
type Category = { id: string, name: string }
type Revision = { id: string, changed_at: string, changed_by: string }
type Entry = {
  id: string
  standard_category_id: string
  started_at: string
  ended_at: string | null
  notes: string | null
  linked_entity_type: string | null
  linked_entity_id: string | null
  linked_entity_label: string | null
  revisions: Revision[]
}

type RecordsPageProps = { api?: Api, online?: boolean, requestId?: () => string }

function dateForApi(): string { return new Date().toISOString().slice(0, 10) }
function newRequestId(): string { return window.crypto.randomUUID?.() ?? `manual-${Date.now()}-${Math.random().toString(36).slice(2)}` }

export function RecordsPage({ api = apiClient, online = window.navigator.onLine, requestId = newRequestId }: RecordsPageProps) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [manualOpen, setManualOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState<Entry | null>(null)
  const [revisionConfirming, setRevisionConfirming] = useState(false)
  const [revisionNotes, setRevisionNotes] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      api.get(`/entries?businessDate=${dateForApi()}`),
      api.get('/categories')
    ]).then(([records, categoryData]) => {
      if (cancelled) return
      const recordData = records as { entries: Entry[] }
      const categoryDataTyped = categoryData as { standard: Category[] }
      setEntries(recordData.entries)
      setCategories(categoryDataTyped.standard)
      setCategoryId(categoryDataTyped.standard[0]?.id ?? '')
    }).catch(() => !cancelled && setError('Records could not be loaded. Try again when the CRM connection is available.'))
    return () => { cancelled = true }
  }, [api])

  async function createManual() {
    if (!online) return setMessage('Offline: manual entry changes are unavailable.')
    if (!confirming) return setConfirming(true)
    try {
      const endedAt = new Date()
      const startedAt = new Date(endedAt.getTime() - 30 * 60 * 1000)
      await api.post('/entries/manual', { requestId: requestId(), standardCategoryId: categoryId, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() })
      setManualOpen(false)
      setConfirming(false)
      setMessage('Manual entry saved.')
    } catch {
      setError('Manual entry could not be saved. No change was queued.')
    }
  }

  async function reviseEntry() {
    if (!editing) return
    if (!online) return setMessage('Offline: manual entry changes are unavailable.')
    if (!revisionConfirming) return setRevisionConfirming(true)
    try {
      await api.patch(`/entries/${editing.id}`, { requestId: requestId(), notes: revisionNotes })
      setEntries(current => current.map(entry => entry.id === editing.id ? { ...entry, notes: revisionNotes } : entry))
      setEditing(null)
      setRevisionConfirming(false)
      setMessage('Record revision saved.')
    } catch {
      setError('Record revision could not be saved. No change was queued.')
    }
  }

  return <section className="records-page" aria-labelledby="records-heading">
    <h1 id="records-heading">Records</h1>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
    <button onClick={() => { setManualOpen(true); setConfirming(false) }}>Add manual entry</button>
    {manualOpen && <section className="record-card" aria-labelledby="manual-heading">
      <h2 id="manual-heading">Manual entry</h2>
      <label>Category<select value={categoryId} onChange={event => setCategoryId(event.target.value)}>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
      <p>Creates a 30-minute entry ending now. Confirm before saving.</p>
      <button onClick={() => void createManual()}>{confirming ? 'Confirm manual entry' : 'Save manual entry'}</button>
    </section>}
    {editing && <section className="record-card" aria-labelledby="revision-heading">
      <h2 id="revision-heading">Revise record</h2>
      <label>Notes<textarea value={revisionNotes} onChange={event => setRevisionNotes(event.target.value)} /></label>
      <p>Confirm before replacing the record note.</p>
      <button onClick={() => void reviseEntry()}>{revisionConfirming ? 'Confirm revision' : 'Save revision'}</button>
    </section>}
    <div className="records-list">{entries.map(entry => <article className="record-card" key={entry.id}>
      <h2>{entry.started_at.slice(0, 10)}</h2>
      <p>{entry.notes || 'No notes'}</p>
      {entry.linked_entity_label && <><p>{entry.linked_entity_label}</p>{entry.linked_entity_id && <p>CRM link unavailable; showing stored snapshot.</p>}</>}
      <p>{entry.revisions.length} {entry.revisions.length === 1 ? 'revision' : 'revisions'}</p>
      <button onClick={() => { setEditing(entry); setRevisionNotes(entry.notes || ''); setRevisionConfirming(false) }}>Edit record</button>
    </article>)}</div>
  </section>
}
