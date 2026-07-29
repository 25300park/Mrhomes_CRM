import { expect, test } from '@playwright/test'
import { installSafeRoutes } from './support/routes'

test('direct refresh and base-path assets remain runnable', async ({ page }) => {
  await installSafeRoutes(page)
  const assetResponses: number[] = []
  page.on('response', response => { if (response.url().includes('/time-management/assets/')) assetResponses.push(response.status()) })
  await page.goto('/time-management/records')
  await expect(page.getByRole('heading', { name: 'Records' })).toBeVisible()
  await expect(page.locator('script[src^="/time-management/assets/"]')).toHaveCount(1)
  expect(assetResponses.length).toBeGreaterThan(0)
  expect(assetResponses.every(status => status === 200)).toBe(true)
})

test('duplicate request IDs are idempotent and a timed-out backend fails closed', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: () => 'duplicate-request-id' }) })
  const fixture = await installSafeRoutes(page)
  await page.goto('/time-management/')
  await page.getByRole('button', { name: 'Start timer' }).click()
  await page.getByRole('button', { name: 'Switch timer' }).click()
  const commandCalls = () => fixture.calls.filter(call => call.path.includes('/entries/timer/') && !call.path.includes('/reconcile'))
  await expect.poll(() => commandCalls().length).toBe(2)
  const commands = commandCalls()
  expect(commands.map(call => (call.body as { requestId: string }).requestId)).toEqual(['duplicate-request-id', 'duplicate-request-id'])
  await expect(page.getByText(/Running: Core work/)).toBeVisible()
  fixture.failNext('/api/time-management/categories', 504)
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('Today data could not be loaded')
})

test('offline timer remains visible and reconnect reconciles a newer authoritative timer', async ({ page, context }) => {
  const fixture = await installSafeRoutes(page)
  await page.goto('/time-management/')
  await page.getByRole('button', { name: 'Start timer' }).click()
  await context.setOffline(true)
  await expect(page.getByText(/Offline: plan, manual entry, and reflection changes/)).toBeVisible()
  await expect(page.getByText(/Running: Core work/)).toBeVisible()
  await page.getByRole('button', { name: 'Switch timer' }).click()
  await expect(page.getByText(/Offline: timer commands are unavailable/)).toBeVisible()
  fixture.setServerTimer({ id: 'newer-server-entry', standard_category_id: 'category-client', started_at: '2026-07-29T02:00:00.000Z', linked_entity_type: null, linked_entity_id: null, linked_entity_label: null })
  await context.setOffline(false)
  await expect(page.getByText(/Running: Client service/)).toBeVisible()
})

test('Push denial keeps deterministic in-app reminder fallback', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'denied', requestPermission: async () => 'denied' } }) })
  await installSafeRoutes(page, { reminderDate: '2026-07-29' })
  await page.goto('/time-management/settings')
  await expect(page.getByText('Reflection reminder pending for 2026-07-29')).toBeVisible()
  await page.getByRole('button', { name: 'Enable push reminders' }).click()
  await expect(page.getByText('Push permission was not granted. In-app reminders remain available.')).toBeVisible()
})
