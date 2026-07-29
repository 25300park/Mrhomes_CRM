import { expect, test } from '@playwright/test'
import jwt from 'jsonwebtoken'
import { installSafeRoutes } from './support/routes'

async function login(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.locator('#lem').fill('release-admin@example.test')
  await page.locator('#lpw').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page.locator('.ph-title')).toHaveText('Dashboard')
}

test('legacy CRM navigation, notifications, upload, password change, logout, and Bearer auth regressions stay runnable', async ({ page, request }) => {
  const fixture = await installSafeRoutes(page)
  await login(page)

  const views = [
    ['contacts', 'Contacts'], ['listings', 'Listings'], ['leads', 'Lead Pipeline'], ['deals', 'Deals & Commission'],
    ['documents', 'Documents'], ['accounting', 'Accounting'], ['staff', 'Staff Performance']
  ] as const
  for (const [view, title] of views) {
    await page.locator(`button[data-v="${view}"]`).click()
    await expect(page.locator('.ph-title')).toContainText(title)
  }
  for (const view of ['pms-payments', 'pms-care']) {
    await page.locator(`button[data-v="${view}"]`).click()
    await expect(page.locator('.ph-title')).toContainText('PMS')
  }

  const notificationResponse = await page.evaluate(async () => (await fetch('/api/notifications/followup', { credentials: 'same-origin' })).json())
  expect(notificationResponse).toEqual([])
  const uploadResponse = await page.evaluate(async () => {
    const data = new FormData()
    data.append('file', new Blob(['safe fixture']), 'fixture.txt')
    return (await fetch('/api/upload/photo', { method: 'POST', credentials: 'same-origin', body: data })).json()
  })
  expect(uploadResponse).toEqual({ url: '/safe-fixtures/upload.jpg' })

  const changed = await page.evaluate(async () => {
    const csrf = await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json()
    const response = await fetch('/api/auth/change-password', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken }, body: JSON.stringify({ current: 'fixture-password', next_pw: 'fixture-password-next' }) })
    return response.status
  })
  expect(changed).toBe(200)
  const restored = await page.evaluate(async () => {
    const csrf = await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json()
    return (await fetch('/api/auth/change-password', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken }, body: JSON.stringify({ current: 'fixture-password-next', next_pw: 'fixture-password' }) })).status
  })
  expect(restored).toBe(200)

  const bearer = jwt.sign({ id: '10000000-0000-4000-8000-000000000001', role: 'agent' }, 'task-12-local-fixture-secret-with-32-bytes')
  const me = await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${bearer}` } })
  expect(me.status()).toBe(200)
  expect((await me.json()).role).toBe('admin')

  await page.locator('button[onclick="doLogout()"]').click()
  await expect(page.locator('#login-screen')).toBeVisible()
  expect(fixture.calls.some(call => call.path.startsWith('/api/notifications/'))).toBe(true)
  expect(fixture.calls.some(call => call.path.startsWith('/api/upload/'))).toBe(true)
})
