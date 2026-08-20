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

    expect(fetchFn).toHaveBeenCalledWith('/api/time-management/entries', expect.objectContaining({
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      method: 'GET'
    }))
  })

  test('gets a CSRF token and sends it for mutations', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(201, { id: 'entry-1' }))
    const getCsrfToken = vi.fn().mockResolvedValue('csrf-token')
    const client = createApiClient({ fetchFn, getCsrfToken })

    await client.post('/entries/manual', { categoryId: 'work' })

    expect(fetchFn).toHaveBeenCalledWith('/api/time-management/entries/manual', expect.objectContaining({
      body: JSON.stringify({ categoryId: 'work' }),
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'csrf-token'
      },
      method: 'POST'
    }))
  })

  test.each([
    '/../auth/login',
    '/%2e%2e/auth/login',
    '/%2E%2E/auth/login',
    '/../auth/login?next=/api/time-management/entries',
    'https://evil.example/steal',
    '//evil.example/steal',
    '?path=/entries'
  ])('rejects namespace escape %s before acquiring or sending CSRF', async path => {
    const fetchFn = vi.fn().mockResolvedValue(response(200, {}))
    const getCsrfToken = vi.fn().mockResolvedValue('csrf-token')
    const client = createApiClient({ fetchFn, getCsrfToken })

    await expect(client.post(path, { private: true })).rejects.toThrow()

    expect(getCsrfToken).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test.each([
    ['/entries?businessDate=2026-07-29', '/api/time-management/entries?businessDate=2026-07-29'],
    ['/entries/../plans/today', '/api/time-management/plans/today'],
    ['/', '/api/time-management/']
  ])('canonicalizes valid relative path %s inside the namespace', async (path, expected) => {
    const fetchFn = vi.fn().mockResolvedValue(response(200, {}))
    const client = createApiClient({ fetchFn })

    await client.get(path)

    expect(fetchFn).toHaveBeenCalledWith(expected, expect.objectContaining({ method: 'GET' }))
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

  test('aborts a request that exceeds the configured deadline with a stable timeout error', async () => {
    const fetchFn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })) as unknown as typeof fetch
    const client = createApiClient({ fetchFn, requestTimeoutMs: 5 })

    await expect(client.get('/entries')).rejects.toEqual(new ApiClientError({
      code: 'REQUEST_TIMEOUT',
      message: 'Time management request timed out.',
      status: 408
    }))

    expect(fetchFn).toHaveBeenCalledWith('/api/time-management/entries', expect.objectContaining({
      method: 'GET',
      signal: expect.any(AbortSignal)
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
