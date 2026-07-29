const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function runRootBuild() {
  if (process.platform === 'win32') {
    return spawnSync(process.env.ComSpec, ['/d', '/s', '/c', 'npm.cmd run build:time'], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8'
    })
  }
  return spawnSync('npm', ['run', 'build:time'], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8'
  })
}

test('the root time-management build script produces the CRM-hosted UI', () => {
  const result = runRootBuild()

  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  const index = fs.readFileSync(path.resolve(__dirname, '../../public/time-management/index.html'), 'utf8')
  const script = index.match(/src="\/time-management\/(assets\/[^\"]+\.js)"/)

  expect(index).toContain('<div id="root"></div>')
  expect(script).not.toBeNull()
  expect(fs.readFileSync(path.resolve(__dirname, '../../public/time-management', script[1]), 'utf8')).not.toContain('jsxDEV')
})
