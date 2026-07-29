import { expect, test } from '@playwright/test'
import { installSafeRoutes } from './support/routes'

async function loginSession(page: import('@playwright/test').Page) {
  const response = await page.request.post('/api/auth/login', { data: { email: 'release-admin@example.test', password: 'fixture-password' } })
  expect(response.status()).toBe(200)
}

test('direct refresh and base-path assets remain runnable', async ({ page }) => {
  await installSafeRoutes(page)
  await loginSession(page)
  const assetResponses: number[] = []
  page.on('response', response => { if (response.url().includes('/time-management/assets/')) assetResponses.push(response.status()) })
  await page.goto('/time-management/records')
  await expect(page.getByRole('heading', { name: 'Records' })).toBeVisible()
  await expect(page.locator('script[src^="/time-management/assets/"]')).toHaveCount(1)
  expect(assetResponses.length).toBeGreaterThan(0)
  expect(assetResponses.every(status => status === 200)).toBe(true)
})

test('duplicate request IDs replay the original real RPC result', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: () => 'duplicate-request-id' }) })
  const fixture = await installSafeRoutes(page)
  await loginSession(page)
  await page.goto('/time-management/')
  await page.getByRole('button', { name: 'Start timer' }).click()
  await page.getByLabel('Timer category').selectOption('20000000-0000-4000-8000-000000000002')
  await page.getByRole('button', { name: 'Switch timer' }).click()
  await expect(page.getByText(/Running: Core work/)).toBeVisible()
  await expect.poll(async () => (await fixture.snapshot()).calls.filter(call => call.target === 'time_get_command_replay').length).toBe(2)
  const state = await fixture.snapshot()
  expect(state.calls.filter(call => call.target === 'time_get_command_replay')).toHaveLength(2)
  expect(state.calls.filter(call => call.target === 'time_start_timer')).toHaveLength(1)
  expect(state.calls.filter(call => call.target === 'time_switch_timer')).toHaveLength(0)
  expect(state.activeTimer?.standard_category_id).toBe('20000000-0000-4000-8000-000000000001')
})

test('a real RPC response delayed beyond the client deadline fails closed', async ({ page }) => {
  const fixture = await installSafeRoutes(page)
  await loginSession(page)
  await fixture.delayNext('time_start_timer', 10_500)
  await page.goto('/time-management/')
  await page.getByRole('button', { name: 'Start timer' }).click()
  await expect(page.getByRole('alert')).toContainText('Timer command could not be completed', { timeout: 12_000 })
  await expect(page.getByText(/Running:/)).toHaveCount(0)
  const state = await fixture.snapshot()
  expect(state.calls.filter(call => call.target === 'time_start_timer')).toHaveLength(1)
})

test('an injected RPC failure returns through the real service error contract', async ({ page }) => {
  const fixture = await installSafeRoutes(page)
  await loginSession(page)
  await fixture.failNext('time_start_timer')
  await page.goto('/time-management/')
  await page.getByRole('button', { name: 'Start timer' }).click()
  await expect(page.getByRole('alert')).toContainText('Timer command could not be completed')
  const state = await fixture.snapshot()
  expect(state.calls.filter(call => call.target === 'time_start_timer')).toHaveLength(1)
  expect(state.activeTimer).toBeNull()
})

test('offline timer remains visible and reconnect reconciles a newer authoritative timer', async ({ page, context }) => {
  const fixture = await installSafeRoutes(page)
  await loginSession(page)
  await page.goto('/time-management/')
  await page.getByRole('button', { name: 'Start timer' }).click()
  await expect(page.getByText(/Running: Core work/)).toBeVisible()
  await context.setOffline(true)
  await expect(page.getByText(/Offline: plan, manual entry, and reflection changes/)).toBeVisible()
  await page.getByRole('button', { name: 'Switch timer' }).click()
  await expect(page.getByText(/Offline: timer commands are unavailable/)).toBeVisible()
  await fixture.setServerTimer({ id: '50000000-0000-4000-8000-000000000099', standard_category_id: '20000000-0000-4000-8000-000000000002', started_at: '2026-07-29T23:00:00.000Z', linked_entity_type: null, linked_entity_id: null, linked_entity_label: null })
  await context.setOffline(false)
  await expect(page.getByText(/Running: Client service/)).toBeVisible()
})

test('Push denial keeps deterministic in-app reminder fallback', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'denied', requestPermission: async () => 'denied' } }) })
  await installSafeRoutes(page, { reminderDate: '2026-07-29' })
  await loginSession(page)
  await page.goto('/time-management/settings')
  await expect(page.getByText('Reflection reminder pending for 2026-07-29')).toBeVisible()
  await page.getByRole('button', { name: 'Enable push reminders' }).click()
  await expect(page.getByText('Push permission was not granted. In-app reminders remain available.')).toBeVisible()
})
