import { useState } from 'react';

import { api } from '../api.js';

/** Your own account: who you are, and changing your password. */
export default function AccountPage({ me }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const mismatch = next && confirm && next !== confirm;

  const submit = async (event) => {
    event.preventDefault();
    if (mismatch) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setNotice('Password changed. Anywhere else you were signed in has been signed out.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="account-page">
      <section className="panel">
        <h2>Your account</h2>
        <dl className="facts">
          <div>
            <dt>Email</dt>
            <dd>{me.email}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{me.role === 'admin' ? 'Administrator — can manage users' : 'Member'}</dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <h2>Change password</h2>

        <form className="stack" onSubmit={submit}>
          <label className="field">
            <span>Current password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </label>

          <label className="field">
            <span>New password</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </label>

          <label className="field">
            <span>New password again</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </label>

          {mismatch && <p className="error small">The two new passwords do not match.</p>}
          {error && <p className="error small">{error}</p>}
          {notice && <p className="notice small">{notice}</p>}

          <button className="primary" type="submit" disabled={busy || mismatch || !current || !next}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </form>

        <p className="muted small">
          At least 10 characters. Changing it signs out every other device — which is the point,
          if the reason you are changing it is that one of them should not still be signed in.
        </p>
      </section>
    </div>
  );
}
