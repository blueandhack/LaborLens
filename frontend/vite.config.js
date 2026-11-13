import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // The deployed commit (CI passes it as a Docker build arg); shown in the footer.
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(process.env.APP_VERSION || ''),
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    watch: {
      usePolling: true
    },
    proxy: {
      '/api': {
        target: process.env.BACKEND_URL || 'http://localhost:5001',
        changeOrigin: true
      }
    }
  }
})
