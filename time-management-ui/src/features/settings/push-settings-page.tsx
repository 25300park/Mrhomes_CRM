import { useEffect, useState } from 'react'
import { apiClient } from '../../api/client'
import './push-settings-page.css'

type Api = { get: (path: string) => Promise<unknown>, post: (path: string, body: unknown) => Promise<unknown> }
type NotificationApi = { permission: NotificationPermission, requestPermission: () => Promise<NotificationPermission> }
type ServiceWorkerApi = { register: (scriptURL: string, options: RegistrationOptions) => Promise<{ pushManager: { subscribe: (options: PushSubscriptionOptionsInit) => Promise<{ toJSON: () => unknown }> } }> }
type Subscription = { endpoint: string, keys: { p256dh: string, auth: string } }

function subscriptionFrom(value: unknown): Subscription | null {
  const json = value as Partial<Subscription>
  return typeof json?.endpoint === 'string' && typeof json.keys?.p256dh === 'string' && typeof json.keys.auth === 'string' ? { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } } : null
}

export function PushSettingsPage({ api = apiClient, notification = window.Notification, serviceWorker = navigator.serviceWorker }: { api?: Api, notification?: NotificationApi, serviceWorker?: ServiceWorkerApi }) {
  const [reminders, setReminders] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void api.get('/push/reminders/pending').then(value => {
      const items = (value as { reminders?: Array<{ businessDate?: string, business_date?: string }> }).reminders || []
      setReminders(items.flatMap(item => typeof (item.businessDate ?? item.business_date) === 'string' ? [item.businessDate ?? item.business_date as string] : []))
    }).catch(() => setError('Pending reminders could not be loaded.'))
  }, [api])

  async function enablePush() {
    setError('')
    if (!notification || !serviceWorker) return setError('Push reminders are not supported in this browser.')
    const permission = notification.permission === 'granted' ? 'granted' : await notification.requestPermission()
    if (permission !== 'granted') return setMessage('Push permission was not granted. In-app reminders remain available.')
    try {
      const registration = await serviceWorker.register('/time-management/sw.js', { scope: '/time-management/' })
      const subscription = subscriptionFrom((await registration.pushManager.subscribe({ userVisibleOnly: true })).toJSON())
      if (!subscription) throw new Error('invalid subscription')
      await api.post('/push/subscriptions', subscription)
      setMessage('Push reminders are enabled.')
    } catch {
      setError('Push reminders could not be enabled. In-app reminders remain available.')
    }
  }

  return <section className="workflow-page" aria-labelledby="settings-heading">
    <h1 id="settings-heading">Reminder settings</h1>
    {reminders.map(date => <p key={date} role="status">Reflection reminder pending for {date}</p>)}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
    <section className="workflow-card"><h2>Push reminders</h2><p>In-app reminders remain available whether or not Push is enabled.</p><button onClick={() => void enablePush()}>Enable push reminders</button></section>
  </section>
}
