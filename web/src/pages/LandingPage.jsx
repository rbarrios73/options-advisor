import ThemeToggle from '../components/ThemeToggle.jsx';

/**
 * The front door: what Option Advisor is, before anyone is asked for a password.
 *
 * Shown only to someone signed out who arrived at the bare address. A shared link to a page
 * (#/simulator?…) skips it and goes straight to sign-in, so the link still lands where it points.
 *
 * Every claim here is something the app actually does, in the words the app itself uses — no
 * figures, no testimonials, no "beat the market". The one promise it makes is the one it keeps:
 * conservative prices and every number shown. The not-advice line is said once, plainly, at the
 * foot, where the rest of the app says it too.
 */
export default function LandingPage({ signupOpen, onStart, onExplore, theme, onTheme }) {
  return (
    <div className="landing">
      <header className="landing-top">
        <span className="landing-brand">
          <img src="/logo-mark.png" alt="" width="32" height="32" />
          Option Advisor
        </span>
        <nav className="landing-actions" aria-label="Account">
          <button type="button" className="link-button" onClick={() => onStart('signin')}>
            Sign in
          </button>
          {signupOpen && (
            <button type="button" className="primary" onClick={() => onStart('signup')}>
              Create account
            </button>
          )}
        </nav>
      </header>

      <main>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <p className="landing-kicker">Options screener · simulator · trade journal</p>
            <h1 id="landing-title">
              Defined-risk option trades, ranked every day — with every number shown.
            </h1>
            <p className="landing-lede">
              Option Advisor scans your watchlist&rsquo;s option chains, ranks credit spreads and
              long options, and shows exactly how each score was built. Then it lets you test the
              trade before you place it, and tracks it after.
            </p>
            <div className="landing-cta">
              <button type="button" className="primary" onClick={() => onStart(signupOpen ? 'signup' : 'signin')}>
                {signupOpen ? 'Create a free account' : 'Sign in'}
              </button>
              {onExplore && (
                <button type="button" className="link-button" onClick={onExplore}>
                  Try the screener — no account needed
                </button>
              )}
            </div>
            {onExplore && (
              <p className="muted small landing-guest-note">
                The Screener, Ticker, Watchlist and Dividends pages are open to everyone. Positions and
                the Simulator need a free account.
              </p>
            )}
          </div>

          <HeroArt />
        </section>

        <section className="landing-section" aria-labelledby="features-title">
          <h2 id="features-title">What it does</h2>
          <ul className="landing-features">
            <Feature title="Daily screener" icon={<IconScan />}>
              Scans every symbol on your watchlist and ranks put credit spreads, call credit spreads
              and long options by win probability, return on risk and liquidity — with the legs and
              quotes each candidate was priced from.
            </Feature>
            <Feature title="Position simulator" icon={<IconCurve />}>
              Choose strikes by delta or by price, then drag the date and implied volatility to see
              the P&amp;L chart, a price-by-date table and the position&rsquo;s greeks move with them.
            </Feature>
            <Feature title="Expected range" icon={<IconCone />}>
              The price band the option market is pricing in for each expiry, how that compares with
              how much the stock has really moved, and the odds of reaching any price you type.
            </Feature>
            <Feature title="Positions and goals" icon={<IconTarget />}>
              Track open trades against live prices, see when a short strike is being tested, and
              measure premium banked against daily, weekly and monthly targets.
            </Feature>
            <Feature title="Trading results" icon={<IconReport />}>
              A journal for any date range: premium collected, cost to close, net premium, capital
              required and yearly ROI per trade, split into new positions, rolls and closes.
            </Feature>
            <Feature title="Dividends" icon={<IconCalendar />}>
              What the names you follow pay and when, ranked by yield — with each one&rsquo;s risk
              written beside it, so a yield the market has stopped believing does not top the list.
            </Feature>
          </ul>
        </section>

        <section className="landing-section" aria-labelledby="how-title">
          <h2 id="how-title">How it works</h2>
          <ol className="landing-steps">
            <li>
              <h3>Build a watchlist</h3>
              <p>Start from nine liquid ETFs and NVDA, or add your own. Each account keeps its own lists.</p>
            </li>
            <li>
              <h3>Scan the chains</h3>
              <p>One click reads today&rsquo;s option chains and ranks what fits your filters and weights.</p>
            </li>
            <li>
              <h3>Test it, then track it</h3>
              <p>Open any candidate in the simulator, save it as a position, and watch it to expiry.</p>
            </li>
          </ol>
        </section>

        <section className="landing-section landing-principles" aria-labelledby="principles-title">
          <h2 id="principles-title">Built to be honest about the numbers</h2>
          <ul>
            <li>
              <strong>Conservative prices.</strong> A spread is priced selling the bid and buying the
              ask, never at the flattering midpoint — and the gap to mid is always shown.
            </li>
            <li>
              <strong>Probability at the break-even</strong>, not at the short strike, so the odds you
              see are the odds of making money.
            </li>
            <li>
              <strong>Ranges, not targets.</strong> Implied volatility says how far a price may move,
              not which way, so nothing here pretends to predict direction.
            </li>
            <li>
              <strong>Readable by everyone.</strong> Charts use blue and orange rather than red and
              green, in light and dark themes.
            </li>
          </ul>
        </section>

        <section className="landing-final" aria-labelledby="final-title">
          <h2 id="final-title">Ready to look at today&rsquo;s chains?</h2>
          <button type="button" className="primary" onClick={() => onStart(signupOpen ? 'signup' : 'signin')}>
            {signupOpen ? 'Create a free account' : 'Sign in'}
          </button>
        </section>
      </main>

      <footer className="landing-foot">
        <p className="muted small">
          Option Advisor is an analysis tool, not investment advice. It sees one snapshot of an
          option chain and knows nothing about your account, your other positions or your taxes.
          Probabilities come from implied volatility, and real markets make large moves more often
          than the model assumes. Market data may be delayed.
        </p>
        <div className="signin-theme">
          <span className="muted small">Appearance</span>
          <ThemeToggle value={theme} onChange={onTheme} />
        </div>
      </footer>
    </div>
  );
}

function Feature({ title, icon, children }) {
  return (
    <li className="landing-feature">
      <span className="landing-icon" aria-hidden="true">
        {icon}
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </li>
  );
}

/**
 * The hero picture: a price line running into an expected-range cone, over a credit spread's
 * payoff. Drawn, not screenshotted — it is a picture of the idea, labelled as one, with no prices
 * on it that anybody could mistake for a quote.
 */
function HeroArt() {
  // A fixed, gently wandering path so the picture is the same on every load.
  const path = [62, 60, 63, 61, 66, 64, 68, 67, 70, 69, 72, 71, 74];
  const x = (i) => 20 + i * 15;
  const y = (v) => 266 - v * 2; // centres the line, so the cone has room both ways
  const line = path.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
  const sx = x(path.length - 1);
  const sy = y(path.at(-1));

  return (
    <figure className="landing-art" aria-hidden="true">
      <svg viewBox="0 0 400 260" role="presentation">
        <defs>
          <clipPath id="art-clip">
            <rect x="1" y="1" width="398" height="258" rx="12" />
          </clipPath>
        </defs>
        <rect className="art-panel" x="1" y="1" width="398" height="258" rx="12" />
        <g clipPath="url(#art-clip)">
        {[60, 100, 140, 180, 220].map((gy) => (
          <line key={gy} className="art-grid" x1="16" x2="384" y1={gy} y2={gy} />
        ))}

        {/* expected-range cone */}
        <path className="art-two" d={`M${sx},${sy} L376,${sy - 84} L376,${sy + 84} Z`} />
        <path className="art-one" d={`M${sx},${sy} L376,${sy - 42} L376,${sy + 42} Z`} />
        <line className="art-today" x1={sx} x2={sx} y1="20" y2="240" />
        <path className="art-line" d={line} />
        <circle className="art-dot" cx={sx} cy={sy} r="5" />

        {/* credit-spread payoff, top-left inset, clear of the line and the cone */}
        <g transform="translate(24 20)">
          <rect className="art-inset" x="0" y="0" width="128" height="48" rx="6" />
          <path className="art-payoff" d="M10,38 L46,38 L76,12 L118,12" />
          <line className="art-zero" x1="10" x2="118" y1="25" y2="25" />
        </g>
        </g>
      </svg>
      <figcaption className="muted small">Illustration</figcaption>
    </figure>
  );
}

// Small line icons, drawn in the text colour so they follow the theme.
const Svg = ({ children }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const IconScan = () => (
  <Svg>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.2-4.2M8 11h6M11 8v6" />
  </Svg>
);
const IconCurve = () => (
  <Svg>
    <path d="M3 18h4l5-10 3 6h6" />
    <path d="M3 21h18" />
  </Svg>
);
const IconCone = () => (
  <Svg>
    <path d="M3 14l6-2 12-7M9 12l12 7M3 14h4" />
  </Svg>
);
const IconTarget = () => (
  <Svg>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="12" cy="12" r="0.8" fill="currentColor" />
  </Svg>
);
const IconReport = () => (
  <Svg>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 15v2M12 11v6M16 8v9" />
  </Svg>
);
const IconCalendar = () => (
  <Svg>
    <rect x="3.5" y="5" width="17" height="15" rx="2" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Svg>
);
