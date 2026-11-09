// The audit log: who signed in, when, from where — and every change an administrator made to an
// account. Read on the Audit log page, by administrators only.
//
// Written alongside the action, never instead of it: a failure to record is logged to the console
// and the sign-in or change goes ahead. An app that locks everyone out because its log table is
// unhappy has the priorities backwards.
//
// What it keeps, and why it is enough: the account (id and the email as it was at the time, so a
// deleted or renamed account still reads), who acted when that was someone else, the IP address
// and the browser string. No passwords, no tokens, and for a failed sign-in only the address that
// was typed — that is what an administrator needs to see an attack, and nothing more.
//
// Kept for AUDIT_RETENTION_DAYS (180 by default) and pruned when the server starts, which on the
// free tier is at least daily.

export const AUDIT_EVENTS = {
  sign_in: 'Signed in',
  sign_in_failed: 'Failed sign-in',
  sign_out: 'Signed out',
  sign_up: 'Created an account',
  password_changed: 'Changed their password',
  password_reset: 'Password reset by an admin',
  user_created: 'Account created by an admin',
  user_updated: 'Account changed by an admin',
  user_deleted: 'Account deleted by an admin',
};

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/** What an administrator reads at a glance: "Chrome on Windows", not a 140-character string. */
export function describeAgent(ua) {
  if (!ua) return null;
  const s = String(ua);
  const browser = /Edg\//.test(s)
    ? 'Edge'
    : /OPR\/|Opera/.test(s)
      ? 'Opera'
      : /Firefox\//.test(s)
        ? 'Firefox'
        : /Chrome\//.test(s)
          ? 'Chrome'
          : /Safari\//.test(s)
            ? 'Safari'
            : /curl|wget|python|node|axios|httpie/i.test(s)
              ? 'Script'
              : 'Browser';
  const os = /iPhone|iPad|iPod/.test(s)
    ? 'iOS'
    : /Android/.test(s)
      ? 'Android'
      : /Windows/.test(s)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(s)
          ? 'macOS'
          : /Linux/.test(s)
            ? 'Linux'
            : null;
  return os ? `${browser} on ${os}` : browser;
}

/** The request's address and browser, as Express sees them (behind Render's proxy: trust proxy). */
export const clientOf = (req) => ({ ip: clip(req.ip, 64), userAgent: clip(req.get?.('user-agent'), 300) });

export function createAuditLog(db, { retentionDays = 180, now = () => new Date() } = {}) {
  return {
    /**
     * Records one event. Never throws: see the note at the top of this file.
     */
    async record({ event, userId = null, email = null, actorId = null, actorEmail = null, ip = null, userAgent = null, detail = null }) {
      if (!AUDIT_EVENTS[event]) throw new Error(`Unknown audit event: ${event}`);
      try {
        await db.query(
          `INSERT INTO audit_log (at, event, user_id, email, actor_id, actor_email, ip, user_agent, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [now(), event, userId, clip(email, 254), actorId, clip(actorEmail, 254), clip(ip, 64), clip(userAgent, 300), clip(detail, 300)],
        );
      } catch (error) {
        console.error(`audit log: could not record ${event}:`, error.message);
      }
    },

    /**
     * Newest first, a page at a time. `before` is the id of the last row already shown, so paging
     * stays put while new events arrive at the top.
     */
    async list({ limit = 50, before = null, event = null, userId = null } = {}) {
      const params = [];
      const where = [];
      if (before) {
        params.push(Number(before));
        where.push(`id < $${params.length}`);
      }
      if (event && AUDIT_EVENTS[event]) {
        params.push(event);
        where.push(`event = $${params.length}`);
      }
      if (userId) {
        params.push(String(userId));
        where.push(`user_id = $${params.length}`);
      }
      params.push(Math.min(Math.max(Number(limit) || 50, 1), 200) + 1);

      const { rows } = await db.query(
        `SELECT id, at, event, user_id AS "userId", email, actor_id AS "actorId", actor_email AS "actorEmail",
                ip, user_agent AS "userAgent", detail
         FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY id DESC LIMIT $${params.length}`,
        params,
      );

      const more = rows.length === params.at(-1);
      const entries = rows.slice(0, params.at(-1) - 1).map((r) => ({
        ...r,
        id: Number(r.id),
        at: new Date(r.at).toISOString(),
        label: AUDIT_EVENTS[r.event] ?? r.event,
        agent: describeAgent(r.userAgent),
      }));
      return { entries, more, next: more ? entries.at(-1).id : null };
    },

    /** Failed sign-ins in the last day, per address typed — the shape of a guessing attack. */
    async recentFailures({ hours = 24 } = {}) {
      const { rows } = await db.query(
        `SELECT email, count(*)::int AS attempts, max(at) AS last
         FROM audit_log WHERE event = 'sign_in_failed' AND at > $1
         GROUP BY email ORDER BY attempts DESC, last DESC LIMIT 10`,
        [new Date(now().getTime() - hours * 3_600_000)],
      );
      return rows.map((r) => ({ email: r.email, attempts: r.attempts, last: new Date(r.last).toISOString() }));
    },

    /** Drops entries past the retention window. Returns how many went. */
    async prune() {
      const cutoff = new Date(now().getTime() - retentionDays * 86_400_000);
      const { rowCount } = await db.query(`DELETE FROM audit_log WHERE at < $1`, [cutoff]);
      return rowCount ?? 0;
    },
  };
}
