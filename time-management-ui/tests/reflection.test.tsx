import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ReflectionPanel } from '../src/features/reflection/reflection-panel'

afterEach(cleanup)

function client() {
  return {
    get: vi.fn(async () => ({ reflection: null, review: null })),
    put: vi.fn(async () => ({
      reflection: { id: 'reflection-1', reflection_text: 'Kept the client promise and need a quieter morning.', version: 1 },
      job: { id: 'job-1' }
    }))
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

  test('keeps the original text visible after AI failure and retries with the existing save contract', async () => {
    const api = {
      get: vi.fn(async (path: string) => path === '/reflections/today'
        ? { reflection: { reflection_text: 'A careful client follow-up.' }, review: null }
        : { status: 'FAILED' }),
      put: vi.fn(async () => ({ reflection: { reflection_text: 'A careful client follow-up.', version: 2 }, job: { id: 'job-2' } }))
    }
    render(<ReflectionPanel api={api} online />)

    expect(await screen.findByRole('alert')).toHaveTextContent('AI review could not be completed')
    expect((screen.getByRole('textbox', { name: 'Daily reflection' }) as HTMLTextAreaElement).value).toBe('A careful client follow-up.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry AI review' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/reflections/today', { reflectionText: 'A careful client follow-up.' }))
    expect(screen.getByRole('status')).toHaveTextContent('AI review is processing')
  })
})
