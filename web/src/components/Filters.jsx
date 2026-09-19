import { STRATEGY_LABELS } from '../format.js';

const NUMERIC = [
  { key: 'minDte', label: 'Min days to expiry', step: 1 },
  { key: 'maxDte', label: 'Max days to expiry', step: 1 },
  { key: 'minWidth', label: 'Min strike width', step: 0.5 },
  { key: 'maxWidth', label: 'Max strike width', step: 0.5 },
  { key: 'maxShortDelta', label: 'Max short-leg delta', step: 0.05 },
  { key: 'minProbProfit', label: 'Min win probability', step: 0.05 },
  { key: 'minReturnOnRisk', label: 'Min return on risk', step: 0.05 },
  { key: 'minLiquidity', label: 'Min liquidity score', step: 0.05 },
  { key: 'maxLoss', label: 'Max loss per contract ($)', step: 50 },
  // Raising this multiplies the number of chain requests per scan by the same factor, which is
  // the quickest way to a provider rate limit. Hence the hint below the grid.
  { key: 'maxExpirations', label: 'Expiries per symbol', step: 1 },
  { key: 'targetDte', label: 'Preferred days to expiry', step: 5 },
];

export default function Filters({ filters, weights, onFilters, onWeights }) {
  const setNumber = (key, value) =>
    onFilters({ ...filters, [key]: value === '' ? null : Number(value) });

  const toggleStrategy = (key) => {
    const current = new Set(filters.strategies ?? []);
    if (current.has(key)) current.delete(key);
    else current.add(key);
    onFilters({ ...filters, strategies: [...current] });
  };

  return (
    <section className="panel">
      <h2>Filters</h2>

      <div className="strategies">
        {Object.entries(STRATEGY_LABELS).map(([key, label]) => (
          <label key={key} className="check">
            <input
              type="checkbox"
              checked={(filters.strategies ?? []).includes(key)}
              onChange={() => toggleStrategy(key)}
            />
            {label}
          </label>
        ))}
      </div>

      <div className="grid">
        {NUMERIC.map(({ key, label, step }) => (
          <label key={key} className="field">
            <span>{label}</span>
            <input
              type="number"
              step={step}
              value={filters[key] ?? ''}
              onChange={(e) => setNumber(key, e.target.value)}
            />
          </label>
        ))}
      </div>

      <p className="muted small">
        One scan costs about <strong>symbols × expiries per symbol</strong> requests. Raising
        &ldquo;expiries per symbol&rdquo; is the usual cause of a rate-limit error mid-scan; the
        ones kept are those closest to your preferred days to expiry.
      </p>

      <h3>Score weights</h3>
      <p className="muted small">
        These only decide the order of the table. Every underlying number is shown on each row, so
        a candidate you disagree with can be checked rather than taken on trust.
      </p>

      <div className="grid">
        {Object.entries(weights).map(([key, value]) => (
          <label key={key} className="field">
            <span>{key}</span>
            <input
              type="number"
              step={0.05}
              min={0}
              max={1}
              value={value}
              onChange={(e) => onWeights({ ...weights, [key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
    </section>
  );
}
