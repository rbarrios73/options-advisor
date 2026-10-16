// Entry point: build the app from the environment, prepare the database, then listen.
//
// Everything interesting is in app.js, which is a factory — see the comment there for why.

import { config } from './config.js';
import { createApp, prepare } from './app.js';
import { createDb } from './db.js';
import { startBriefTimer } from './brief.js';

const db = createDb(config);
const { app, accounts, users, provider, briefer, hasBuiltUi } = createApp({ config, db });

const guarded = !accounts && Boolean(config.authPassword);

prepare({ config, db, users, accounts })
  .then(() => {
    app.listen(config.port, () => {
      const where = config.production ? `port ${config.port}` : `http://localhost:${config.port}`;
      console.log(`options-advisor on ${where}  (provider: ${provider.name})`);

      if (provider.name === 'mock') {
        console.log('Provider is "mock": chains are synthetic. Set PROVIDER=tradier for real data.');
      }
      if (hasBuiltUi) {
        console.log('Serving the built UI from this process — open the same address in a browser.');
      }

      // The pre-market brief writes itself once the clock passes nine in New York. On a host that
      // sleeps — Render's free tier does — this timer will often miss it, which is why the route
      // also generates on demand. See brief.js.
      if (config.briefEnabled) {
        startBriefTimer(briefer, {
          usersOf: async () => (accounts ? (await users.list()).filter((u) => !u.disabled).map((u) => u.id) : ['local']),
        });
        console.log('Morning brief is on: written for each account after 09:00 America/New_York.');
      }

      if (accounts) {
        console.log('Accounts are on: each user signs in and keeps their own watchlist.');
      } else if (config.production && !guarded) {
        console.warn('WARNING: no APP_PASSWORD set. Anyone with this URL can scan, and spend your data quota.');
      } else if (config.production) {
        console.log('Single user, shared password. Set DATABASE_URL to switch to accounts.');
      }
    });
  })
  .catch((error) => {
    // A database that cannot be reached must stop the boot. Starting anyway would serve an app
    // where every sign-in fails, which looks like a password problem and is not one.
    console.error('Startup failed:', error.message);
    process.exit(1);
  });


