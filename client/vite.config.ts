import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on all network interfaces (0.0.0.0), not just localhost, so other
    // machines on the LAN can reach the app at http://<host-ip>:5173.
    host: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/uploads': 'http://localhost:3001',
      '/branding': 'http://localhost:3001',
    },
  },
});
