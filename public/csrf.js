// Small helper shared by every page: fetches a CSRF token once, caches it,
// and attaches it to any state-changing request (POST/PUT/DELETE).
const CsrfClient = (() => {
  let cachedToken = null;

  async function getToken(forceRefresh = false) {
    if (cachedToken && !forceRefresh) return cachedToken;
    const res = await fetch('/api/csrf-token', { credentials: 'include' });
    const data = await res.json();
    cachedToken = data.csrfToken;
    return cachedToken;
  }

  async function request(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const needsToken = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const headers = Object.assign({}, options.headers || {});

    if (needsToken) {
      headers['X-CSRF-Token'] = await getToken();
    }

    let res = await fetch(url, { ...options, headers, credentials: 'include' });

    // Token may have gone stale (new session, expired, etc). Retry once.
    if (needsToken && res.status === 403) {
      headers['X-CSRF-Token'] = await getToken(true);
      res = await fetch(url, { ...options, headers, credentials: 'include' });
    }

    return res;
  }

  async function getJson(url) {
    return request(url, { method: 'GET' });
  }

  async function postJson(url, body) {
    return request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function del(url) {
    return request(url, { method: 'DELETE' });
  }

  return { getToken, request, getJson, postJson, del };
})();
