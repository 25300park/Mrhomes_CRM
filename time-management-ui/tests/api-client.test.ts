import { describe, expect, test, vi } from 'vitest'
import { ApiClientError, createApiClient } from '../src/api/client'

function response(status: number, body: unknown, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } })
}

describe('time-management API client', () => {
  test('sends same-origin credentials to relative time-management endpoints', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200, { entries: [] }))
    const client = createApiClient({ fetchFn })

    await client.get('/entries')

    expect(fetchFn).toHaveBeenCalledWith('/api/time-management/entries', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      method: 'GET'
    })
  })

  test('gets a CSRF token and sends it for mutations', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(201, { id: 'entry-1' }))
    const getCsrfToken = vi.fn().mockResolvedValue('csrf-token')
    const client = createApiClient({ fetchFn, getCsrfToken })

    await client.post('/entries/manual', { categoryId: 'work' })

    expect(fetchFn).toHaveBeenCalledWith('/api/time-management/entries/manual', {
      body: JSON.stringify({ categoryId: 'work' }),
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'csrf-token'
      },
      method: 'POST'
    })
  })

  test('returns a stable structured error from the API response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(422, {
      error: { code: 'ENTRY_INVALID', message: 'Entry is invalid.', requestId: 'request-123' }
    }))
    const client = createApiClient({ fetchFn })

    await expect(client.get('/entries')).rejects.toEqual(new ApiClientError({
      code: 'ENTRY_INVALID',
      message: 'Entry is invalid.',
      requestId: 'request-123',
      status: 422
    }))
  })

  test('uses a stable fallback error when the error payload is malformed', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('not JSON', { status: 500 }))
    const client = createApiClient({ fetchFn })

    await expect(client.get('/entries')).rejects.toEqual(new ApiClientError({
      code: 'REQUEST_FAILED',
      message: 'Time management request failed.',
      status: 500
    }))
  })

  test('returns the user to the CRM login when the shared session is no longer valid', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in again.' } }))
    const redirectToLogin = vi.fn()
    const client = createApiClient({ fetchFn, redirectToLogin })

    await expect(client.get('/entries')).rejects.toMatchObject({ status: 401 })

    expect(redirectToLogin).toHaveBeenCalledWith('/')
  })

  test('does not add a Supabase SDK dependency to the browser module', async () => {
    const manifest = await import('../package.json')

    expect(manifest.default.dependencies).not.toHaveProperty('@supabase/supabase-js')
  })
})
