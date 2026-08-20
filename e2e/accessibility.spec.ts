import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { installSafeRoutes } from './support/routes'

async function expectNoSeriousViolations(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  const serious = results.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
    .map(violation => ({ id: violation.id, impact: violation.impact, targets: violation.nodes.map(node => node.target) }))
  expect(serious).toEqual([])
}

test('CRM login has no serious or critical axe violations', async ({ page }) => {
  await installSafeRoutes(page)
  await page.goto('/')
  await expect(page.locator('#login-screen')).toBeVisible()
  await expectNoSeriousViolations(page)
})

for (const route of ['/', '/records', '/review', '/settings', '/admin']) {
  test(`time-management ${route} has no serious or critical axe violations`, async ({ page }) => {
    await installSafeRoutes(page)
    const login = await page.request.post('/api/auth/login', { data: { email: 'release-admin@example.test', password: 'fixture-password' } })
    expect(login.status()).toBe(200)
    await page.goto(`/time-management${route}`)
    await expect(page.locator('main h1')).toBeVisible()
    await expectNoSeriousViolations(page)
  })
}
