const { defineConfig } = require('vitest/config')

module.exports = defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.{test,spec}.{js,ts,jsx,tsx}'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 10_000
  }
})
