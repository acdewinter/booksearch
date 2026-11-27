// Who is using the page, as the server sees it.

import { getJson } from './dom.js';

export const session = {
  authRequired: false,
  signedIn: false,
  methods: { password: false, username: false, hardcover: false },
  account: null, // { kind: 'local' | 'hardcover', hardcover: { id, username, name, signInAgain } | null }
};

export async function loadSession() {
  Object.assign(session, await getJson('/api/session'));
  return session;
}

/** The Hardcover account this session is signed in as, if any. */
export const hardcoverUser = () => session.account?.hardcover || null;

/** Where the "Sign in with Hardcover" button leads. `next` is the page to come back to. */
export function hardcoverSignInUrl(next = `${location.pathname}${location.search}`) {
  const url = new URL(next, location.origin);
  url.searchParams.delete('signin');
  return `/auth/hardcover?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`;
}

/** What went wrong on the way back from Hardcover, in words. */
export function signInProblem(code) {
  switch (code) {
    case 'denied': return 'You did not approve the connection on Hardcover, so nothing was changed.';
    case 'expired': return 'That sign-in took too long or was started in another browser. Try again.';
    case 'not-allowed': return 'That Hardcover account is not allowed to use this app.';
    case 'password-first': return 'Sign in with the app password first, then connect Hardcover. The first account to connect becomes the owner.';
    case 'scope': return 'Hardcover did not let this app read your profile. Allow the scope read:me:content on the app at hardcover.app, then try again.';
    case 'catalog-scope': return 'Hardcover did not grant the search scope. On hardcover.app, open your app under Developer Apps and allow read:catalog:search, then try again.';
    case 'unavailable': return 'Signing in with Hardcover is not set up on this server.';
    case 'failed': return 'Signing in with Hardcover did not work. Try again; if it keeps failing, check the client id, the secret and the redirect address.';
    default: return '';
  }
}
