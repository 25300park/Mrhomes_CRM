import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

test('service worker always uses the approved generic reflection notification copy', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../public/sw.js'), 'utf8')

  expect(source).not.toContain('event.data')
  expect(source).toContain("'Time management reminder'")
  expect(source).toContain("'Please complete your daily reflection.'")
  expect(source).toContain("'/time-management#reflection'")
})
