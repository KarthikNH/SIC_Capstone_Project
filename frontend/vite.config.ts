import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/grids': 'http://127.0.0.1:8000',
      '/grid': 'http://127.0.0.1:8000',
      '/layout': 'http://127.0.0.1:8000',
      '/predict': 'http://127.0.0.1:8000',
      '/whatif-curve': 'http://127.0.0.1:8000',
      '/criticality-map': 'http://127.0.0.1:8000',
      '/cascade-replay': 'http://127.0.0.1:8000',
      '/dataset': 'http://127.0.0.1:8000',
      '/insights': 'http://127.0.0.1:8000',
      '/mitigate': 'http://127.0.0.1:8000',
      '/chat': 'http://127.0.0.1:8000',
      '/results': 'http://127.0.0.1:8000',
      '/static': 'http://127.0.0.1:8000',
      '/templates': 'http://127.0.0.1:8000',
    }
  }
})
