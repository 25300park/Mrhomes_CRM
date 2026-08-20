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

  const readStatuses = await page.evaluate(async () => {
    const paths = [
      '/api/dashboard', '/api/contacts', '/api/listings', '/api/leads', '/api/deals',
      '/api/staff/performance?period=2026-07', '/api/accounting/summary?period=2026-07',
      '/api/listing-reports', '/api/loi', '/api/ack', '/api/pms-payments', '/api/pms-care',
      '/api/pms-accounts/contact/60000000-0000-4000-8000-000000000001', '/api/pms-documents',
      '/api/notifications/followup', '/api/notifications/count'
    ]
    return Promise.all(paths.map(async path => ({ path, status: (await fetch(path, { credentials: 'same-origin' })).status })))
  })
  expect(readStatuses.filter(result => result.status !== 200)).toEqual([])

  const mutationStatuses = await page.evaluate(async () => {
    const csrf = await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json()
    const request = async (path: string, body: unknown) => {
      const response = await fetch(path, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken },
        body: JSON.stringify(body)
      })
      return { path, status: response.status, body: await response.json() }
    }
    return Promise.all([
      request('/api/contacts', { name: 'Local Write Contact', type: 'OWNER' }),
      request('/api/listings', { transaction_type: 'RENT', property_type: 'CONDO', name: 'Local Write Listing' }),
      request('/api/leads', { contact_id: '60000000-0000-4000-8000-000000000001', request_type: 'RENT' }),
      request('/api/deals', { listing_id: '61000000-0000-4000-8000-000000000001', contract_type: 'RENT', contract_date: '2026-07-29' }),
      request('/api/listing-reports', { client_name: 'Local Write Report', report_date: '2026-07-29', agent_name: 'Release Admin', listing_ids: [] }),
      request('/api/accounting/expenses', { category: 'TEST_ONLY', description: 'Local fixture', amount: 1, date: '2026-07-29' })
    ])
  })
  expect(mutationStatuses.map(result => result.status)).toEqual([201, 201, 201, 201, 201, 201])

  const notificationResponse = await page.evaluate(async () => (await fetch('/api/notifications/followup', { credentials: 'same-origin' })).json())
  expect(notificationResponse).toEqual([])
  const uploadResponse = await page.evaluate(async () => {
    const csrf = await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json()
    const data = new FormData()
    data.append('photo', new Blob(['safe fixture'], { type: 'image/png' }), 'fixture.png')
    return (await fetch('/api/upload/photo', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf.csrfToken }, body: data })).json()
  })
  expect(uploadResponse.url).toMatch(/^\/safe-fixtures\/.*\.png$/)
  expect(uploadResponse.path).toMatch(/^listings\/.*\.png$/)

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
  const state = await fixture.snapshot()
  for (const target of ['contacts', 'listings', 'leads', 'deals', 'users', 'expenses', 'listing_reports', 'payment_schedules', 'care_service_requests', 'pms_auth_map', 'pms_documents', 'v_leads_followup']) {
    expect(state.calls.some(call => call.target === target), `expected real DB call for ${target}`).toBe(true)
  }
  expect(state.calls.some(call => call.operation === 'storage.upload' && call.target === 'property-photos')).toBe(true)
})
