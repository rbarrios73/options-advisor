import { SEVERITY_LABELS } from '@domain/manage.js';

/**
 * What to watch on this position at today's prices, worst first.
 *
 * Each alert carries its severity as a word and an icon, not only a colour, so it reads the same
 * to a colour-blind reader and in print. Severity colours are kept for these and used nowhere
 * else on the page. None of it moves with the what-if sliders: an alert about a scenario you
 * dragged to would be an alert about a position you do not hold.
 */
export default function RiskAlerts({ alerts }) {
  const counts = alerts.reduce((c, a) => ({ ...c, [a.severity]: (c[a.severity] ?? 0) + 1 }), {});

  return (
    <section className="panel risk-alerts" aria-labelledby="alerts-title">
      <div className="chart-head">
        <h2 id="alerts-title">Risk alerts</h2>
        <span className="muted small">
          {alerts.length === 0
            ? 'at today’s prices'
            : ['critical', 'warning', 'info']
                .filter((k) => counts[k])
                .map((k) => `${counts[k]} ${SEVERITY_LABELS[k].toLowerCase()}`)
                .join(' · ') + ' · at today’s prices'}
        </span>
      </div>

      {alerts.length === 0 ? (
        <p className="muted small alerts-none">
          <AlertIcon severity="ok" /> Nothing to flag: the strikes are clear of the price, the quotes are tight,
          and there is time left.
        </p>
      ) : (
        <ul className="alerts-list">
          {alerts.map((a, i) => (
            <li key={`${a.title}-${i}`} className={`alert sev-${a.severity}`}>
              <AlertIcon severity={a.severity} />
              <div>
                <p className="alert-title">
                  <span className="alert-sev">{SEVERITY_LABELS[a.severity]}</span> {a.title}
                </p>
                <p className="alert-detail">{a.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AlertIcon({ severity }) {
  const common = { width: 18, height: 18, viewBox: '0 0 20 20', 'aria-hidden': true, className: 'alert-icon' };
  if (severity === 'critical') {
    return (
      <svg {...common}>
        <path d="M10 2 L19 18 H1 Z" fill="currentColor" />
        <path d="M10 8 v4.5 M10 15 v.5" stroke="var(--panel)" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (severity === 'warning') {
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="8.5" fill="currentColor" />
        <path d="M10 5.5 v5.5 M10 14 v.5" stroke="var(--panel)" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (severity === 'ok') {
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M6 10.5 l2.5 2.5 L14 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10 9 v5 M10 6 v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
