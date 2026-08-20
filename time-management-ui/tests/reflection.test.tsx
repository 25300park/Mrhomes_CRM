import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ReflectionPanel } from '../src/features/reflection/reflection-panel'

afterEach(cleanup)

function client() {
  return {
    get: vi.fn(async () => ({ reflection: null, review: null })),
    put: vi.fn(async () => ({
      reflection: { id: 'reflection-1', reflection_text: 'Kept the client promise and need a quieter morning.', version: 1 },
      job: { id: 'job-1' }
    })),
    post: vi.fn()
  }
}

describe('reflection editor', () => {
  test('saves the original text before showing AI processing state', async () => {
    const api = client()
    render(<ReflectionPanel api={api} online />)

    const editor = await screen.findByRole('textbox', { name: 'Daily reflection' })
    fireEvent.change(editor, { target: { value: 'Kept the client promise and need a quieter morning.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save reflection' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/reflections/today', {
      reflectionText: 'Kept the client promise and need a quieter morning.'
    }))
    expect((editor as HTMLTextAreaElement).value).toBe('Kept the client promise and need a quieter morning.')
    expect(screen.getByRole('status')).toHaveTextContent('AI review is processing')
  })

  test('keeps the original text visible after AI failure and retries the same saved version', async () => {
    const api = {
      get: vi.fn(async (path: string) => path === '/reflections/today'
        ? { reflection: { reflection_text: 'A careful client follow-up.' }, review: null }
        : { status: 'FAILED' }),
      put: vi.fn(async () => ({ reflection: { reflection_text: 'A careful client follow-up.', version: 2 }, job: { id: 'job-2' } })),
      post: vi.fn(async () => ({ reflection: { reflection_text: 'A careful client follow-up.', version: 1 }, job: { id: 'job-2' }, ai: { status: 'PROCESSING' } }))
    }
    render(<ReflectionPanel api={api} online />)

    expect(await screen.findByRole('alert')).toHaveTextContent('AI review could not be completed')
    expect((screen.getByRole('textbox', { name: 'Daily reflection' }) as HTMLTextAreaElement).value).toBe('A careful client follow-up.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry AI review' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/reflections/today/retry', {}))
    expect(api.put).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('AI review is processing')
  })

  test('keeps a loaded reflection visible when its separate AI status request fails', async () => {
    const api = {
      get: vi.fn(async (path: string) => path === '/reflections/today'
        ? { reflection: { reflection_text: 'The committed note remains visible.' }, review: null }
        : Promise.reject(new Error('status unavailable'))),
      put: vi.fn(), post: vi.fn()
    }
    render(<ReflectionPanel api={api} online />)

    expect((await screen.findByRole('textbox', { name: 'Daily reflection' }) as HTMLTextAreaElement).value)
      .toBe('The committed note remains visible.')
  })

  test('polls a processing AI review to completion without overlapping requests', async () => {
    vi.useFakeTimers()
    const get = vi.fn()
      .mockResolvedValueOnce({ reflection: null, review: null })
      .mockResolvedValueOnce({ status: 'NOT_STARTED' })
      .mockResolvedValueOnce({ status: 'PROCESSING' })
      .mockResolvedValueOnce({ status: 'COMPLETED' })
      .mockResolvedValueOnce({ reflection: { reflection_text: 'Saved note.' }, review: { id: 'review-1' } })
    const api = { get, put: vi.fn(async () => ({ reflection: { reflection_text: 'Saved note.' }, ai: { status: 'PROCESSING' } })), post: vi.fn() }
    render(<ReflectionPanel api={api} online />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Daily reflection' }), { target: { value: 'Saved note.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save reflection' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByRole('status')).toHaveTextContent('AI review is processing')
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(screen.getByRole('status')).toHaveTextContent('AI review is processing')
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(screen.getByRole('status')).toHaveTextContent('AI review is ready')
    expect(get).toHaveBeenCalledTimes(5)
    vi.useRealTimers()
  })

  test('stops polling and reports a failed AI review', async () => {
    vi.useFakeTimers()
    const get = vi.fn()
      .mockResolvedValueOnce({ reflection: null, review: null })
      .mockResolvedValueOnce({ status: 'NOT_STARTED' })
      .mockResolvedValueOnce({ status: 'FAILED' })
    const api = { get, put: vi.fn(async () => ({ reflection: { reflection_text: 'Saved note.' }, ai: { status: 'PROCESSING' } })), post: vi.fn() }
    render(<ReflectionPanel api={api} online />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Daily reflection' }), { target: { value: 'Saved note.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save reflection' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(screen.getByRole('alert')).toHaveTextContent('AI review could not be completed')
    expect(get).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })
})
