import { expect, test } from '@playwright/test'
import { installSafeRoutes } from './support/routes'

test('cookie attributes, CSRF, strict CORS, private API denial, and no saved passwords hold at the real server boundary', async ({ page, request, playwright }) => {
  const login = await request.post('/api/auth/login', { data: { email: 'release-admin@example.test', password: 'fixture-password' } })
  expect(login.status()).toBe(200)
  const cookie = login.headers()['set-cookie']
  expect(cookie).toContain('crm_session=')
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Lax')
  expect(cookie).toContain('Path=/')
  expect(cookie).not.toContain('fixture-password')

  expect((await request.post('/api/auth/change-password', { data: {} })).status()).toBe(403)
  const csrf = await (await request.get('/api/auth/csrf')).json()
  expect((await request.post('/api/auth/logout', { headers: { 'X-CSRF-Token': csrf.csrfToken } })).status()).toBe(200)

  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4177' })
  const denied = await anonymous.get('/api/time-management/analytics/admin/members/2026-07-29')
  expect(denied.status()).toBe(401)
  expect(JSON.stringify(await denied.json())).not.toContain('reflection')
  const cors = await anonymous.get('/health', { headers: { Origin: 'https://evil.example' } })
  expect(cors.status()).toBe(403)
  expect(cors.headers()).not.toHaveProperty('access-control-allow-origin')
  await anonymous.dispose()

  await page.addInitScript(() => {
    localStorage.setItem('crm_saved_password', 'must-be-deleted')
    localStorage.setItem('crm_remember_user', 'must-be-deleted')
  })
  await installSafeRoutes(page)
  await page.goto('/')
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => /^crm_(?:saved_|remember)/.test(key)))).toEqual([])
  await expect(page.locator('#lpw')).toHaveValue('')
})

test('admin responses, browser logs, and outbound requests never expose private reflection text', async ({ page }) => {
  const privateText = 'PRIVATE-REFLECTION-TASK12'
  const consoleLines: string[] = []
  page.on('console', message => consoleLines.push(message.text()))
  const fixture = await installSafeRoutes(page)
  await page.goto('/time-management/review')
  await page.getByRole('textbox', { name: 'Daily reflection' }).fill(privateText)
  await page.getByRole('button', { name: 'Save reflection' }).click()
  await expect(page.getByText('AI review is ready below.')).toBeVisible()
  await page.goto('/time-management/admin')
  await expect(page.getByText(/Agent One/)).toBeVisible()
  expect(JSON.stringify(fixture.calls.filter(call => call.path.includes('/analytics/admin/')))).not.toContain(privateText)
  expect(JSON.stringify(consoleLines)).not.toContain(privateText)
  expect(JSON.stringify(fixture.externalRequests)).not.toContain(privateText)
})

test('runtime Push payload is generic even when a job contains private fields', async () => {
  process.env.TIME_PUSH_ACTIVE_KEY_ID = 'current'
  process.env.TIME_PUSH_ENCRYPTION_KEYS = `current=${Buffer.alloc(32, 7).toString('base64')}`
  const { encryptPushKey, sendReflectionReminder } = require('../services/time-management/push')
  const filters: Record<string, unknown> = {}
  const subscription = {
    id: 'subscription-1', endpoint: 'https://push.example.test/subscription',
    p256dh: encryptPushKey('public-key'), auth_secret: encryptPushKey('auth-secret')
  }
  const supabase = {
    from(table: string) {
      const query = {
        select() { return query },
        eq(key: string, value: unknown) { filters[key] = value; return query },
        single: async () => table === 'time_reflections'
          ? { data: null, error: { code: 'PGRST116' } }
          : { data: { work_end_time: '18:00:00', in_app_enabled: true, push_enabled: true }, error: null },
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve({ data: table === 'time_push_subscriptions' ? [subscription] : [], error: null }).then(resolve, reject)
        }
      }
      return query
    }
  }
  let delivered: Record<string, unknown> | undefined
  const result = await sendReflectionReminder({
    supabase,
    job: { user_id: 'agent-1', payload: { businessDate: '2026-07-29', reflectionText: 'PRIVATE-PUSH-TEXT', secret: 'PRIVATE-SECRET' } },
    resolveAddresses: async () => [{ address: '142.250.72.14', family: 4 }],
    sender: async (message: Record<string, unknown>) => { delivered = message }
  })
  expect(result).toMatchObject({ push: 'SENT', inApp: 'PENDING' })
  expect(delivered).toBeDefined()
  expect(JSON.stringify(delivered)).not.toContain('PRIVATE')
  expect((delivered!.payload as Record<string, unknown>).url).toBe('/time-management#reflection')
})
