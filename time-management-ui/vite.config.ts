import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/time-management/',
  plugins: [react()],
  build: {
    outDir: '../public/time-management',
    emptyOutDir: true
  },
  test: {
    environment: 'jsdom',
    setupFiles: './tests/setup.ts'
  }
})
