import { useState } from 'react';

import { api } from '../api.js';

/**
 * The sign-in screen.
 *
 * There is no "forgot password" link, deliberately: a reset by email needs email this app cannot
 * send, and a reset without it is not a reset, it is a back door. An administrator sets a new
 * password instead — which is what the message at the bottom says, so nobody is left guessing.
 */
export default function LoginPage({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.login(email, password);
      onSignedIn(user);
    } catch (e) {
      setError(e.message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <form className="panel signin-card" onSubmit={submit}>
        <h1>Options Advisor</h1>
        <p className="muted small">Sign in to see your watchlist.</p>

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {error && <p className="error small">{error}</p>}

        <button className="primary" type="submit" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="muted small">
          Forgotten your password? An administrator can set a new one — there is no reset email,
          because this app does not send mail.
        </p>
      </form>
    </div>
  );
}
