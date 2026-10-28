import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['tests/**/*.spec.{ts,tsx}'], pool: 'forks', maxWorkers: 3, testTimeout: 30000 } })
