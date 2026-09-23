import { useEffect, useState } from 'react';

import { api } from '../api.js';

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
      `Added ${email.trim().toLowerCase()}. Tell them the password you just set — it is not shown again.`,
    ).then(() => {
      setEmail('');
      setPassword('');
      setRole('member');
    });
  };

  const resetPassword = (user) => {
    const next = window.prompt(`New password for ${user.email} (at least 10 characters):`);
    if (!next) return;
    run(
      () => api.updateUser(user.id, { password: next }),
      `Password set for ${user.email}. They have been signed out everywhere and will need the new one.`,
    );
  };

  const remove = (user) => {
    const sure = window.confirm(
      `Delete ${user.email}? Their watchlist and saved filters go with them. This cannot be undone.`,
    );
    if (sure) run(() => api.deleteUser(user.id), `Deleted ${user.email}.`);
  };

  return (
    <div className="users-page">
      <p className="muted small page-intro">
        Everyone signed in here keeps their own watchlist, filters and saved settings. They all
        share one market-data connection, so the rate limit is shared too — scans by one person
        use up the same allowance as scans by another.
      </p>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <section className="panel">
        <h2>Add someone</h2>
        <form className="controls" onSubmit={add}>
          <label className="control">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-email" />
          </label>

          <label className="control">
            <span>Password</span>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={10}
              required
              className="w-email"
              placeholder="at least 10 characters"
              // Not a password field: you are setting this for somebody else and have to read it
              // back to them. Hiding it behind dots would only invite a typo.
            />
          </label>

          <label className="control">
            <span>Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">Member</option>
              <option value="admin">Admin — can manage users</option>
            </select>
          </label>

          <button className="primary" type="submit" disabled={busy}>
            Add user
          </button>
        </form>
      </section>

      <section className="panel">
        <h2>Accounts</h2>

        {!users && <p className="muted">Loading…</p>}

        {users && (
          <div className="scroll-x">
            <table className="legs users-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Added</th>
                  <th>Last signed in</th>
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
                        {self && <span className="tag">you</span>}
                      </td>
                      <td>
                        <select
                          value={user.role}
                          disabled={busy || self}
                          title={self ? 'You cannot change your own role' : undefined}
                          onChange={(e) => run(() => api.updateUser(user.id, { role: e.target.value }))}
                        >
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </select>
                      </td>
                      <td>{user.disabled ? <span className="tag warn">disabled</span> : 'active'}</td>
                      <td>{formatDate(user.createdAt)}</td>
                      <td>{user.lastLoginAt ? formatDate(user.lastLoginAt) : 'never'}</td>
                      <td className="row-actions">
                        <button type="button" disabled={busy} onClick={() => resetPassword(user)}>
                          Set password
                        </button>
                        <button
                          type="button"
                          disabled={busy || self}
                          onClick={() => run(() => api.updateUser(user.id, { disabled: !user.disabled }))}
                        >
                          {user.disabled ? 'Enable' : 'Disable'}
                        </button>
                        <button type="button" disabled={busy || self} onClick={() => remove(user)}>
                          Delete
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
          Disabling someone keeps their watchlist and ends their sessions straight away; deleting
          removes both. The app always keeps at least one enabled administrator, so the last one
          cannot be deleted, demoted or disabled — including by themselves.
        </p>
      </section>
    </div>
  );
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
