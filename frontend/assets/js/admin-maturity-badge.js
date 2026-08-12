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

  const style = document.createElement('style');
  style.textContent = `
    .maturity-nav-badges { display:inline-flex; gap:4px; margin-left:6px; flex-wrap:wrap; }
    .mat-badge { font-size:0.65rem; font-weight:700; opacity:0.95; }
  `;
  document.head.appendChild(style);

  document.addEventListener('DOMContentLoaded', async () => {
    ensureNavLink();
    if (typeof apiFetch !== 'function') return;
    try {
      const user = JSON.parse(localStorage.getItem('user') || 'null');
      if (!user || user.role !== 'admin') return;
      const counts = await apiFetch('/maturity/counts');
      renderBadges(counts);
      window.__maturityCounts = counts;
      document.dispatchEvent(new CustomEvent('maturity-counts', { detail: counts }));
    } catch (_) {
      /* ignore — page may be public or offline */
    }
  });
})();
