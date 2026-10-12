import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Frontend dev server on :5173; API calls go to the FastAPI backend on :8000.
export default defineConfig({
  plugins: [react()],
  // strictPort so a busy 5173 fails loudly instead of silently drifting to
  // another port (which is how you lose track of where the app is running).
  server: { port: 5173, strictPort: true },
  // PGlite ships its Postgres runtime as .wasm + .data assets. Vite's esbuild
  // pre-bundling rewrites those asset URLs and breaks loading in dev (symptom:
  // "Invalid FS bundle size"). Excluding it makes Vite serve it untouched.
  optimizeDeps: {
    exclude: ['@electric-sql/pglite', '@electric-sql/pglite-react', '@electric-sql/pglite-sync'],
  },
})
