import { useState } from 'react';

import { MIN_PASSWORD_LENGTH } from '@domain/passwords.js';

import { api } from '../api.js';
import ThemeToggle from '../components/ThemeToggle.jsx';

/**
 * Signing in, and — when the deployment has an invite code — signing up.
 *
 * One card with two modes rather than two pages: they ask for the same two fields, and a separate
 * route for the second would mean a second place to get the cookie handling right.
 *
 * There is no "forgot password" link, deliberately: a reset by email needs email this app cannot
 * send, and a reset without it is not a reset, it is a back door. An administrator sets a new
 * password instead — which is what the message at the bottom says, so nobody is left guessing.
 */
export default function LoginPage({ onSignedIn, signupOpen, theme, onTheme }) {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const signingUp = mode === 'signup';

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const { user } = signingUp ? await api.signup({ email, password, code }) : await api.login(email, password);
      onSignedIn(user);
    } catch (e) {
      setError(e.message);
      // The password goes, the email and code stay. Retyping an address you just got right is
      // the small indignity every login form inflicts; there is no reason to repeat it here.
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next) => {
    setMode(next);
    setError(null);
    setPassword('');
  };

  return (
    <div className="signin">
      <form className="panel signin-card" onSubmit={submit}>
        {/* The logo is the heading here, so it carries the name rather than decorating one. */}
        <img className="signin-logo" src="/logo.png" alt="Option Advisor" width="240" height="226" />

        {signupOpen ? (
          <div className="segmented signin-modes" role="radiogroup" aria-label="Sign in or create an account">
            <button
              type="button"
              role="radio"
              aria-checked={!signingUp}
              className={signingUp ? '' : 'on'}
              onClick={() => switchTo('signin')}
            >
              Sign in
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={signingUp}
              className={signingUp ? 'on' : ''}
              onClick={() => switchTo('signup')}
            >
              Create account
            </button>
          </div>
        ) : (
          <p className="muted small">Sign in to see your watchlist.</p>
        )}

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
            // Telling the browser which it is lets a password manager offer to save a new one
            // rather than autofilling the old one into a sign-up form.
            autoComplete={signingUp ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={signingUp ? MIN_PASSWORD_LENGTH : undefined}
            required
          />
          {signingUp && (
            <span className="muted small">
              At least {MIN_PASSWORD_LENGTH} characters. A few words you will remember beats a short
              one you will not.
            </span>
          )}
        </label>

        {signingUp && (
          <label className="field">
            <span>Invite code</span>
            <input
              type="text"
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            <span className="muted small">From whoever runs this copy of the app.</span>
          </label>
        )}

        {error && <p className="error small">{error}</p>}

        <button className="primary" type="submit" disabled={busy || !email || !password || (signingUp && !code)}>
          {busy ? (signingUp ? 'Creating…' : 'Signing in…') : signingUp ? 'Create account' : 'Sign in'}
        </button>

        <p className="muted small">
          {signingUp
            ? 'Your watchlists, positions and filters are yours alone — nobody else’s account can see them.'
            : 'Forgotten your password? An administrator can set a new one — there is no reset email, because this app does not send mail.'}
        </p>
      </form>

      {/* The appearance control belongs here too: this is the first screen a new viewer sees, and
          "I cannot read this" should not be something you have to sign in to fix. */}
      <div className="signin-theme">
        <span className="muted small">Appearance</span>
        <ThemeToggle value={theme} onChange={onTheme} />
      </div>
    </div>
  );
}
