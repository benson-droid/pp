import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the built app works when served from a GitHub Pages
  // project site (https://<user>.github.io/<repo>/) without hardcoding the
  // repo name here.
  base: './',
  plugins: [react()],
  worker: {
    format: 'es',
  },
})
