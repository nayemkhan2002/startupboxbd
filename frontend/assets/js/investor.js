/* Shared investor shell helpers */

const investorNav = (active) => {
  const items = [
    { href: '/investor/dashboard.html', key: 'dashboard', icon: '▣', label: 'Dashboard' },
    { href: '/investor/investments.html', key: 'investments', icon: '◈', label: 'My Investments' },
    { href: '/investor/payouts.html', key: 'payouts', icon: '💰', label: 'Profit Payouts' },
    { href: '/investor/withdrawals.html', key: 'withdrawals', icon: '⇄', label: 'Withdrawal Requests' },
    { href: '/investor/profile.html', key: 'profile', icon: '◉', label: 'Profile' },
    { href: '/investor/security.html', key: 'security', icon: '🔒', label: 'Security' },
    { href: '/investor/explore.html', key: 'explore', icon: '◎', label: 'Explore Projects' }
  ];
  return items.map((i) => `
    <a href="${i.href}" class="${i.key === active ? 'active' : ''}">
      <span class="nav-icon">${i.icon}</span> ${i.label}
    </a>`).join('');
};

const investorBottomNav = (active) => `
  <nav class="mobile-bottom-nav" aria-label="Mobile">
    <a href="/investor/dashboard.html" class="${active === 'dashboard' ? 'active' : ''}"><span>▣</span>Home</a>
    <a href="/investor/investments.html" class="${active === 'investments' ? 'active' : ''}"><span>◈</span>Portfolio</a>
    <a href="/investor/payouts.html" class="${active === 'payouts' ? 'active' : ''}"><span>💰</span>Payouts</a>
    <a href="/investor/withdrawals.html" class="${active === 'withdrawals' ? 'active' : ''}"><span>⇄</span>Withdraw</a>
    <a href="/investor/profile.html" class="${active === 'profile' ? 'active' : ''}"><span>◉</span>Profile</a>
  </nav>`;

const invStatusClass = (status) => {
  const s = String(status || 'pending').toLowerCase();
  if (s === 'active') return 'inv-status inv-status-active';
  if (s === 'completed') return 'inv-status inv-status-completed';
  if (s === 'cancelled') return 'inv-status inv-status-cancelled';
  return 'inv-status inv-status-pending';
};

const wdStatusClass = (status) => {
  const s = String(status || 'pending').toLowerCase();
  return `status-badge wd-status-${s}`;
};

const formatDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

const durationLabel = (inv) => {
  if (inv.durationLabel) return inv.durationLabel;
  if (inv.duration) return `${inv.duration} Months`;
  return '—';
};

const syncLocalUser = (profile) => {
  const raw = localStorage.getItem('user');
  if (!raw) return;
  try {
    const u = JSON.parse(raw);
    localStorage.setItem('user', JSON.stringify({
      ...u,
      name: profile.name || u.name,
      email: profile.email || u.email,
      phone: profile.phone,
      address: profile.address,
      profileImage: profile.profileImage,
      bankInfo: profile.bankInfo
    }));
  } catch (_) {}
};

const renderAvatar = (el, user) => {
  if (!el) return;
  if (user.profileImage) {
    el.innerHTML = `<img src="${escapeHtml(user.profileImage)}" alt="">`;
    el.style.padding = '0';
    el.style.overflow = 'hidden';
  } else {
    el.textContent = (user.name || 'I').charAt(0).toUpperCase();
  }
};
