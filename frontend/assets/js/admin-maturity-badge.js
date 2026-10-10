/**
 * Injects Maturity / Payouts nav link + live matured counts into admin sidebars.
 */
(function () {
  const ensureNavLink = () => {
    const nav = document.querySelector('.admin-nav');
    if (!nav) return null;
    let link = nav.querySelector('a[href="/admin/maturity.html"]');
    if (!link) {
      const payouts = nav.querySelector('a[href="/admin/payouts.html"]');
      link = document.createElement('a');
      link.href = '/admin/maturity.html';
      link.innerHTML = '<span class="nav-icon">⏳</span> Maturity / Payouts <span class="maturity-nav-badges" id="maturity-nav-badges"></span>';
      if (payouts && payouts.nextSibling) {
        payouts.parentNode.insertBefore(link, payouts.nextSibling);
      } else if (payouts) {
        payouts.parentNode.appendChild(link);
      } else {
        nav.appendChild(link);
      }
    }
    if (window.location.pathname.includes('/admin/maturity.html')) {
      link.classList.add('active');
    }
    return link;
  };

  const renderBadges = (counts) => {
    const el = document.getElementById('maturity-nav-badges');
    if (!el || !counts) return;
    const parts = [];
    if (counts.weeklyMatured) parts.push(`<span class="mat-badge mat-weekly" title="Weekly matured">🔴 ${counts.weeklyMatured}</span>`);
    if (counts.monthlyMatured) parts.push(`<span class="mat-badge mat-monthly" title="Monthly matured">🟠 ${counts.monthlyMatured}</span>`);
    if (counts.customMatured) parts.push(`<span class="mat-badge mat-custom" title="Custom matured">🔵 ${counts.customMatured}</span>`);
    el.innerHTML = parts.length ? parts.join(' ') : '';
  };

  // --- Withdrawal request notifications ---
  const WD_SEEN_KEY = 'wdLastSeenPendingAt';
  const WD_POLL_MS = 60000;

  const readSeen = () => {
    try { return localStorage.getItem(WD_SEEN_KEY) || ''; } catch (_) { return ''; }
  };
  const writeSeen = (value) => {
    try { localStorage.setItem(WD_SEEN_KEY, value || ''); } catch (_) { /* ignore */ }
  };

  const renderWithdrawalBadge = (counts) => {
    const link = document.querySelector('.admin-nav a[href="/admin/withdrawals.html"]');
    if (!link) return;
    let badge = link.querySelector('.wd-nav-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'wd-nav-badge';
      link.appendChild(badge);
    }
    badge.textContent = counts.pending > 99 ? '99+' : String(counts.pending || '');
    badge.title = `${counts.pending} withdrawal request(s) waiting for approval`;
    badge.style.display = counts.pending ? '' : 'none';
  };

  const checkWithdrawals = async (firstLoad) => {
    const counts = await apiFetch('/withdrawals/counts');
    renderWithdrawalBadge(counts);
    const latest = counts.latestPendingAt || '';
    const onWithdrawalsPage = window.location.pathname.includes('/admin/withdrawals.html');
    if (onWithdrawalsPage) {
      writeSeen(latest);
    } else if (latest && latest > readSeen()) {
      // Something arrived since the admin last opened the Withdrawals page
      if (typeof showToast === 'function') {
        showToast(`💸 New withdrawal request — ${counts.pending} waiting for approval`, 'info');
      }
      if (!firstLoad && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('New withdrawal request', { body: `${counts.pending} waiting for approval` });
      }
      writeSeen(latest);
    }
    document.dispatchEvent(new CustomEvent('withdrawal-counts', { detail: counts }));
  };

  const style = document.createElement('style');
  style.textContent = `
    .maturity-nav-badges { display:inline-flex; gap:4px; margin-left:6px; flex-wrap:wrap; }
    .mat-badge { font-size:0.65rem; font-weight:700; opacity:0.95; }
    .wd-nav-badge { margin-left:auto; min-width:20px; padding:1px 7px; border-radius:999px;
      background:#ef4444; color:#fff; font-size:0.7rem; font-weight:700; text-align:center; line-height:18px; }
  `;
  document.head.appendChild(style);

  document.addEventListener('DOMContentLoaded', async () => {
    ensureNavLink();
    if (typeof apiFetch !== 'function') return;
    let user = null;
    try { user = JSON.parse(localStorage.getItem('user') || 'null'); } catch (_) { /* ignore */ }
    if (!user || user.role !== 'admin') return;

    checkWithdrawals(true).catch(() => {});
    setInterval(() => {
      if (!document.hidden) checkWithdrawals(false).catch(() => {});
    }, WD_POLL_MS);

    try {
      const counts = await apiFetch('/maturity/counts');
      renderBadges(counts);
      window.__maturityCounts = counts;
      document.dispatchEvent(new CustomEvent('maturity-counts', { detail: counts }));
    } catch (_) {
      /* ignore — page may be public or offline */
    }
  });
})();
