import { useEffect, useState } from 'react';

import { api } from '../api.js';

import { tr } from '../i18n.js';
/**
 * Account administration. Admins only — the server enforces that too, which is the enforcement
 * that counts; hiding the tab is a courtesy, not a control.
 *
 * Passwords are set here rather than emailed, because this app sends no mail. Whatever you set,
 * you have to tell the person yourself — so it is shown once, plainly, and then it is gone.
 */
export default function UsersPage({ me }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('member');

  const load = () =>
    api
      .listUsers()
      .then((data) => setUsers(data.users))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  /** Runs an action, then reloads, keeping the two messages mutually exclusive. */
  const run = async (action, success) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
      if (success) setNotice(success);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const add = (event) => {
    event.preventDefault();
    run(
      () => api.createUser({ email, password, role }),
      tr('Added {0}. Tell them the password you just set — it is not shown again.', [email.trim().toLowerCase()]),
    ).then(() => {
      setEmail('');
      setPassword('');
      setRole('member');
    });
  };

  const resetPassword = (user) => {
    const next = window.prompt(tr('New password for {0} (at least 10 characters):', [user.email]));
    if (!next) return;
    run(
      () => api.updateUser(user.id, { password: next }),
      tr('Password set for {0}. They have been signed out everywhere and will need the new one.', [user.email]),
    );
  };

  const remove = (user) => {
    const sure = window.confirm(
      tr('Delete {0}? Their watchlist and saved filters go with them. This cannot be undone.', [user.email]),
    );
    if (sure) run(() => api.deleteUser(user.id), tr('Deleted {0}.', [user.email]));
  };

  return (
    <div className="users-page">
      <p className="muted small page-intro">
        {tr('Everyone signed in here keeps their own watchlist, filters and saved settings. They all share one market-data connection, so the rate limit is shared too — scans by one person use up the same allowance as scans by another.')}
      </p>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <section className="panel">
        <h2>{tr('Add someone')}</h2>
        <form className="controls" onSubmit={add}>
          <label className="control">
            <span>{tr('Email')}</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-email" />
          </label>

          <label className="control">
            <span>{tr('Password')}</span>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={10}
              required
              className="w-email"
              placeholder={tr('at least 10 characters')}
              // Not a password field: you are setting this for somebody else and have to read it
              // back to them. Hiding it behind dots would only invite a typo.
            />
          </label>

          <label className="control">
            <span>{tr('Role')}</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">{tr('Member')}</option>
              <option value="admin">{tr('Admin — can manage users')}</option>
            </select>
          </label>

          <button className="primary" type="submit" disabled={busy}>
            {tr('Add user')}
          </button>
        </form>
      </section>

      <section className="panel">
        <h2>{tr('Accounts')}</h2>

        {!users && <p className="muted">{tr('Loading…')}</p>}

        {users && (
          <div className="scroll-x">
            <table className="legs users-table">
              <thead>
                <tr>
                  <th>{tr('Email')}</th>
                  <th>{tr('Role')}</th>
                  <th>{tr('Status')}</th>
                  <th>{tr('Added')}</th>
                  <th>{tr('Last signed in')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const self = user.id === me.id;
                  return (
                    <tr key={user.id}>
                      <td>
                        {user.email}
                        {self && <span className="tag">{tr('you')}</span>}
                      </td>
                      <td>
                        <select
                          value={user.role}
                          disabled={busy || self}
                          title={self ? tr('You cannot change your own role') : undefined}
                          onChange={(e) => run(() => api.updateUser(user.id, { role: e.target.value }))}
                        >
                          <option value="member">{tr('Member')}</option>
                          <option value="admin">{tr('Admin')}</option>
                        </select>
                      </td>
                      <td>{user.disabled ? <span className="tag warn">{tr('disabled')}</span> : tr('active')}</td>
                      <td>{formatDate(user.createdAt)}</td>
                      <td>{user.lastLoginAt ? formatDate(user.lastLoginAt) : tr('never')}</td>
                      <td className="row-actions">
                        <button type="button" disabled={busy} onClick={() => resetPassword(user)}>
                          {tr('Set password')}
                        </button>
                        <button
                          type="button"
                          disabled={busy || self}
                          onClick={() => run(() => api.updateUser(user.id, { disabled: !user.disabled }))}
                        >
                          {user.disabled ? tr('Enable') : tr('Disable')}
                        </button>
                        <button type="button" disabled={busy || self} onClick={() => remove(user)}>
                          {tr('Delete')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="muted small">
          {tr('Disabling someone keeps their watchlist and ends their sessions straight away; deleting removes both. The app always keeps at least one enabled administrator, so the last one cannot be deleted, demoted or disabled — including by themselves.')}
        </p>
      </section>
    </div>
  );
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
