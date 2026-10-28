const API_BASE = '/api';

const Api = {
  token: localStorage.getItem('hms_token') || null,
  user: JSON.parse(localStorage.getItem('hms_user') || 'null'),

  setSession(token, user) {
    this.token = token;
    this.user = user;
    localStorage.setItem('hms_token', token);
    localStorage.setItem('hms_user', JSON.stringify(user));
  },
  clearSession() {
    this.token = null;
    this.user = null;
    localStorage.removeItem('hms_token');
    localStorage.removeItem('hms_user');
  },

  // Protected /uploads/organization-<id>/... files (invoices, receipts, discharge summary
  // PDFs, patient documents) require the same Bearer auth as the API - but a plain <a href>
  // or window.open() navigation can't set an Authorization header, so the server's static
  // file guard was correctly rejecting those requests. The server already accepts the token
  // as a ?token= query param for exactly this case (see server/index.js's uploads route);
  // this helper appends it so any link/window.open pointed at a file the API returned
  // actually opens instead of getting a 401.
  fileUrl(path) {
    if (!path) return path;
    if (!this.token) return path; // no session - let the request 401 normally rather than send "token=null"
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}token=${encodeURIComponent(this.token)}`;
  },

  async req(method, path, body, isForm) {
    const headers = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    let opts = { method, headers };
    if (body) {
      if (isForm) {
        opts.body = body;
      } else {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    let res;
    try {
      res = await fetch(API_BASE + path, opts);
    } catch (e) {
      throw new Error('Network error. Please check your connection.');
    }
    if (res.status === 401) {
      Api.clearSession();
      window.location.hash = '#/login';
      throw new Error('Session expired. Please log in again.');
    }
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      throw new Error((data && data.error) || 'Something went wrong. Please try again.');
    }
    return data;
  },

  get(path) { return this.req('GET', path); },
  post(path, body, isForm) { return this.req('POST', path, body, isForm); },
  put(path, body, isForm) { return this.req('PUT', path, body, isForm); },
  del(path) { return this.req('DELETE', path); }
};
