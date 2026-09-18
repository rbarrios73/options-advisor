import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API looks same-origin to the app, so there is no CORS juggling in the client.
    proxy: { '/api': 'http://localhost:4000' },
  },
});
