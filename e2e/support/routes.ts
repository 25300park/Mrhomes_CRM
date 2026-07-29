import type { Page } from '@playwright/test'

export type FixtureCall = { operation: string, target: string, args?: unknown }

export type FixtureSnapshot = {
  calls: FixtureCall[]
  externalRequests: string[]
  activeTimer: Record<string, unknown> | null
  logs: string[]
  outbound: unknown[]
}

export type FixtureState = {
  externalRequests: string[]
  failNext(target: string, status?: number): Promise<void>
  delayNext(target: string, delayMs: number): Promise<void>
  setServerTimer(timer: Record<string, unknown> | null): Promise<void>
  snapshot(): Promise<FixtureSnapshot>
}

const ORIGIN = 'http://127.0.0.1:4177'

async function control(page: Page, body: Record<string, unknown>) {
  const response = await page.request.post('/__e2e/control', { data: body })
  if (!response.ok()) throw new Error(`E2E control failed: ${response.status()} ${await response.text()}`)
}

export async function installSafeRoutes(page: Page, options: { role?: 'admin' | 'agent', reminderDate?: string } = {}): Promise<FixtureState> {
  const externalRequests: string[] = []
  const reset = await page.request.post('/__e2e/reset', { data: options })
  if (!reset.ok()) throw new Error(`E2E reset failed: ${reset.status()} ${await reset.text()}`)
  await page.route('**/*', async route => {
    const requestUrl = route.request().url()
    if (new URL(requestUrl).origin === ORIGIN) return route.fallback()
    externalRequests.push(requestUrl)
    return route.abort('blockedbyclient')
  })
  return {
    externalRequests,
    failNext: (target, status = 503) => control(page, { action: 'failNext', target, status }),
    delayNext: (target, delayMs) => control(page, { action: 'delayNext', target, delayMs }),
    setServerTimer: timer => control(page, { action: 'setServerTimer', timer }),
    async snapshot() {
      const response = await page.request.get('/__e2e/state')
      if (!response.ok()) throw new Error(`E2E state failed: ${response.status()}`)
      const snapshot = await response.json() as FixtureSnapshot
      snapshot.externalRequests = [...externalRequests]
      return snapshot
    }
  }
}
