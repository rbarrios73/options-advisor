# Options Advisor

A daily screener for defined-risk options structures — put and call credit spreads, iron condors,
long calls and puts — over a watchlist you control. React front end, Node/Express API, Tradier for
chains.

## What it is, and what it is not

It ranks the structures your filters allow and **shows every number the ranking was built from**.
That is the whole design: a ranked list you cannot argue with is worse than no list, because you
cannot tell a good setup from an artefact of the scoring.

It is not advice, and it cannot be. It sees one snapshot of one option chain. It does not know
your account, your existing positions, your tax situation, or anything about the company beyond
its option prices. Nobody here is a financial advisor. Options can lose more than they cost, and a
short spread can lose its full width in a single gap. Check every number against your broker
before you act on it.

Two things worth understanding about the numbers, because they change how you should read a high
score:

- **Probabilities come from implied volatility.** IV is the market's price of uncertainty, not a
  forecast. The model is lognormal, which has thinner tails than real markets — so anything that
  depends on the tail (the max loss on a short spread) is *more* likely than it says.
- **Expected value is the crude two-outcome version**: full credit or full max loss. On
  efficiently priced options it lands near zero or slightly negative once the bid/ask is paid,
  which is the honest answer. The edge premium sellers actually pursue is the gap between implied
  and realised volatility, and nothing here measures realised volatility.

## Running it

Both commands are run **from this folder** (the one holding this README) — `server/` and `web/`
are subfolders of it. `cd` into it first, or the `cd server` below will not find anything.

```bash
# API
cd server && npm install && npm start      # http://localhost:4000

# UI, in a second terminal — from this folder again, not from server/
cd web && npm install && npm run dev       # http://localhost:5173
```

Node 18 or newer. On Windows PowerShell the same lines work, but `&&` needs PowerShell 7; in
Windows PowerShell 5.1 run them as separate commands.

It starts on the **mock provider** — synthetic chains, no token, no network — so you can see the
whole thing work before wiring up data.

### Real data

Get a sandbox token from <https://developer.tradier.com> (free; delayed quotes, full chains with
greeks and implied vol), then:

```bash
cd server
cp .env.example .env
# set TRADIER_TOKEN, and PROVIDER=tradier
npm start
```

Moving to live data later is `TRADIER_MODE=live` and a live token. No code changes.

## Putting it on the internet (Render)

In production the Node process serves the built React app itself, so this deploys as **one**
service — no separate static site, no CORS to configure. `render.yaml` describes it, so Render
reads it rather than asking you to fill in a form.

1. Push this folder to a GitHub repo.
2. Render → **New → Blueprint** → pick the repo → Apply.
3. When it asks for `TRADIER_TOKEN`, paste your sandbox token (or leave it blank — it starts on
   the mock provider and works without one).
4. Open the URL. It asks for a username and password: `admin`, and the password Render generated
   — dashboard → your service → **Environment** → `APP_PASSWORD`.
5. To switch to real chains, set `PROVIDER=tradier` in that same Environment tab and redeploy.

For more than one person, see **Accounts** below: set `DATABASE_URL` and the shared password is
replaced by a sign-in screen, with a separate watchlist for each account.

Four things about the free plan that will otherwise surprise you:

- **It sleeps.** No traffic for 15 minutes and the instance shuts down; the next visit waits
  ~50 seconds for a cold start. The first scan after that is slow, then it is not.
- **The disk is ephemeral.** `server/data/state.json` is wiped on every deploy and every cold
  start, so your watchlist reverts to the default list below. Setting `DATABASE_URL` fixes this
  as a side effect, since everything then lives in Postgres; keeping the file instead means a
  paid instance with a disk — `render.yaml` has the four lines, commented, at the bottom.
- **The password matters.** A public URL is public. Without `APP_PASSWORD` set, anyone who finds
  it can run scans against your Tradier quota. Basic auth is a low bar, but it is a bar.
- **Tradier's sandbox is rate-limited** and shared across everything using your token. The
  five-minute chain cache exists for this reason; don't lower `CACHE_TTL_MS` on a hosted copy.

Nothing here is Render-specific beyond `render.yaml` — `npm run build && npm start` with `PORT`
set is the whole contract, which is also what Railway, Fly and a plain VPS want.

## How a candidate is built

1. **Chains** for every expiry inside your DTE window, per watchlist symbol.
2. **Candidates** — every structure that fits the filters. The generators are deliberately dumb;
   cleverness there is how a screener develops opinions you cannot see.
3. **Pricing**, conservatively: a credit is the price you could be hit on (sell the bid, buy the
   ask), not mid. Mid-price fills look better on screen and are not what a retail multi-leg order
   gets on a quiet strike. The gap to mid is shown on every candidate so you can see what chasing
   it would be worth.
4. **Probability** from the expiry's at-the-money IV, measured **at the break-even** rather than at
   the short strike. Between the two you keep part of the credit but the trade is not a full
   winner, and counting that as a win flatters the number. Both are reported.
5. **Score** — a weighted sum of five normalised components, every one of them visible on the row.

Expand any row to see the legs at the quotes they were priced from, the score components with
their weights, and the facts the arithmetic came from.

## Filters worth knowing

| Filter | Why it matters |
| --- | --- |
| `maxShortDelta` | The short leg's delta approximates its chance of finishing in the money. |
| `minProbProfit` | Measured at the break-even. 0.6–0.8 is the usual band for credit spreads. |
| `minReturnOnRisk` | Credit ÷ max loss. Under ~0.15 you are not being paid for the tail. |
| `minLiquidity` | Composite of quote width, open interest and volume. On a 4-leg condor you pay the spread four times. |
| `minDte` / `maxDte` | The scoring prefers ~35 days; the window is yours. |
| `maxExpirations` | How many expiries to pull per symbol. **This is the cost knob**: a scan is roughly `symbols × maxExpirations` provider requests. SPY lists an expiry nearly every weekday, so an uncapped 7–60 day window is ~40 chain calls for one symbol. |
| `targetDte` | Which expiries survive the cap — those nearest this, not the nearest ones. Short expiries are where a credit spread's gamma risk lives. |

## The default watchlist

Ten names, diversified by what actually drives them, and all with chains deep enough that a
four-legged position is fillable — on a condor you pay the bid/ask four times, so an illiquid
underlying quietly costs more than a correlated one.

| | |
| --- | --- |
| SPY, IWM | US large cap and small cap |
| XLF, XLE, XLV, XLY | Financials, energy, healthcare, consumer discretionary |
| GLD, TLT | Gold and long Treasuries — the two that tend to move when equities fall |
| EEM | Emerging markets: non-US, dollar-sensitive |
| NVDA | The one single name, for premium the quiet ETFs cannot pay |

Nine are ETFs, which have no earnings date to gap over — and since the earnings field is entered
by hand, every single name is one more thing you have to remember.

This list lives in `DEFAULT_STATE` in `server/src/store.js`, not just in the saved file. On a host
with an ephemeral disk the saved file is wiped on every cold start, so the default is what you
actually get back.

A note on high-priced underlyings: a $400 stock with 10-point strike spacing produces nothing at
the default `maxWidth` of 10, because the narrowest available spread is already at the limit.
TSLA was in an earlier draft of this list for exactly that reason and was cut. If you want one,
raise `maxWidth` — and accept the larger max loss per contract that comes with it.

Set an **earnings date** on a watchlist entry and any expiry after it is flagged. No free feed
gives a dependable earnings date, so this is entered by hand — an earnings print inside the life
of a short premium position is the most common way one goes wrong.

## Accounts

By default this is a single-user app: one shared password (`APP_PASSWORD`), settings in a JSON
file. Set **`DATABASE_URL`** and it becomes multi-user — everyone signs in with their own email
and password, and each person gets their own watchlist, filters and saved settings.

Accounts need a real database, and this is not a preference. On Render's free tier the filesystem
is wiped on every deploy and every cold start, so file-backed logins would disappear within hours;
Render's own free Postgres is deleted 30 days after it is created, taking every account with it.
**Neon** and **Supabase** both have free Postgres plans that do not expire, and either works here.

### Setting it up

1. Create a free Postgres at <https://neon.tech> or <https://supabase.com> and copy the connection
   string (it looks like `postgresql://user:pass@host/db?sslmode=require`).
2. In Render → your service → **Environment**, set:
   - `DATABASE_URL` — that connection string
   - `ADMIN_EMAIL` — your email
   - `ADMIN_PASSWORD` — Render generates one; read it in the same tab
3. Redeploy. The tables are created on boot and your administrator account with them.
4. Sign in, change your password on the **Account** page, then add people on **Users**.

`APP_PASSWORD` is ignored once `DATABASE_URL` is set — the sign-in screen replaces it.

### How it behaves

- **Two roles.** Admins can add, disable and delete accounts and set passwords; members just use
  the app. The server enforces this; hiding the Users tab is a courtesy, not a control.
- **There is always one administrator.** The last enabled admin cannot be deleted, demoted or
  disabled — including by themselves. Otherwise the app ends up with nobody who can administer it.
- **Setting a password signs that account out everywhere**, which is usually the point.
- **Disabling keeps someone's watchlist and ends their sessions immediately.** Deleting removes
  both, and cannot be undone.
- **No password reset email**, because this app sends no mail. An admin sets a new one and tells
  the person. If you lock yourself out of the only admin account, set `ADMIN_RESET=true` for one
  deploy, then turn it off.
- **One market-data connection, shared.** Everybody's scans come out of the same Tradier rate
  limit, and the chain cache is shared across accounts — which makes a second user cheap.

### How the credentials are stored

Passwords are hashed with **scrypt** (a memory-hard KDF from `node:crypto` — no native module to
fail to build), each with its own salt, and the cost parameters are stored with each hash so they
can be raised later without invalidating old ones. Session tokens are random, and the database
stores only their **SHA-256**: a leaked backup does not hand anyone a working session. The session
cookie is `HttpOnly` (script cannot read it), `SameSite=Lax` (another site cannot make your browser
send it) and `Secure` in production. Sign-in attempts are rate-limited per address.

That is a reasonable bar for a screener holding a broker **read** token. It is not the bar for
something that can place orders — if this app ever gets a token that can trade, this is the part
to revisit first.

## The Simulator

The second tab. Pick a put credit spread off a real chain, then move the date and implied vol to
see what closing it early would look like — the same idea as TradingView's options builder.

- **Choose the short put by delta or by strike.** By delta, it takes the *listed* put nearest the
  target, because a strike that does not exist cannot be traded; if the chain cannot get within
  0.03 of what you asked for, it says so. The long put is set by width.
- **Entry price**: bid/ask (what a marketable order gets — the screener's convention), mid, or the
  credit you were actually filled at.
- **The chart** draws the payoff at expiry (solid) and the modelled value on the chosen date
  (dashed), with both strikes, the break-even, today's price and a ±1σ expected-move band. Hover,
  or focus it and use the arrow keys, for exact values.
- **The table** is P&L by price and date. It has rows at exactly today's price, both strikes and
  the break-even, so "what happens at my short strike" gets an exact answer rather than the one
  five dollars away.
- **Open in simulator** on any put credit spread in the screener carries the legs across, and the
  headline numbers match the screener's to the cent — the simulator runs the screener's own
  `metrics.js` in the browser, and a test holds the two to each other.

Things the model does not know, stated on the page as well:

- Before expiry the values are **Black-Scholes** from each leg's own IV. They are only as good as
  that vol; at expiry they are exact.
- **Dividends are ignored.** A few cents on a 30–45 day SPY spread; more on a high-yield name near
  an ex-date.
- **Listed options are American.** A deep in-the-money short put can be assigned early. The model
  is European and cannot show you that.
- **Day one is negative**, and that is correct: selling at the bid and buying at the ask puts you
  behind the model value by about the gap to mid the moment you open.

The page's address describes what is on screen (`#/simulator?symbol=SPY&exp=…&delta=0.2&width=5`),
so a setup can be bookmarked or sent to someone.

## Layout

```
render.yaml     one web service, build + start + env
server/
  src/
    domain/     math.js · metrics.js · strategies.js · score.js    ← all the arithmetic, no I/O
                pricing.js · simulate.js                           ← Black-Scholes and the simulator
    providers/  tradier.js · mock.js · index.js                    ← swap the feed here
    scan.js     orchestration + caching
    auth.js     sign-in: basic auth (single user) or session cookies (accounts)
    users.js    accounts, scrypt passwords, sessions
    db.js       Postgres pool + schema
    app.js      the Express app, as a factory so the tests can drive it
    index.js    entry point: build it, migrate, listen
  test/         83 tests, no network and no database needed
web/
  src/
    pages/      ScreenerPage · SimulatorPage · LoginPage · UsersPage · AccountPage
    components/ PayoffChart (SVG) · PnlGrid · ResultsTable · …
    router.js   hash routing — two pages do not need a library
```

`server/src/domain/` is imported by the browser as well as the server (Vite aliases it as
`@domain`), which is why everything in it must stay free of Node APIs and I/O.

`providers/index.js` documents the four-method interface. A different broker or vendor is one new
file and one line.

## Tests

```bash
cd server && npm test
```

They pin the arithmetic against worked examples — credit, max loss, break-evens, the condor's
"only one side can lose" rule, probabilities that move the right way with strike, time and vol —
and run the whole scan against the mock provider, including that a bad symbol is reported rather
than thrown.

For the simulator: Black-Scholes against textbook values, put-call parity, every greek against a
finite difference of the price, the inverse normal against published quantiles, the expiry payoff
at each kink, and the screener and simulator producing identical numbers for the same legs.

For accounts: a real Postgres, in process (PGlite), so the SQL, constraints and cascades are the
real ones rather than a stand-in that would agree with whatever the code does. They cover password
hashing, session expiry and revocation, the last-administrator rule, and — over real HTTP against
the real routes — that every data route needs a session, that members cannot reach the admin
routes, and that one account cannot see another's watchlist.
