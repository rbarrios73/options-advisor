# Option Advisor

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

This list lives in `DEFAULT_WATCHLIST` in `server/src/domain/watchlist.js`. With accounts on it is
copied into a new account's own rows, once; without them it is what a saved file falls back to,
which on a host with an ephemeral disk is what you get after every cold start.

Edit it on the **Watchlist** tab — add, reorder, annotate, remove — or keep it as one list
among several.

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

### Trying it locally first

Accounts work against any Postgres, including one on your own machine, so you can see the whole
thing before pointing it at a hosted database:

```bash
# any local Postgres will do; this is the Debian/Ubuntu spelling
sudo -u postgres psql -c "CREATE ROLE oa LOGIN PASSWORD 'oa_pass'"
sudo -u postgres createdb -O oa optionadvisor

cd server
DATABASE_URL=postgres://oa:oa_pass@127.0.0.1:5432/optionadvisor \
PGSSL=disable \
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long enough password' \
npm start
```

`PGSSL=disable` because a local server has no certificate to present. Against a hosted database
you leave it unset and TLS is used with the certificate verified — there are tests pinning that
decision both ways, since it is the kind of thing that only fails once it is deployed.

The tables are created on boot and the admin account with them. Nothing else changes: the same
code path runs against Neon, Supabase, Render or a local server.

### Letting people sign themselves up

By default only an administrator can create accounts. Set **`SIGNUP_OPEN=true`** and the sign-in
screen grows a **Create account** tab that asks for nothing but an email and a password: anyone
with the URL can register, and lands signed in with their own watchlists, positions and filters.

It must be exactly `true`. `SIGNUP_OPEN=false` opening the door is the sort of thing nobody notices
until strangers are already in, so anything else — `false`, `0`, `yes`, empty — leaves it shut, and
shut means the route is not mounted at all rather than mounted and refusing. Setting it back to
false closes the door again without touching anything else; accounts already created keep working.

**`MAX_ACCOUNTS`** (default 25) is the brake. Open registration on a public URL is otherwise
unbounded, and every account shares one Tradier rate limit and one Anthropic budget. At the cap the
Create account tab disappears and the route refuses — but you can still add people by hand from the
Users page, because the cap is there to stop strangers, not you.

Four things the route does on purpose:

- **The cap is checked first**, before the email is even looked at, so a full deployment gives one
  answer to everybody rather than becoming a way to probe the account list after it has stopped
  letting people in.
- **The role is hardcoded to `member`.** Nothing a stranger posts can make them an administrator
  of your app.
- **Five attempts an hour per address**, tighter than the sign-in limit, because creating accounts
  is rarer than signing in and this is the route that writes rows.
- **Nothing is trusted from the body but the email and the password.**

One cost of open registration, stated plainly because it cannot be fixed here: while sign-up is on,
the route tells anyone whether an address already has an account, since "taken" and "created" are
necessarily different answers. Hiding that needs a confirmation email this app cannot send. If it
matters more than the convenience, leave `SIGNUP_OPEN` off and add accounts from the Users page.

### How it behaves

- **Two roles.** Admins can add, disable and delete accounts and set passwords; members just use
  the app. The server enforces this; hiding the Users tab is a courtesy, not a control.
- **There is always one administrator.** The last enabled admin cannot be deleted, demoted or
  disabled — including by themselves. Otherwise the app ends up with nobody who can administer it.
- **Setting a password signs that account out everywhere**, which is usually the point.
- **Disabling keeps someone's watchlists and ends their sessions immediately.** Deleting removes
  both — every list and its symbols go with the account, by foreign key — and cannot be undone.
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

## Asking about a scan

An optional panel on the Screener that reads the scan you just ran and answers questions about it
in words. Off until you set `ANTHROPIC_API_KEY`; it is the only part of this app that costs money
per use.

**What it can do.** Compare the ranked candidates on the dimensions the screener computes — win
probability, return on risk, expected value, liquidity, days to expiry — and say where two are
close enough that the ranking between them is noise. It is good at "which of these, and what am I
trading off", which is a reading problem rather than a forecasting one.

**What it cannot do, by construction.** It sees the digest of your scan and nothing else: no
chart, no news, nothing about the companies. It is told, in the system prompt, to discuss only
those rows, never to state a number it was not given, and never to tell you what to trade. Ask it
what will go up next month and it will say it cannot know — which is the truthful answer, and the
reason this is worth having rather than a liability.

**Why it is built this way.** The screener's arithmetic is the part of this app you can check: it
comes from a real chain and there are tests holding it to worked examples. A model asked to pick
trades would answer just as confidently from nothing, and you could not tell the two apart on
screen. So the model gets no arithmetic to do — it reads what `metrics.js` computed.

Three things enforce that rather than merely hoping for it:

- **The scan is re-run by the server** when you ask, from its own cache, and digested there. The
  numbers the model reads are the ones this server computed, not numbers a browser said it had.
- **The answer is checked back** against the scan. Any ticker in it that is not in your scan is
  flagged on screen — shown with a warning rather than hidden, because an answer you can judge
  beats a blank panel.
- **There is an hourly ceiling** per account (`ADVISOR_PER_HOUR`, 20 by default), which is a limit
  on the bill as much as on the traffic. A refused question never reaches the API.

Set `ANTHROPIC_MODEL` to pick the model; the current list is at
<https://platform.claude.com/docs/en/models/overview>. The default is `claude-sonnet-5-5`;
`claude-haiku-4-5-20251001` costs a fraction of it and is ample for reading twenty-five rows.
A wrong model id comes back as the API's own message, so one env var fixes it.

It is not advice, and the page says so under every answer.

## The morning brief

At the top of the home screen, once a trading day: what is worth knowing about your own book
before the open.

### What finds things, and what writes them

**The app finds them. The model only writes them up.** That division is the whole design, and it
is worth stating plainly because the opposite — handing a model your positions and asking what
matters — is the obvious thing to build and the wrong one. A model asked that question is fluent
about whatever it happens to notice, and exactly as fluent on the morning it notices nothing.
Detection in code fails loudly; detection in prose fails silently.

So the rules live in `domain/brief.js`, in code, with tests:

- **A breached strike** — the price is through the short strike.
- **An expiry inside seven days**, counting today.
- **Earnings before expiry** — from the date on the watchlist entry, when it falls inside the life
  of the contract. Not one that already happened, and not one that lands after it expires.
- **An ex-dividend date in front of a short call**, which is how a position gets taken off you a
  month early. Reported as "likely" when the dividend beats the time value left; see the Dividends
  tab for why.
- **A watchlist name that moved more than it usually does.**

Findings are grouped by **position, not by rule**: a spread that is both in the money and expiring
on Friday is one problem and gets one line with three labels, not three lines. Worst first.

The model is then given that list and nothing else — no chain, no candidates, no premiums — and
told: at most four sentences, only these findings, no number or ticker that is not in them, no
knowledge of the market, and nothing about what to do. The summary is checked back for tickers
that were not in the findings, and a stray one is flagged on screen rather than hidden.

**With no `ANTHROPIC_API_KEY` the brief still works.** The findings are stored, the panel renders
them, and a line says there is no written summary. The same is true when the model errors or is
rate-limited: the prose is lost, the brief is not. That is the dividend of putting detection in
code, and it is the reason to do it.

### "Moved more than it usually does"

Measured against the symbol's **own** recent range, not a flat percentage. The median absolute
close-to-close move over 90 days is what a normal day looks like for that symbol; a move 2.5× that
is a finding, with a 1.5% floor so a becalmed name does not report every twitch.

Median rather than mean, deliberately: one earnings gap would drag a mean far enough that the next
gap looked ordinary, which is precisely backwards. And too little history returns *nothing to say*
rather than zero — "I cannot tell" and "it was quiet" are different answers, and a zero would make
every move look infinite.

### Nine o'clock, and what that means on a sleeping host

**09:00 `America/New_York`**, from `Intl` — so it follows daylight saving without a library and
without a twice-yearly correction. The zone is the market's, not the server's and not yours: a
brief that arrives at 9am Oregon time arrives three hours after the bell.

A brief is a snapshot of its own nine o'clock, so the app will only ever **build** the current
day's. Before nine, or at a weekend, you see the one that was actually written — or nothing, with
a line saying when the next is due. It will not retroactively build "Tuesday's brief" out of
Wednesday's prices.

Two things make it appear, because neither is enough alone:

- **A timer**, every fifteen minutes while the process is up, writing for each account that has an
  open position or a watchlist.
- **On demand**, the first time the page is opened and today's is missing.

The second exists because **Render's free instances sleep after fifteen minutes of no traffic**,
and a sleeping process runs no timers — on the free tier the timer alone would miss most mornings.
With both, the worst case is that the brief is computed when you open the page rather than before
you did, which you cannot tell apart from the outside.

### The cost

One model call per account per trading day, capped at 300 tokens — four sentences do not need
more. A stored brief is served from the database, so opening the home screen five times is still
one call. **Run again** rebuilds it, five times a day at most; a refresh button on something that
costs money per press is otherwise an open tap.

`BRIEF=off` stops the timer. The route still builds one when you open the page.

## The Watchlist tab

Your lists, edited properly rather than through a panel in the sidebar. An account can keep up to
twelve of them — "ETFs", "earnings plays", whatever you keep apart.

**The list you are looking at is the list that gets scanned.** That is deliberately one idea
rather than two: a page where you edit "ETFs" while the screener quietly scans "earnings plays"
is a page that will eventually scan the wrong thing without telling you. Picking a list on this
tab, or from the picker on the Screener, is the same choice.

- **New**, **Duplicate** and **Delete list** sit next to the name, which is edited in place —
  no dialog for one text field. A new list becomes the live one, because you made it to put
  something in it. Your last list cannot be deleted; empty it instead.
- Two lists of one account cannot share a name, case aside. On **create** a clash is resolved —
  you get "ETFs (2)" — because you asked for a list and should get one. On **rename** it is
  refused, because you named a specific list and that name is taken.
- **Add a ticker** and it is checked against the provider before it goes on, so a typo is caught
  here rather than as a failed symbol in the middle of tomorrow's scan. It can be overridden — a
  name the provider does not know today may still be one you want.
- **Order matters** and is yours to set: symbols are scanned top down, and the ↑/↓ buttons move a
  row. Buttons rather than drag-and-drop, because a drag handle cannot be reached from a keyboard
  and is awkward on a phone.
- **The note** is for you. **The earnings date** is not: set it and the screener flags any expiry
  that lands after it, which is the most common way a short premium position goes wrong. No free
  feed gives a dependable earnings date, which is why it is entered by hand.
- **Last price per row**, from the same cache a scan uses — so a name that has quietly stopped
  trading shows up here as "no quote" rather than as a failure halfway through a scan.
- Adding, removing and reordering save as they happen; notes and the list name save when you
  leave the field.

Elsewhere the live list simply follows: the Screener names it above the sidebar and offers a
picker beside the Scan button, and the Ticker page's button reads "Add to ETFs" rather than "Add
to watchlist", so it always says where a symbol is about to go.

### Where it is stored

With `DATABASE_URL` set, in two tables. **`watchlists`** is one row per list — name, position,
the account it belongs to. **`watchlist`** is one row per symbol on a list, with the note, the
earnings date and the position in that list as columns. Foreign keys take a list's symbols with
it when it goes, and an account's lists with the account. Not a JSON blob inside the settings row,
which is where all of this used to live: these are lists of things rather than settings, they have
an order, and as rows they can be read back in that order and looked at in a SQL console when
something is wrong.

Which list is live is a setting, so it does live in the settings row, as `activeWatchlistId`. If
it ever points at a list that is gone, the first list is used — the server decides that, so the
browser never has to guess.

Two upgrades run themselves on the first boot after deploying, and are no-ops on every boot after:

1. A watchlist saved inside the settings blob moves out into rows, in the order it was saved in,
   and the buried copy is deleted so it cannot come back.
2. A single watchlist that hung off the account becomes that account's first list, named **My
   watchlist** — the same name a new account's first list gets, so nothing appears to have moved.

A new account starts on the default ten, in one list. An **empty list stays empty**, and a deleted
list stays deleted — the defaults are put there once, when the account is created, not every time
the list is read.

Without a database it is the same shape saved to a JSON file beside the app (and, on Render's free
tier, wiped on every cold start — which is the argument for the database). A file written before
lists were plural is upgraded the same way, the first time it is read.

## The Positions tab

The trades you have on, replacing the spreadsheet most option sellers keep. Columns follow that
sheet — account, symbol, contracts, type, short and long strike, delta, expiry, current price,
earnings, premium — with one difference that is the point of moving it into the app.

**What is fetched, and what is typed.** Current price, the short leg's live delta, days left, and
whether the short strike is breached are pulled from the same chain data the screener uses, every
time the page loads. Everything else — the account, the fill, the dates — is typed, because
nothing can derive what your broker filled you at. A hand-coloured "in the money" cell is only as
current as the last time somebody looked, and the day it changes is the day it matters.

**Breach is computed on the right side.** A put structure is in trouble when the price falls *to*
the short strike; a call structure when it rises to it. Within 2% counts as "near strike". A
settled row is never flagged, because the colour is about what to do today.

**Status is a label, not just a colour** — Open, Rolled, Closed, Assigned, each a word as well as
a tint, so none of it is colour alone. Status and risk are kept on separate axes: a position can
be open and fine or open and breached, and the spreadsheet's single colour column could not say
both.

**Premium counts when it is realised, not when it is collected.** Only closed and assigned
positions move a goal, on the date they were settled. A credit on a position still open is money
at risk, so it is shown separately and labelled as such — a goal that can go backwards is a goal
nobody trusts. An assignment loss comes off the net and is reported on its own.

Targets are yours to set (daily, weekly, monthly; $450 / $2,250 / $9,000 to begin with), the week
runs Monday to Sunday, and settling a position asks for the date rather than assuming today —
otherwise anything entered on a Monday morning quietly lands in the wrong week.

Each account has its own tracker, in its own table, with a foreign key that takes the rows with
the account if it is deleted.

A short call also carries an **ex-dividend flag** when a dividend falls before the expiry — see
the Dividends tab below for why that is a way to lose a position a month early.

## The Dividends tab

Two questions on one page: what the names you follow pay, ranked, and what the shares you hold
will pay you over the next one to three years.

### What it projects, and what it refuses to

Projecting a **declared** dividend forward is arithmetic. A rate, a cadence and a date give a
schedule, and the schedule is exact — four payments a year on the quarter, twelve on the month,
each worth the annual rate divided by the count. That is what the chart and the income figures
are, and the only assumption in them is that the rate does not change.

Predicting whether a company will **raise or cut** is not arithmetic, and nothing here claims to.
What the page does instead is show the measurable things that tend to precede a cut, each labelled
as the observation it is:

- **A cut that already happened.** Derived from the payment history: a calendar year whose total
  came in under the one before. The strongest signal on the page, because it is a fact rather than
  an inference. The current year is excluded — three quarters is always less than four, and a
  naive comparison would report a cut every January.
- **A yield far above the market's.** Above 10% is reported as "the market expects a cut", because
  that is usually what a yield like that means. Above 7% is "worth asking why".
- **A payout above earnings**, where anything supplies an earnings figure. Above 1 means it is
  paying out more than it earns, which a company can do for a while out of cash and not forever.
- **A long unbroken record**, which is reported but never *lowers* a reading. Plenty of long
  streaks ended the quarter after someone pointed out how long they were. Ten clean years does
  lift a row off "no read on this", because refusing to read a decade of payments is not caution.

The labels are deliberately not "safe" and not "at risk". **Nothing flagged** says what the app
knows — that none of the three things it can measure is adverse — and promises nothing about next
quarter. Every reading is a word plus its reasons, never a colour on its own.

This matters more here than anywhere else in the app, because **sorting by yield puts the
about-to-be-cut names at the top**. A 14% yield is the market saying it does not believe the
payment, not a bargain nobody noticed. The ranking is by yield, as asked — and the reason sits in
the same glance.

### Where the numbers come from

Prices and payment histories come from your data provider. Tradier's dividend endpoint is in
**beta and gated to brokerage accounts**, so the sandbox returns 403 or 404 — which the adapter
treats as an answer rather than a fault. Three states, and they are not interchangeable:

| What comes back | What it means | What the page does |
|---|---|---|
| payments | this is what it pays | reads the rate, cadence, next date and streak off them |
| an empty list | this pays no dividend | says "pays no dividend" and asks for nothing |
| nothing at all | the account may not ask | offers you the box to type the rate in |

A typed rate stays stored underneath. If the provider later gains the endpoint, its figure takes
over — a rate it reports is this quarter's, and one you typed is from whenever you typed it — and
the typed value comes back the moment the provider stops answering. Each row says which of the two
it is reading.

Everything derived is computed per request and never stored: a rate saved in January is wrong by
April. The stored half is just shares, average cost, and the rate for anything the provider cannot
tell us.

### Ex-dividend and short calls

The one place dividends reach the options side, and a real way to lose money by surprise. An
in-the-money short call is assigned the day **before** an ex-date when the dividend is worth more
than the time value left in the contract, because exercising to collect the dividend then beats
selling it. You wake up short the stock and owing the payment.

So the Positions tab flags any open call position with an ex-date before its expiry. Where the
chain gives a quote for the short leg, it compares the dividend against the extrinsic value left
and says assignment is *likely* rather than merely possible. Puts are never flagged: a put cannot
be called away to collect a dividend.

### The chart

One series — projected income by month — so there is no legend; the heading names it. Months with
no payment are drawn as empty slots rather than skipped, because a quarterly payer puts money in
your account four times a year and hiding the gaps would make it look monthly. The shape of the
gaps *is* the information.

The tallest month is labelled directly, and only when there is exactly one tallest month: a
monthly payer makes every column equal, and "label the tallest" then writes the same figure over
all thirty-six of them, which is what it did the first time it ran.

## The Ticker tab

Look up one symbol: what it costs now, and what it has done — the price page a screener sends
you off to a finance site for.

- **Ranges** 1M / 3M / 6M / YTD / 1Y / 5Y. Five years is asked for as weekly bars, because 1,260
  daily points is a fifth of a megabyte to draw a shape you can see in 260.
- **The chart** is one line over a dashed baseline at the period's opening price. Hover, or focus
  it and use the arrow keys, for that day's open, high, low, volume and the move since the start
  of the period. Bars are spaced by trading day, not by calendar date, so a weekend is not a gap
  that reads as the market standing still. Under it, the same series as a table.
- **The panel** has the day's numbers (open, range, previous close, bid/ask, volume, 52-week
  range) and the period's (high and low with the dates they happened, change, average volume, how
  far off the period high it is now).
- **Add to watchlist** and **Open in simulator** are there, so a symbol you looked up can go
  straight into the screener's list or into a position.

The address holds the symbol and the range (`#/ticker?symbol=IWM&range=1Y`), so a chart can be
bookmarked or sent to someone. Quotes and bars are cached alongside the scan's, so flicking
between ranges and symbols does not spend the provider's rate limit twice.

## The Simulator

The third tab. Pick a position off a real chain, then move the date and implied vol to see what
closing it early would look like — the same idea as TradingView's options builder.

Four strategies: **put credit spread**, **call credit spread**, **long call**, **long put**. The
engine is a list of legs, not a special case per strategy, so the P&L, the greeks and the chart
are the same code for all of them; only the numbers that genuinely differ in shape — max profit,
max loss, break-even — are worked out per kind.

The two credit spreads are mirror images, and are written as one piece of code with the side as a
parameter rather than as two. A put spread sells below the price and buys further below, wins
above its break-even, and is bullish; a call spread sells above and buys further above, wins
below its break-even, and is bearish. Everything else — how a target delta is matched to a listed
strike, the theta it collects, the vega it is short — is identical. Writing them twice is how the
two drift apart, and how a page ends up saying "finishes above break-even" over a number that
measured the opposite.

- **Choose the contract by delta or by strike.** By delta, it takes the *listed* contract nearest
  the target, because a strike that does not exist cannot be traded; if the chain cannot get
  within 0.03 of what you asked for, it says so. On a spread the long leg is set by width, and the
  widths offered are the distances to strikes that are actually listed on the protective side.
- **The greeks sit under the chart**, not in the side panel: delta, theta, vega and gamma as four
  tiles, directly below the date and IV sliders that move them. They were in the side panel, which
  drops below the P&L table on any window under 1100px — a long scroll from the thing they
  describe. Each tile says what the number means in money ("$1.84 per day"), because that is the
  part you can act on.
- **Entry price**: the price a marketable order gets — the bid/ask on a spread, the ask on a long
  option, which is the screener's convention — or mid, or what you were actually filled at.
- **Long options read the other way round.** A credit spread collects theta and is short vega; a
  long call or put pays theta and is long vega, and the page shows the signs rather than
  explaining them. There is **no expected value** for a long option: its upside is a distribution,
  not one of two outcomes, and the screener's crude version would be worse than nothing. A long
  put's "max profit" is the strike going to zero, and is labelled as such.
- **The chart** draws the payoff at expiry (solid) and the modelled value on the chosen date
  (dashed), with both strikes, the break-even, today's price and a ±1σ expected-move band. Hover,
  or focus it and use the arrow keys, for exact values.
- **The table** is P&L by price and date. It has rows at exactly today's price, both strikes and
  the break-even, so "what happens at my short strike" gets an exact answer rather than the one
  five dollars away.
- **Open in simulator** on any credit spread, long call or long put in the screener carries the
  legs across, and the headline numbers match the screener's to the cent — the simulator runs the
  screener's own `metrics.js` in the browser, and tests hold the two to each other for every
  strategy. Structures the simulator does not cover get no link, rather than a link that would
  quietly show something else.

Things the model does not know, stated on the page as well:

- Before expiry the values are **Black-Scholes** from each leg's own IV. They are only as good as
  that vol; at expiry they are exact.
- **Dividends are ignored.** A few cents on a 30–45 day SPY spread; more on a high-yield name near
  an ex-date.
- **Listed options are American.** A deep in-the-money short leg can be assigned early. The model
  is European and cannot show you that.
- **Day one is negative**, and that is correct: selling at the bid and buying at the ask puts you
  behind the model value by about the gap to mid the moment you open.

### Time decay, as its own view

The payoff chart is P&L across **price** on one chosen day. Underneath it, **What time alone
does** is P&L across **days** at one chosen price — today's. The Date slider walks the first
through the second one day at a time, which never shows the shape, and the shape is the point.

Three readings sit under the curve: what time is worth between now and expiry, how much of that
lands in the final week, and the day by which half of it is done. The dot on the curve is where
the Date slider is standing, so the two controls describe the same point rather than sitting
beside each other saying different things.

**The usual rule of thumb is wrong here, and the app says so per position.** "Theta accelerates
into expiry" is true at the money and false away from it — and a credit spread is deliberately
placed away from it. Run the numbers on a 95/90 put spread with the stock at 100: the final week
carries **14%** of the decay, less than the 23% a straight line would give it, because by then the
options are nearly worthless and there is little left to take. Move the same spread to the money
and the final week carries **69%**. The two shapes are opposite. So the sentence under the chart
is picked from the measured numbers — compared against what a flat rate would put in the last
week, so the comparison holds at any holding period — rather than asserted:

| shape | what it means | typical case |
|---|---|---|
| **over early** | theta fades; most of the decay is done well before expiry | strikes far from the money |
| **steady** | no part of the period does much more of the work | mildly out of the money |
| **lands in the final stretch** | theta accelerates; the curve steepens at the end | at or near the money |

Two things the curve holds still that the market will not: **the price does not move and implied
vol does not change.** A credit spread drawn this way rises smoothly to its full credit, which is
exactly the picture that makes short premium look like a bond. The page says so under the chart,
in bold, because that single assumption is what separates "what waiting is worth" from "what this
position will make".

It is also honest about the unhappy case: a credit spread whose short strike is already through
the price shows a **negative** total, because for that position time is working against you.

The page's address describes what is on screen (`#/simulator?symbol=SPY&exp=…&delta=0.2&width=5`),
so a setup can be bookmarked or sent to someone.

## Light and dark

A control in the top bar: **Light**, **Dark**, or **System**. System is the default and follows
the machine, including when it flips at sunset — a laptop already knows which its owner wants, and
the app should not be the one thing that ignores it. The two explicit choices exist for when the
OS setting is wrong for the room: a dark-themed laptop in sunlight, a bright one at night.

The choice is saved twice, on purpose. **In the browser**, so an inline script in `index.html` can
stamp it on `<html>` before the first paint — read it in React instead and the page shows the
wrong theme for a frame and then flips, which is the white flash every themed site is judged by.
**On the account**, so signing in on another machine brings your appearance with you rather than
adopting whatever that machine had. The account wins when the two disagree.

Light is **selected, not inverted**. Its chart hues are the light steps of the same ramps —
`#2a78d6` and `#eb6834` for the two categorical slots, `#2a78d6` ↔ `#e34948` for profit and loss —
each run through the dataviz palette validator against the light panel: lightness band, chroma
floor, CVD separation (ΔE 24.7 and 21.6) and ≥3:1 contrast all pass. Flipping the dark blue's
lightness instead would land outside the light band and stop clearing contrast on white.

Every colour in `styles.css` is a named role. A literal hex below the token block is a bug — it is
a value that cannot follow the theme, and it shows up as a dark panel on a white page. The browser
check walks every rendered element on every page and fails on any surface whose lightness
disagrees with the page it sits on, because that is the one class of mistake no unit test catches.

The control also sits on the sign-in screen. "I cannot read this" should not be something you have
to sign in to fix — and without a database there is no Account page to hide it on.

## Layout

```
render.yaml     one web service, build + start + env
server/
  src/
    domain/     math.js · metrics.js · strategies.js · score.js    ← all the arithmetic, no I/O
                pricing.js · simulate.js                           ← Black-Scholes and the simulator
                history.js · watchlist.js                          ← ranges, series, and what a
                                                                     list and its entries are
                advice.js                                          ← what the model may see, and
                                                                     how its answer is checked
                positions.js                                       ← the tracker: breach, goals
                theme.js                                           ← light, dark or the machine
                passwords.js                                       ← the rule both sides enforce
    providers/  tradier.js · mock.js · index.js                    ← swap the feed here
    scan.js     orchestration + caching
    advisor.js  the optional model reader — one fetch, no SDK
    auth.js     sign-in: basic auth (single user) or session cookies (accounts)
    users.js    accounts, scrypt passwords, sessions
    db.js       Postgres pool + schema, and the upgrades that run on boot
    app.js      the Express app, as a factory so the tests can drive it
    index.js    entry point: build it, migrate, listen
  test/         200 tests, no network and no database needed
web/
  src/
    pages/      ScreenerPage · WatchlistPage · PositionsPage · TickerPage
                SimulatorPage
                LoginPage · UsersPage · AccountPage
    components/ PayoffChart · PriceChart (SVG) · PnlGrid · ResultsTable
                AskPanel · ThemeToggle · …
    router.js   hash routing — a handful of pages do not need a library
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
at each kink of every strategy, the sign of each greek (a long option pays theta, a credit spread
collects it), and the screener and simulator producing identical numbers for the same legs.

The call credit spread has its own set, and each one asserts the thing that would be wrong if the
side had been copied rather than mirrored: that protection is bought ABOVE the short call, that
the break-even is above the short strike rather than below it, that the full credit is kept below
the short strike, and that the position is bearish (negative delta) while still collecting theta
and being short vega — the one sign that flips, and the three that do not.

For the ticker tab: what each range window means (YTD is the year, not 365 days), that five years
comes back weekly, that a series summary reports the intraday extremes rather than the closes, and
that the last bar of the chart is exactly the quote in the header — including its open, high, low
and volume, and whichever range was asked for. A chart disagreeing with the number printed above
it is the bug most worth a test here.

For the watchlists: what counts as a ticker, what a bad earnings date does (dropped, not stored —
the column is a real DATE and half a date would fail the whole save), duplicates collapsing onto
the first mention, both caps, and how a clashing list name is resolved on create but refused on
rename. Against a real Postgres: that a new account is seeded once, that an emptied list stays
empty across a restart, that order survives a round trip, that editing one list leaves the others
alone, that the last list cannot be deleted, and that one account's list id is not a handle on it
— a rename, an edit, a delete and a switch all answer "no such watchlist" rather than "not
yours", so an id cannot be used to find out which ids exist.

Both upgrades are tested by building the old schema and running the migration over it: a list
buried in the settings blob, and a single list hanging off the account. Each is then run a second
time, because that is what happens on the next boot.

For the advisor: no network, ever — the client takes an injectable `fetch` and the tests pass a
stub. They cover the digest (that it carries what the table carries, that a missing number reads
as a dash rather than zero, that it is capped and deterministic), the grounding check catching an
invented ticker while leaving ordinary capitalised prose alone, the request shape against the
Messages API, the API's own error message surviving, and — over real HTTP — that the route is off
without a key, that it digests the signed-in account's own watchlist and not another's, and that
the hourly ceiling stops a question before it costs anything. The system prompt's four
prohibitions are pinned by a test, because they are the whole basis of trusting the feature and a
well-meaning edit that softened them would fail nothing else.

For the tracker: breach detection on both sides (a put is breached when the price falls to the
strike, a call when it rises to it), that a settled row is never flagged, that only realised
premium moves a goal and only on the day it was settled, that an assignment loss comes off the
net, and that the week starts on Monday with Sunday belonging to the week that just ended. Over
real HTTP: that one dead ticker leaves one row showing dashes rather than emptying the table, that
an account cannot see or change another's positions, and that every route needs a session.

For time decay: that the curve ends on the real expiry payoff rather than a Black-Scholes value
with a hair of time left; that a credit spread gains as time passes and a long option bleeds, and
that with the price held still neither ever goes backwards; that the decay of an out-of-the-money
spread is front-loaded while the same spread at the money is back-loaded — asserted in opposite
directions in the same test, because the folk wisdom is only true of one of them; that theta on
the curve is the theta at that day and fades or accelerates accordingly; that the shape classifier
is judged against what a straight line would put in the final week, so a 90-day position is not
called front-loaded for having a small one; that the shares are of the signed total, so they read
the same way for a position that gains and one that bleeds; that quantity scales the figures and
not the shape; that a position expiring today returns nulls rather than dividing by zero; that a
long-dated position is thinned rather than drawn at 365 points; and that the decay curve at T+N
equals the payoff chart's projected value at today's price on that same day — the two are drawn
from the same function and a reader will compare them.

For the morning brief: that the clock is the market's — 13:30 UTC is 09:30 in New York in summer
and 08:30 in winter, and a brief on the server's clock would be wrong half the year without anyone
noticing until November; that a weekend shows Friday's brief rather than nothing, and that neither
the route nor the timer will build one for a day that has passed, which would stamp yesterday's
date on this morning's prices; that a typical day is a median so one earnings gap cannot redefine
normal, and that too little history says nothing rather than zero; that the same 2% day is a
finding for a quiet symbol and not for a lively one; that one position with four problems is one
line with four labels; that a closed position is not in it; that a symbol already covered by a
position is not repeated as a mover; that the prompt still forbids extra numbers, extra tickers,
market knowledge and advice — pinned sentence by sentence, because those are the load-bearing
ones; that a model which fails costs the prose and not the findings; that a ticker nobody fed it
is flagged rather than hidden; that opening the page twice is not two model calls; and that
"Run again" stops at five a day.

For dividends: that a blank box is not a figure of zero (an unset rate is not a rate of nothing);
that "2026-02-31" is dropped rather than rolled forward to 3 March, which `Date.parse` does
happily and a DATE column does not; that a stored ex-date in the past is carried forward instead
of being reported as income still to come; that the cadence is read off the gaps between payments
rather than off a field providers spell three different ways; that the rate quoted is the latest
payment annualised and not the trailing year, which is the difference that matters in the quarter
after a cut; that the current year never counts as a cut just for being unfinished; that a cut
outranks a forty-year streak and the streak never cancels it; that every risk level carries words
rather than a colour; that a short call before an ex-date is flagged while a put never is; and
that ranking by symbol actually re-ranks — `key[by] ?? key.yield` read a deliberate null picker as
"no such key" and silently sorted by yield instead.

For sign-up: that a closed deployment has no route at all rather than one that refuses; that only
the exact string `true` opens it, checked against the values a dashboard actually produces
(`false`, `FALSE`, `0`, `no`, `off`, empty, `yes`); that the cap stops the account after the last
one and makes `/api/me` stop advertising the tab before the route refuses, while leaving the admin
free to add people by hand; that a full deployment answers a taken address and a fresh one
identically, so it cannot be used to find out who banks here; that posting `role: 'admin'` gets you
a member account and a 403 on the admin routes; that the limiter stops the sixth attempt in an
hour, a valid one included; and that a new account arrives with its own seeded watchlist and cannot
see anybody else's.

For accounts: a real Postgres, in process (PGlite), so the SQL, constraints and cascades are the
real ones rather than a stand-in that would agree with whatever the code does. They cover password
hashing, session expiry and revocation, the last-administrator rule, and — over real HTTP against
the real routes — that every data route needs a session, that members cannot reach the admin
routes, and that one account cannot see another's watchlist.
