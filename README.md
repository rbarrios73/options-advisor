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

Four things about the free plan that will otherwise surprise you:

- **It sleeps.** No traffic for 15 minutes and the instance shuts down; the next visit waits
  ~50 seconds for a cold start. The first scan after that is slow, then it is not.
- **The disk is ephemeral.** `server/data/state.json` is wiped on every deploy and every cold
  start, so your watchlist reverts to SPY/QQQ/AAPL. Keeping it means a paid instance with a
  disk — `render.yaml` has the four lines, commented, at the bottom.
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

Set an **earnings date** on a watchlist entry and any expiry after it is flagged. No free feed
gives a dependable earnings date, so this is entered by hand — an earnings print inside the life
of a short premium position is the most common way one goes wrong.

## Layout

```
render.yaml     one web service, build + start + env
server/
  src/
    domain/     math.js · metrics.js · strategies.js · score.js    ← all the arithmetic, no I/O
    providers/  tradier.js · mock.js · index.js                    ← swap the feed here
    scan.js     orchestration + caching
    auth.js     optional basic auth, for when this is public
    index.js    Express API, and the built UI in production
  test/         27 tests, no network needed
web/
  src/          React UI (Vite)
```

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
