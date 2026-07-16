const fs = require('node:fs')
const path = require('node:path')

test('browser bundle never persists CRM passwords or authentication tokens', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8')
  expect(html).not.toMatch(/crm_saved_pw|crm_remember|crm_saved_email/)
  expect(html).not.toMatch(/localStorage\.setItem\([^\n]*(?:password|token)/i)
  expect(html).not.toMatch(/Authorization['"]?\s*:\s*['"]Bearer/)
})
