import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Node's process, without pulling in @types/node for one variable.
declare const process: { env: Record<string, string | undefined> }

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // ONAS_API points the dev server at another API, e.g. a test instance on :3101.
      '/api': process.env.ONAS_API || 'http://localhost:3000',
    },
  },
})
