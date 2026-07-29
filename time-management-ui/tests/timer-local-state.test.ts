import { afterEach, describe, expect, test } from 'vitest'
import { clearActiveTimer, loadActiveTimer, saveActiveTimer } from '../src/shared/timer-local-state'

afterEach(() => window.localStorage.clear())

describe('active timer display storage', () => {
  test('stores only the approved active-timer display snapshot', () => {
    saveActiveTimer({
      entryId: 'entry-1',
      categoryId: 'category-1',
      startedAt: '2026-07-29T01:00:00.000Z',
      crm: { type: 'CONTACT', id: 'contact-1', label: 'Alex Kim' }
    })

    expect(JSON.parse(window.localStorage.getItem('time-management.active-timer') ?? '{}')).toEqual({
      entryId: 'entry-1',
      categoryId: 'category-1',
      startedAt: '2026-07-29T01:00:00.000Z',
      crm: { type: 'CONTACT', id: 'contact-1', label: 'Alex Kim' }
    })
  })

  test('rejects stale or malformed local state', () => {
    window.localStorage.setItem('time-management.active-timer', JSON.stringify({ entryId: 'entry-1', notes: 'private text' }))

    expect(loadActiveTimer()).toBeNull()
  })

  test('clears the display snapshot when an active timer stops', () => {
    saveActiveTimer({ entryId: 'entry-1', categoryId: 'category-1', startedAt: '2026-07-29T01:00:00.000Z', crm: null })
    clearActiveTimer()

    expect(loadActiveTimer()).toBeNull()
  })
})
