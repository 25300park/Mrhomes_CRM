import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { PushSettingsPage } from '../src/features/settings/push-settings-page'

afterEach(cleanup)

describe('push settings', () => {
  test('shows pending reminders before permission and requests permission only after an explicit action', async () => {
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission)
    const subscribe = vi.fn(async () => ({ toJSON: () => ({ endpoint: 'https://push.example/subscription', keys: { p256dh: 'public', auth: 'auth' } }) }))
    const register = vi.fn(async () => ({ pushManager: { subscribe } }))
    const api = { get: vi.fn(async (path: string) => path === '/push/vapid-public-key'
      ? { publicKey: 'AQID' }
      : { reminders: [{ businessDate: '2026-07-29' }] }), post: vi.fn(async () => ({ ok: true })) }
    render(<PushSettingsPage api={api} notification={{ permission: 'default', requestPermission }} serviceWorker={{ register }} />)

    expect(await screen.findByText('Reflection reminder pending for 2026-07-29')).toBeInTheDocument()
    expect(requestPermission).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Enable push reminders' }))

    await waitFor(() => expect(register).toHaveBeenCalledWith('/time-management/sw.js', { scope: '/time-management/' }))
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) })
    expect(api.post).toHaveBeenCalledWith('/push/subscriptions', { endpoint: 'https://push.example/subscription', keys: { p256dh: 'public', auth: 'auth' } })
  })
})
