/**
 * Centralized investor maturity engine.
 * Opt-in only: investments with maturityEnabled=true (new assigns).
 * Existing investments without that flag are never recalculated.
 */
const DB = require('../db');
const {
  getTodayDateStr,
  parseDateOnly,
  dateToIsoDate,
  addCalendarMonths,
  BD_TIMEZONE
} = require('./profitScheduleService');

const MATURITY_TYPES = ['weekly', 'monthly', 'custom'];
const MATURITY_STATUSES = ['ACTIVE', 'UPCOMING', 'MATURED', 'PAID', 'CANCELLED'];

const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

const daysBetween = (fromStr, toStr) => {
  const a = parseDateOnly(fromStr);
  const b = parseDateOnly(toStr);
  return Math.round((b - a) / 86400000);
};

/**
 * Cycle period for an investment-owned maturity schedule.
 * Weekly: start Aug 3 → Cycle 1 Aug 3–9, Cycle 2 Aug 10–16
 * Monthly: start Aug 3 → Cycle 1 matures Sep 3, Cycle 2 matures Oct 3
 * Custom: single cycle using customMaturityDate
 */
const getMaturityCyclePeriod = (investment, cycleNumber) => {
  const n = Math.max(1, Number(cycleNumber) || 1);
  const type = investment.maturityType;
  const startStr = investment.maturityStartDate || investment.startDate;
  if (!startStr) return null;

  if (type === 'custom') {
    const end = investment.customMaturityDate || investment.maturityDate || startStr;
    return { periodStart: startStr, periodEnd: end, maturityDate: end };
  }

  if (type === 'monthly') {
    const start = parseDateOnly(startStr);
    const periodStart = addCalendarMonths(start, n - 1);
    const periodEnd = addCalendarMonths(start, n);
    return {
      periodStart: dateToIsoDate(periodStart),
      periodEnd: dateToIsoDate(periodEnd),
      maturityDate: dateToIsoDate(periodEnd)
    };
  }

  // weekly (default)
  const start = parseDateOnly(startStr);
  const periodStart = addDays(start, (n - 1) * 7);
  const periodEnd = addDays(periodStart, 6);
  return {
    periodStart: dateToIsoDate(periodStart),
    periodEnd: dateToIsoDate(periodEnd),
    maturityDate: dateToIsoDate(periodEnd)
  };
};

const resolveProfitPerShare = async (investment, scheduleMap) => {
  if (investment.profitPerShareOverride != null && investment.profitPerShareOverride !== '') {
    return Number(investment.profitPerShareOverride) || 0;
  }
  const schedule = scheduleMap
    ? scheduleMap.get(investment.projectId)
    : (await DB.profitSchedules.find({ projectId: investment.projectId, status: 'active' }))[0];
  if (schedule) return Number(schedule.profitPerShare) || 0;
  const shares = Number(investment.sharesCount) || 0;
  if (shares > 0 && Number(investment.expectedReturn) > 0) {
    return Math.round((Number(investment.expectedReturn) / shares) * 100) / 100;
  }
  return 0;
};

const calcProfitAmount = (shares, profitPerShare) =>
  (Number(shares) || 0) * (Number(profitPerShare) || 0);

/**
 * Live maturity view for one investment (never mutates DB).
 */
const buildMaturityView = (investment, opts = {}) => {
  if (!investment || !investment.maturityEnabled || !investment.maturityType) {
    return null;
  }
  if (investment.maturityStatus === 'CANCELLED') {
    return {
      enabled: true,
      maturityType: investment.maturityType,
      maturityStatus: 'CANCELLED',
      isMatured: false,
      isPaid: false
    };
  }

  const asOf = opts.asOf || new Date();
  const todayStr = getTodayDateStr(asOf);
  const paidCycles = Number(investment.maturityCyclesPaid) || 0;
  const recurring = investment.recurringMaturity !== false && investment.maturityType !== 'custom';

  if (!recurring && paidCycles >= 1) {
    const last = getMaturityCyclePeriod(investment, 1);
    return {
      enabled: true,
      maturityType: investment.maturityType,
      maturityStatus: 'PAID',
      currentCycleNumber: 1,
      completedCycles: 1,
      periodStart: last?.periodStart || null,
      maturityDate: last?.maturityDate || null,
      nextMaturityDate: null,
      daysRemaining: 0,
      daysMatured: 0,
      isMatured: false,
      isPaid: true,
      recurring: false
    };
  }

  const cycleNumber = paidCycles + 1;
  const period = getMaturityCyclePeriod(investment, cycleNumber);
  if (!period) {
    return {
      enabled: true,
      maturityType: investment.maturityType,
      maturityStatus: investment.maturityStatus || 'ACTIVE',
      isMatured: false,
      isPaid: false
    };
  }

  const isMatured = todayStr >= period.maturityDate;
  const daysRemaining = isMatured ? 0 : Math.max(0, daysBetween(todayStr, period.maturityDate));
  const daysMatured = isMatured ? Math.max(0, daysBetween(period.maturityDate, todayStr)) : 0;

  let maturityStatus = 'ACTIVE';
  if (isMatured) maturityStatus = 'MATURED';
  else if (daysRemaining > 0) maturityStatus = daysRemaining <= 7 ? 'UPCOMING' : 'ACTIVE';

  return {
    enabled: true,
    maturityType: investment.maturityType,
    maturityStatus,
    currentCycleNumber: cycleNumber,
    completedCycles: paidCycles,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    maturityDate: period.maturityDate,
    nextMaturityDate: period.maturityDate,
    currentCyclePeriod: `${period.periodStart} → ${period.periodEnd}`,
    daysRemaining,
    daysMatured,
    isMatured,
    isPaid: false,
    recurring,
    includePrincipalOnPayoff: Boolean(investment.includePrincipalOnPayoff)
  };
};

const initMaturityFields = (payload) => {
  if (!payload.maturityEnabled && !payload.maturityType) {
    return {};
  }
  const maturityType = String(payload.maturityType || '').toLowerCase();
  if (!MATURITY_TYPES.includes(maturityType)) {
    throw new Error('maturityType must be weekly, monthly, or custom');
  }
  const maturityStartDate = payload.maturityStartDate || payload.startDate;
  if (!maturityStartDate) {
    throw new Error('maturityStartDate (or startDate) is required when maturity is enabled');
  }
  if (maturityType === 'custom' && !payload.customMaturityDate) {
    throw new Error('customMaturityDate is required for custom maturity');
  }

  const recurringMaturity = payload.recurringMaturity != null
    ? Boolean(payload.recurringMaturity)
    : maturityType !== 'custom';

  const includePrincipalOnPayoff = payload.includePrincipalOnPayoff != null
    ? Boolean(payload.includePrincipalOnPayoff)
    : maturityType === 'custom';

  const draft = {
    maturityEnabled: true,
    maturityType,
    maturityStartDate,
    customMaturityDate: maturityType === 'custom' ? payload.customMaturityDate : null,
    recurringMaturity,
    includePrincipalOnPayoff,
    profitPerShareOverride: payload.profitPerShareOverride != null
      ? Number(payload.profitPerShareOverride)
      : undefined,
    maturityCyclesPaid: 0,
    currentMaturityCycle: 1,
    maturityStatus: 'ACTIVE',
    activatedAt: new Date().toISOString(),
    startDate: payload.startDate || maturityStartDate
  };

  const period = getMaturityCyclePeriod(draft, 1);
  draft.nextMaturityDate = period.maturityDate;
  draft.maturityDate = period.maturityDate;
  return draft;
};

const loadScheduleMap = async () => {
  const schedules = await DB.profitSchedules.find({ status: 'active' });
  return new Map(schedules.map((s) => [s.projectId, s]));
};

const enrichInvestmentRow = async (investment, maps) => {
  const view = buildMaturityView(investment);
  if (!view) return null;

  const profitPerShare = await resolveProfitPerShare(investment, maps.scheduleMap);
  const shares = Number(investment.sharesCount) || 0;
  const profitAmount = calcProfitAmount(shares, profitPerShare);
  const principalAmount = view.includePrincipalOnPayoff && !investment.principalReturned
    ? Number(investment.amount) || 0
    : 0;
  const totalPayoff = profitAmount + principalAmount;

  const investor = maps.userMap.get(investment.investorId);
  const project = maps.projectMap.get(investment.projectId);

  return {
    investmentId: investment._id,
    investorId: investment.investorId,
    projectId: investment.projectId,
    investorName: investor?.name || '—',
    investorEmail: investor?.email || '',
    investorPhone: investor?.phone || '',
    projectTitle: project?.title || 'Project',
    shares,
    investmentAmount: Number(investment.amount) || 0,
    profitPerShare,
    profitAmount,
    principalAmount,
    totalPayoff,
    maturityStartDate: investment.maturityStartDate,
    customMaturityDate: investment.customMaturityDate || null,
    ...view
  };
};

/**
 * List matured (or filtered) maturity-enabled investments with pagination.
 */
const listMaturities = async (query = {}) => {
  const {
    maturityType,
    status = 'MATURED',
    search = '',
    projectId,
    page = 1,
    limit = 25,
    sortBy = 'maturityDate',
    sortDir = 'asc'
  } = query;

  const asOf = new Date();
  const todayStr = getTodayDateStr(asOf);

  // Only maturity-enabled investments — existing legacy rows are skipped
  let investments = await DB.investments.findMaturityEnabled
    ? await DB.investments.findMaturityEnabled({})
    : (await DB.investments.find({})).filter((i) => i.maturityEnabled && i.maturityType);

  if (maturityType && maturityType !== 'all') {
    investments = investments.filter((i) => i.maturityType === maturityType);
  }
  if (projectId) {
    investments = investments.filter((i) => i.projectId === projectId);
  }

  // Soft-refresh derived status in memory (no mass DB write)
  const views = investments
    .map((inv) => ({ inv, view: buildMaturityView(inv, { asOf }) }))
    .filter((x) => x.view);

  let filtered = views;
  if (status && status !== 'all') {
    if (status === 'MATURED') {
      filtered = views.filter((x) => x.view.isMatured && !x.view.isPaid);
    } else if (status === 'PAID') {
      filtered = views.filter((x) => x.view.isPaid || x.view.maturityStatus === 'PAID');
    } else if (status === 'UPCOMING') {
      filtered = views.filter((x) => !x.view.isMatured && !x.view.isPaid && x.view.maturityStatus === 'UPCOMING');
    } else if (status === 'ACTIVE') {
      filtered = views.filter((x) => !x.view.isMatured && !x.view.isPaid);
    } else {
      filtered = views.filter((x) => x.view.maturityStatus === status);
    }
  }

  const [users, projects, scheduleMap] = await Promise.all([
    DB.users.listInvestors(),
    DB.projects.find({}),
    loadScheduleMap()
  ]);
  const userMap = new Map(users.map((u) => [u._id, u]));
  const projectMap = new Map(projects.map((p) => [p._id, p]));
  const maps = { userMap, projectMap, scheduleMap };

  let rows = [];
  for (const { inv } of filtered) {
    const row = await enrichInvestmentRow(inv, maps);
    if (row) rows.push(row);
  }

  const q = String(search || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) =>
      (r.investorName || '').toLowerCase().includes(q) ||
      (r.investorEmail || '').toLowerCase().includes(q) ||
      (r.projectTitle || '').toLowerCase().includes(q) ||
      (r.investorId || '').toLowerCase().includes(q)
    );
  }

  const dir = sortDir === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    if (sortBy === 'investorName') {
      return dir * String(a.investorName).localeCompare(String(b.investorName));
    }
    if (sortBy === 'profitAmount') {
      return dir * ((a.profitAmount || 0) - (b.profitAmount || 0));
    }
    return dir * String(a.maturityDate || '').localeCompare(String(b.maturityDate || ''));
  });

  const pageNum = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 25));
  const total = rows.length;
  const start = (pageNum - 1) * pageSize;
  const items = rows.slice(start, start + pageSize);

  return {
    items,
    pagination: {
      page: pageNum,
      limit: pageSize,
      total,
      pages: Math.ceil(total / pageSize) || 1
    },
    asOf: todayStr,
    timezone: BD_TIMEZONE
  };
};

/**
 * Aggregate counts from maturity-enabled investments only.
 */
const getMaturityCounts = async () => {
  const asOf = new Date();
  const todayStr = getTodayDateStr(asOf);
  const investments = DB.investments.findMaturityEnabled
    ? await DB.investments.findMaturityEnabled({})
    : (await DB.investments.find({})).filter((i) => i.maturityEnabled && i.maturityType);

  const counts = {
    weeklyMatured: 0,
    monthlyMatured: 0,
    customMatured: 0,
    upcoming: 0,
    paidToday: 0,
    active: 0
  };

  for (const inv of investments) {
    const view = buildMaturityView(inv, { asOf });
    if (!view) continue;
    if (view.isMatured && !view.isPaid) {
      if (view.maturityType === 'weekly') counts.weeklyMatured += 1;
      else if (view.maturityType === 'monthly') counts.monthlyMatured += 1;
      else if (view.maturityType === 'custom') counts.customMatured += 1;
    } else if (!view.isPaid && view.maturityStatus === 'UPCOMING') {
      counts.upcoming += 1;
    } else if (!view.isPaid) {
      counts.active += 1;
    }
  }

  const payoffs = await DB.maturityPayoffs.find({});
  counts.paidToday = payoffs.filter((p) => {
    if (!p.paidAt) return false;
    return getTodayDateStr(new Date(p.paidAt)) === todayStr;
  }).length;
  counts.totalMatured = counts.weeklyMatured + counts.monthlyMatured + counts.customMatured;

  return { ...counts, asOf: todayStr, timezone: BD_TIMEZONE };
};

/**
 * Atomic payoff for one matured cycle.
 */
const payOffMaturity = async ({
  investmentId,
  adminId,
  paymentMethod = 'Bank Transfer',
  referenceNo = '',
  screenshotUrl = '',
  notes = '',
  includePrincipal
}) => {
  if (!investmentId) throw new Error('investmentId is required');
  if (!adminId) throw new Error('adminId is required');

  const investment = await DB.investments.findById(investmentId);
  if (!investment) throw new Error('Investment not found');
  if (!investment.maturityEnabled || !investment.maturityType) {
    throw new Error('This investment does not use the maturity system');
  }

  const view = buildMaturityView(investment);
  if (!view) throw new Error('Unable to compute maturity for this investment');
  if (view.isPaid) throw new Error('This maturity cycle has already been paid.');
  if (!view.isMatured) {
    throw new Error(`Investment is not matured yet (matures on ${view.maturityDate})`);
  }

  const cycleNumber = view.currentCycleNumber;
  const existing = await DB.maturityPayoffs.findOne({ investmentId, cycleNumber });
  if (existing) {
    throw new Error('This maturity cycle has already been paid.');
  }

  const scheduleMap = await loadScheduleMap();
  const profitPerShare = await resolveProfitPerShare(investment, scheduleMap);
  const shares = Number(investment.sharesCount) || 0;
  const profitAmount = calcProfitAmount(shares, profitPerShare);

  const wantPrincipal = includePrincipal != null
    ? Boolean(includePrincipal)
    : Boolean(view.includePrincipalOnPayoff);
  const principalAmount = wantPrincipal && !investment.principalReturned
    ? Number(investment.amount) || 0
    : 0;
  const totalPayoff = profitAmount + principalAmount;
  const now = new Date().toISOString();

  const nextPaid = (Number(investment.maturityCyclesPaid) || 0) + 1;
  let investmentUpdate = {
    maturityCyclesPaid: nextPaid,
    lastMaturedAt: now,
    profitNotAssigned: false
  };

  if (profitAmount > 0) {
    const currentEarned = typeof investment.returnEarned === 'number' ? investment.returnEarned : 0;
    investmentUpdate.returnEarned = currentEarned + profitAmount;
  }
  if (principalAmount > 0) {
    investmentUpdate.principalReturned = true;
  }

  if (view.recurring) {
    const nextCycle = nextPaid + 1;
    const nextPeriod = getMaturityCyclePeriod(investment, nextCycle);
    investmentUpdate.currentMaturityCycle = nextCycle;
    investmentUpdate.nextMaturityDate = nextPeriod?.maturityDate || null;
    investmentUpdate.maturityDate = nextPeriod?.maturityDate || investment.maturityDate;
    investmentUpdate.maturityStatus = 'ACTIVE';
  } else {
    investmentUpdate.currentMaturityCycle = cycleNumber;
    investmentUpdate.nextMaturityDate = null;
    investmentUpdate.maturityStatus = 'PAID';
    investmentUpdate.status = 'completed';
  }

  const result = await DB.maturityPayoffs.createPayoffTransaction({
    investment,
    cycleNumber,
    periodStart: view.periodStart,
    maturityDate: view.maturityDate,
    shares,
    profitPerShare,
    principalAmount,
    profitAmount,
    totalPayoff,
    paymentMethod: paymentMethod === 'bKash' ? 'bKash' : 'Bank Transfer',
    referenceNo,
    screenshotUrl,
    notes,
    adminId,
    paidAt: now,
    investmentUpdate
  });

  return result;
};

const getInvestorMaturitySummary = async (investorId) => {
  const investments = (await DB.investments.find({ investorId }))
    .filter((i) => i.maturityEnabled && i.maturityType);
  if (!investments.length) return [];

  const [projects, scheduleMap, payoffs] = await Promise.all([
    DB.projects.find({}),
    loadScheduleMap(),
    DB.maturityPayoffs.find({ investorId })
  ]);
  const projectMap = new Map(projects.map((p) => [p._id, p]));
  const maps = { userMap: new Map(), projectMap, scheduleMap };

  const rows = [];
  for (const inv of investments) {
    const row = await enrichInvestmentRow(inv, maps);
    if (!row) continue;
    row.payoffHistory = payoffs
      .filter((p) => p.investmentId === inv._id)
      .sort((a, b) => (b.cycleNumber || 0) - (a.cycleNumber || 0));
    rows.push(row);
  }
  return rows;
};

module.exports = {
  MATURITY_TYPES,
  MATURITY_STATUSES,
  BD_TIMEZONE,
  getMaturityCyclePeriod,
  buildMaturityView,
  initMaturityFields,
  resolveProfitPerShare,
  calcProfitAmount,
  listMaturities,
  getMaturityCounts,
  payOffMaturity,
  getInvestorMaturitySummary,
  enrichInvestmentRow,
  loadScheduleMap
};
