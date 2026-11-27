// Talking to Hardcover: the OAuth sign-in (authorization code with PKCE, as a
// confidential client) and the GraphQL API.
//
// https://docs.hardcover.app/api/oauth/ and /api/getting-started/

import crypto from 'node:crypto';

const TOKEN_TIMEOUT_MS = 20_000;
const QUERY_TIMEOUT_MS = 40_000; // Hardcover stops a query after 30 seconds
const MAX_RETRIES = 4;
const MAX_WAIT_MS = 65_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An answer from Hardcover that was not what was asked for. `message` is fit to show. */
export class HardcoverError extends Error {
  constructor(message, { status = 0, code = '', scope = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.scope = scope;
  }

  /** The access token is no longer accepted. */
  get unauthorized() {
    return this.status === 401 || this.code === 'invalid_token';
  }

  /** The refresh token is spent or revoked: the person has to sign in again. */
  get signInAgain() {
    return this.code === 'invalid_grant' || this.code === 'invalid_client' || this.code === 'unauthorized_client';
  }
}

/** The secret a sign-in starts with, and what is sent to Hardcover in its place. */
export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export class HardcoverClient {
  /**
   * @param {object} o
   * @param {string} o.clientId
   * @param {string} o.clientSecret
   * @param {string} [o.scopes]
   * @param {string} [o.apiUrl]
   * @param {string} [o.webUrl]
   * @param {string} [o.userAgent]
   */
  constructor(o) {
    this.clientId = o.clientId || '';
    this.clientSecret = o.clientSecret || '';
    this.scopes = o.scopes || 'read:me:content read:library read:lists';
    this.apiUrl = o.apiUrl || 'https://api.hardcover.app';
    this.webUrl = o.webUrl || 'https://hardcover.app';
    this.userAgent = o.userAgent || 'Shelfmark';
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  /** Every callback names the server that issued the code; this is the only one accepted. */
  get issuer() {
    return this.apiUrl;
  }

  /** Where to send the browser so the person can approve the app. */
  authorizeUrl({ state, challenge, redirectUri, scope = this.scopes }) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
    });
    return `${this.webUrl}/oauth2/authorize?${params}`;
  }

  #basic() {
    return `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
  }

  async #form(endpoint, params) {
    let res;
    try {
      res = await fetch(`${this.apiUrl}/oauth2/${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: this.#basic(),
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': this.userAgent,
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch (err) {
      throw new HardcoverError(`Hardcover could not be reached (${err.cause?.code || err.name}).`);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      // an empty answer is fine for some calls
    }
    return { res, body };
  }

  async #token(params) {
    const { res, body } = await this.#form('token', params);
    if (!res.ok || !body?.access_token) {
      const detail = body?.error_description || body?.error || `status ${res.status}`;
      throw new HardcoverError(`Hardcover did not accept the sign-in: ${detail}`, { status: res.status, code: body?.error || '' });
    }
    const seconds = Number(body.expires_in);
    return {
      accessToken: String(body.access_token),
      refreshToken: body.refresh_token ? String(body.refresh_token) : '',
      expiresAt: Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000,
      scope: typeof body.scope === 'string' ? body.scope : '',
    };
  }

  /** Trade the code from the callback for tokens. */
  exchangeCode({ code, verifier, redirectUri }) {
    return this.#token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
  }

  /**
   * Get new tokens. The refresh token passed in is spent by this call:
   * the one that comes back has to be saved in its place straight away.
   */
  refresh(refreshToken) {
    return this.#token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** Tell Hardcover the session is over. Either token ends both. Never throws. */
  async revoke(token, hint = 'refresh_token') {
    if (!token) return;
    try {
      await this.#form('revoke', { token, token_type_hint: hint });
    } catch {
      // the tokens are dropped here either way
    }
  }

  /**
   * Run one GraphQL query. Waits and tries again when Hardcover says it is
   * busy or that the rate limit was reached.
   */
  async graphql(accessToken, query, variables = {}) {
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await fetch(`${this.apiUrl}/v1/graphql`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': this.userAgent,
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new HardcoverError(`Hardcover could not be reached (${err.cause?.code || err.name}).`);
      }

      if ([429, 502, 503, 504].includes(res.status) && attempt < MAX_RETRIES) {
        const header = res.headers.get('retry-after');
        const after = header === null ? NaN : Number(header);
        const wait = Number.isFinite(after) && after >= 0 ? after * 1000 : 1500 * 2 ** attempt;
        await res.arrayBuffer().catch(() => {});
        await sleep(Math.min(wait + 250, MAX_WAIT_MS));
        continue;
      }

      let body = null;
      try {
        body = await res.json();
      } catch {
        // not JSON
      }
      if (!res.ok) {
        const code = typeof body?.error === 'string' ? body.error : '';
        const detail = body?.error_description || body?.message || code || `status ${res.status}`;
        throw new HardcoverError(`Hardcover answered with an error: ${detail}`, {
          status: res.status,
          code,
          scope: typeof body?.scope === 'string' ? body.scope : '',
        });
      }
      if (Array.isArray(body?.errors) && body.errors.length) {
        const first = body.errors[0] || {};
        throw new HardcoverError(String(first.message || 'The query was not accepted.'), {
          status: 200,
          code: String(first.extensions?.code || 'graphql'),
        });
      }
      if (!body || typeof body.data !== 'object' || body.data === null) {
        throw new HardcoverError('Hardcover sent an answer that could not be read.', { status: res.status });
      }
      return body.data;
    }
  }
}
