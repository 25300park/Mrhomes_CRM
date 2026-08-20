export type ActiveTimerDisplay = {
  entryId: string
  categoryId: string
  startedAt: string
  crm: { type: string, id: string, label: string } | null
}

const STORAGE_KEY = 'time-management.active-timer'

function isDisplay(value: unknown): value is ActiveTimerDisplay {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  const crm = candidate.crm
  const validCrm = crm === null || (typeof crm === 'object' && crm !== null &&
    typeof (crm as Record<string, unknown>).type === 'string' &&
    typeof (crm as Record<string, unknown>).id === 'string' &&
    typeof (crm as Record<string, unknown>).label === 'string')
  return typeof candidate.entryId === 'string' && typeof candidate.categoryId === 'string' &&
    typeof candidate.startedAt === 'string' && !Number.isNaN(Date.parse(candidate.startedAt)) && validCrm
}

export function loadActiveTimer(): ActiveTimerDisplay | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    return isDisplay(value) ? value : null
  } catch {
    return null
  }
}

export function saveActiveTimer(display: ActiveTimerDisplay): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(display))
}

export function clearActiveTimer(): void {
  window.localStorage.removeItem(STORAGE_KEY)
}
