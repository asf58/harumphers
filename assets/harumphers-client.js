(() => {
  'use strict';

  const SESSION_KEY = 'harumphers_session';
  const LEGACY_KEYS = [
    'harumphers_auth',
    'harumphers_duq_id',
    'harumphers_role',
    'harumphers_member_name',
    'harumphers_member_id',
    'harumphers_member_number',
    'harumphers_myname',
    'harumphers_isadmin'
  ];

  function apiOrigin() {
    const configured = document.currentScript?.dataset.apiOrigin;
    const parsed = new URL(configured);
    const isLoopbackHttp = parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1');
    if (
      (parsed.protocol !== 'https:' && !isLoopbackHttp)
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      throw new Error('Harumphers API origin must be an HTTPS origin');
    }
    return parsed.origin;
  }

  const API_ORIGIN = apiOrigin();

  class HarumphersError extends Error {
    constructor(message, { code = 'REQUEST_FAILED', requestId, status = 0 } = {}) {
      super(message);
      this.name = 'HarumphersError';
      this.code = code;
      this.requestId = requestId;
      this.status = status;
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function classifyRsvp(value) {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (normalized === 'YES') return 'yes';
    if (normalized === 'NO') return 'no';
    if (normalized === 'MAYBE') return 'maybe';
    if (normalized === '' || normalized === 'NO RESPONSE') return 'pending';
    return 'unknown';
  }

  function safeImageUrl(value) {
    if (typeof value !== 'string' || value === '') return '';
    if (value.startsWith('/') && !value.startsWith('//')) return value;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return '';
    }
    const loopbackHttp = parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1');
    if (parsed.protocol !== 'https:' && !loopbackHttp) return '';
    if (parsed.username || parsed.password) return '';
    return parsed.href;
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  }

  function explicitApiPath(path) {
    return typeof path === 'string' && /^\/api\/[A-Za-z0-9/_-]+(?:\?[^#]*)?$/.test(path);
  }

  async function requestJson(path, init = {}, requiresSession = true) {
    if (!explicitApiPath(path)) {
      throw new HarumphersError('Requests must use an explicit API path.', {
        code: 'INVALID_API_PATH'
      });
    }

    const headers = new Headers(init.headers);
    if (requiresSession) {
      const token = localStorage.getItem(SESSION_KEY);
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }

    let response;
    try {
      response = await fetch(`${API_ORIGIN}${path}`, { ...init, headers });
    } catch {
      throw new HarumphersError('The app could not reach the server.', { code: 'OFFLINE' });
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.status === 401) clearSession();
    if (!response.ok) {
      const error = data?.error;
      throw new HarumphersError(error?.message || 'The request could not be completed.', {
        code: error?.code,
        requestId: error?.requestId,
        status: response.status
      });
    }

    return data;
  }

  async function login(path, body) {
    const data = await requestJson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, false);
    if (typeof data?.token !== 'string' || data.token.length === 0 || data.token.length > 4096) {
      clearSession();
      throw new HarumphersError('The server returned an invalid session.', {
        code: 'SESSION_INVALID'
      });
    }

    clearSession();
    localStorage.setItem(SESSION_KEY, data.token);
    return data;
  }

  window.Harumphers = Object.freeze({
    api(path, init) {
      return requestJson(path, init, true);
    },
    getSession() {
      return requestJson('/api/session', {}, true);
    },
    classifyRsvp,
    escapeHtml,
    loginAdmin(password) {
      return login('/api/login/admin', { password });
    },
    loginGuest(phrase) {
      return login('/api/login/guest', { phrase });
    },
    loginMember(memberNumber) {
      return login('/api/login/member', { memberNumber });
    },
    submitMemberRequest(name, memberNumber) {
      return requestJson('/api/member-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberNumber })
      }, false);
    },
    safeImageUrl,
    logout() {
      clearSession();
    }
  });
})();
