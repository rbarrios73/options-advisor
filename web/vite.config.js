import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The simulator runs the server's own pricing and metrics code in the browser, so a spread shows
// the same numbers on the Screener and Simulator pages. Those modules are pure (no Node APIs) and
// are imported straight from server/src/domain rather than copied — a copy would drift.
const domain = fileURLToPath(new URL('../server/src/domain', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@domain': domain },
  },
  server: {
    port: 5173,
    // The API looks same-origin to the app, so there is no CORS juggling in the client.
    proxy: { '/api': 'http://localhost:4000' },
    // Let the dev server read ../server/src/domain, which sits outside web/.
    fs: { allow: ['..'] },
  },
});
