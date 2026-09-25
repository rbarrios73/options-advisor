// Which pages exist, and who may open them.
//
// Deliberately free of React, so it can be tested on its own — this decides what the nav offers,
// and getting it wrong shows up as a tab that leads somewhere broken rather than as a crash.

export const PAGES = {
  screener: { label: 'Screener' },
  ticker: { label: 'Ticker' },
  simulator: { label: 'Simulator' },

  // accountsOnly as well as adminOnly, and both are load-bearing: with no database the app runs
  // single-user and calls that lone user an admin, so adminOnly alone would show a Users tab
  // pointing at routes the server never registered — "No such endpoint." on the first click.
  users: { label: 'Users', adminOnly: true, accountsOnly: true },
  account: { label: 'Account', accountsOnly: true, signedInOnly: true },
};

/** The pages this person can actually open, in nav order. */
export function pagesFor({ accounts, user }) {
  return Object.entries(PAGES).filter(
    ([, page]) =>
      (!page.adminOnly || user?.role === 'admin') &&
      (!page.accountsOnly || accounts) &&
      (!page.signedInOnly || Boolean(user)),
  );
}
