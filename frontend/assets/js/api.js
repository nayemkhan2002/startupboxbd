const API_URL = '/api';

const apiFetch = async (endpoint, options = {}) => {
  const token = localStorage.getItem('token');

  const headers = {
    ...options.headers,
  };

  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers,
  });

  const contentType = response.headers.get('content-type');
  let data;

  if (contentType && contentType.includes('application/json')) {
    data = await response.json();
  } else {
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`Server Error (${response.status}): ${rawText.replace(/<[^>]*>?/gm, '').substring(0, 150)}`);
    }
    data = { message: rawText };
  }

  if (!response.ok) {
    throw new Error(data.message || 'Something went wrong');
  }

  return data;
};

const logout = () => {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = '/login.html';
};

const checkAuth = (requiredRole, options = {}) => {
  const { soft = false } = options;
  const returnPath = options.next || `${window.location.pathname}${window.location.search}`;
  const loginUrl = `/login.html?next=${encodeURIComponent(returnPath)}`;
  const userStr = localStorage.getItem('user');

  if (!userStr) {
    if (soft) return null;
    window.location.href = loginUrl;
    return null;
  }

  let user;
  try {
    user = JSON.parse(userStr);
  } catch (_) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    if (soft) return null;
    window.location.href = loginUrl;
    return null;
  }

  if (requiredRole && user.role !== requiredRole) {
    if (soft) return user;
    if (user.role === 'admin') {
      window.location.href = '/admin/dashboard.html';
      return null;
    }
    if (user.role === 'investor') {
      window.location.href = '/investor/dashboard.html';
      return null;
    }
    window.location.href = loginUrl;
    return null;
  }

  return user;
};

/* ---------- UI helpers ---------- */

const formatMoney = (n) => `৳ ${Number(n || 0).toLocaleString('en-US')}`;

const progressPct = (raised, target) => {
  const t = Number(target) || 0;
  if (t <= 0) return 0;
  return Math.min(100, Math.round((Number(raised || 0) / t) * 100));
};

const truncate = (str, len = 110) => {
  const s = String(str || '');
  return s.length > len ? s.slice(0, len).trim() + '…' : s;
};

const escapeHtml = (str) =>
  String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const riskClass = (level) => {
  const l = String(level || 'Medium').toLowerCase();
  if (l === 'low') return 'risk-low';
  if (l === 'high') return 'risk-high';
  return 'risk-medium';
};

const statusClass = (status) => {
  const s = String(status || 'pending').toLowerCase();
  if (s === 'reviewed') return 'status-reviewed';
  if (s === 'contacted') return 'status-contacted';
  if (s === 'closed') return 'status-closed';
  return 'status-pending';
};

const projectStatusBadge = (status) => {
  const s = String(status || 'open').toLowerCase();
  if (s === 'closed') return '<span class="badge badge-closed">Closed</span>';
  if (s === 'coming_soon') return '<span class="badge badge-coming">Coming Soon</span>';
  return '<span class="badge badge-open">Open</span>';
};

const ensureToastHost = () => {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  return host;
};

const showToast = (message, type = 'info') => {
  const host = ensureToastHost();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s ease';
    setTimeout(() => el.remove(), 300);
  }, 3200);
};

const confirmDialog = (message, { title = 'Confirm', confirmText = 'Confirm', danger = false } = {}) =>
  new Promise((resolve) => {
    let overlay = document.querySelector('.dialog-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'dialog-overlay';
      overlay.innerHTML = `
        <div class="dialog-box">
          <h3 class="dialog-title"></h3>
          <p class="dialog-msg"></p>
          <div class="dialog-actions">
            <button type="button" class="btn btn-outline dialog-cancel">Cancel</button>
            <button type="button" class="btn dialog-confirm">Confirm</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
    }
    overlay.querySelector('.dialog-title').textContent = title;
    overlay.querySelector('.dialog-msg').textContent = message;
    const confirmBtn = overlay.querySelector('.dialog-confirm');
    confirmBtn.textContent = confirmText;
    confirmBtn.className = danger ? 'btn btn-danger dialog-confirm' : 'btn dialog-confirm';
    overlay.classList.add('open');

    const cleanup = (result) => {
      overlay.classList.remove('open');
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      resolve(result);
    };
    const onCancel = () => cleanup(false);
    const onConfirm = () => cleanup(true);
    const cancelBtn = overlay.querySelector('.dialog-cancel');
    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
  });

const initSidebarToggle = (sidebarSelector = '.app-sidebar, .admin-sidebar') => {
  const sidebar = document.querySelector(sidebarSelector);
  const toggles = document.querySelectorAll('[data-sidebar-toggle]');
  if (!sidebar || !toggles.length) return;

  let overlay = document.querySelector('.sidebar-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);
  }

  const close = () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  };
  const open = () => {
    sidebar.classList.add('open');
    overlay.classList.add('open');
  };

  toggles.forEach((btn) => btn.addEventListener('click', () => {
    if (sidebar.classList.contains('open')) close();
    else open();
  }));
  overlay.addEventListener('click', close);
};

const projectCardHtml = (p, { href, cta = 'View Opportunity' } = {}) => {
  const pct = progressPct(p.raisedAmount, p.targetAmount);
  const initial = escapeHtml((p.title || 'P').charAt(0).toUpperCase());
  const media = p.thumbnail
    ? `<img src="${escapeHtml(p.thumbnail)}" alt="${escapeHtml(p.title)}" loading="lazy">`
    : `<div class="media-fallback">${initial}</div>`;

  return `
    <article class="project-card">
      <div class="project-card-media">${media}</div>
      <div class="project-card-body">
        <div class="project-card-top">
          <span class="badge">${escapeHtml(p.category || 'General')}</span>
          ${projectStatusBadge(p.status)}
        </div>
        <h3 class="project-card-title">${escapeHtml(p.title)}</h3>
        <p class="project-card-desc">${escapeHtml(truncate(p.description, 120))}</p>
        <div>
          <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
          <div class="progress-meta">
            <span>${formatMoney(p.raisedAmount)} raised</span>
            <span>${pct}%</span>
          </div>
        </div>
        <div class="project-meta-row">
          <span class="meta-chip">Target <strong>${formatMoney(p.targetAmount)}</strong></span>
          <span class="meta-chip">ROI <strong>${escapeHtml(p.expectedROI || 'N/A')}</strong></span>
          ${p.duration ? `<span class="meta-chip">${escapeHtml(p.duration)}</span>` : ''}
          <span class="risk-pill ${riskClass(p.riskLevel)}"><span class="risk-dot"></span>${escapeHtml(p.riskLevel || 'Medium')}</span>
        </div>
        ${p.status === 'closed'
          ? `<span class="btn btn-closed btn-block">🔒 Closed</span>`
          : `<a href="${href}" class="btn btn-outline btn-block">${cta}</a>`}
      </div>
    </article>`;
};

const skeletonCards = (n = 3) =>
  Array.from({ length: n }, () => `<div class="surface-card skeleton skeleton-card"></div>`).join('');
