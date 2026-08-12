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
  getCyclePeriod,
  getCompletedCycleCount,
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

const resolveProfitPerShare = (investment, scheduleMap) => {
  if (investment.profitPerShareOverride != null && investment.profitPerShareOverride !== '') {
    return Number(investment.profitPerShareOverride) || 0;
  }
  const schedule = scheduleMap ? scheduleMap.get(investment.projectId) : null;
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

const enrichInvestmentRow = (investment, maps) => {
  const view = buildMaturityView(investment);
  if (!view) return null;

  const profitPerShare = resolveProfitPerShare(investment, maps.scheduleMap);
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
 * Build all maturity/payoff report rows:
 * 1) Explicit maturityEnabled investments
 * 2) Existing Assign Profit schedules (Aug 3 weekly → matured Aug 10, etc.)
 * Does NOT rewrite existing investments — schedule rows are derived live.
 */
const buildAllMaturityRows = async (asOf = new Date()) => {
  const todayStr = getTodayDateStr(asOf);
  const [schedules, users, projects, allPayoffs, allPayouts] = await Promise.all([
    DB.profitSchedules.find({ status: 'active' }),
    DB.users.listInvestors(),
    DB.projects.find({}),
    DB.maturityPayoffs.find({}),
    DB.payouts.find({})
  ]);

  const scheduleMap = new Map(schedules.map((s) => [s.projectId, s]));
  const userMap = new Map(users.map((u) => [u._id, u]));
  const projectMap = new Map(projects.map((p) => [p._id, p]));
  const maps = { userMap, projectMap, scheduleMap };

  const projectIds = schedules.map((s) => s.projectId);
  const investments = projectIds.length
    ? await DB.investments.find({ projectIds, statusIn: ['active', 'completed'] })
    : [];

  // Also include maturity-enabled investments that may not be on a schedule
  const maturityOnly = DB.investments.findMaturityEnabled
    ? await DB.investments.findMaturityEnabled({})
    : (await DB.investments.find({})).filter((i) => i.maturityEnabled && i.maturityType);
  const byId = new Map();
  for (const inv of investments) byId.set(inv._id, inv);
  for (const inv of maturityOnly) {
    if (!byId.has(inv._id)) byId.set(inv._id, inv);
  }

  const payoffsByInv = new Map();
  for (const p of allPayoffs) {
    if (!payoffsByInv.has(p.investmentId)) payoffsByInv.set(p.investmentId, []);
    payoffsByInv.get(p.investmentId).push(p);
  }

  // Manual profit payouts (Profit Payouts page) that aren't maturity ledger rows
  const payoutCoverByInv = new Map();
  const payoutCoverByInvestorProject = new Map();
  for (const p of allPayouts) {
    if (p.payoutType === 'maturity_payoff') continue;
    const amt = Number(p.amount) || 0;
    if (!amt) continue;
    if (p.investmentId) {
      payoutCoverByInv.set(p.investmentId, (payoutCoverByInv.get(p.investmentId) || 0) + amt);
    } else if (p.investorId && p.projectId) {
      const key = `${p.investorId}:${p.projectId}`;
      payoutCoverByInvestorProject.set(key, (payoutCoverByInvestorProject.get(key) || 0) + amt);
    }
  }
  // Shared remaining cover for investor+project when payout has no investmentId
  const remainingProjectCover = new Map(payoutCoverByInvestorProject);

  const rows = [];

  for (const investment of byId.values()) {
    const shares = Number(investment.sharesCount) || 0;
    if (shares <= 0) continue;
    if (!['active', 'completed'].includes(investment.status || 'active')) continue;

    const investor = userMap.get(investment.investorId);
    const project = projectMap.get(investment.projectId);
    const schedule = scheduleMap.get(investment.projectId);
    const invPayoffs = payoffsByInv.get(investment._id) || [];
    const paidCycleSet = new Set(invPayoffs.map((p) => Number(p.cycleNumber)));

    // --- Path A: explicit per-investment maturity ---
    if (investment.maturityEnabled && investment.maturityType) {
      const view = buildMaturityView(investment, { asOf });
      if (view && !view.isPaid) {
        const profitPerShare = resolveProfitPerShare(investment, scheduleMap);
        const profitAmount = calcProfitAmount(shares, profitPerShare);
        const principalAmount = view.includePrincipalOnPayoff && !investment.principalReturned
          ? Number(investment.amount) || 0
          : 0;
        rows.push({
          source: 'investment_maturity',
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
          totalPayoff: profitAmount + principalAmount,
          maturityStartDate: investment.maturityStartDate,
          customMaturityDate: investment.customMaturityDate || null,
          ...view,
          rowKey: `${investment._id}:m:${view.currentCycleNumber}`
        });
      } else if (view && view.isPaid) {
        rows.push({
          source: 'investment_maturity',
          investmentId: investment._id,
          investorId: investment.investorId,
          projectId: investment.projectId,
          investorName: investor?.name || '—',
          investorEmail: investor?.email || '',
          investorPhone: investor?.phone || '',
          projectTitle: project?.title || 'Project',
          shares,
          investmentAmount: Number(investment.amount) || 0,
          profitPerShare: resolveProfitPerShare(investment, scheduleMap),
          profitAmount: 0,
          principalAmount: 0,
          totalPayoff: 0,
          maturityStartDate: investment.maturityStartDate,
          ...view,
          rowKey: `${investment._id}:m:paid`
        });
      }
      // Still also show schedule unpaid cycles if any (skip if same weekly schedule already covered by explicit maturity)
      continue;
    }

    // --- Path B: existing Assign Profit schedule (most investors) ---
    if (!schedule) continue;
    const completed = getCompletedCycleCount(schedule, asOf);
    const profitPerShare = Number(schedule.profitPerShare) || 0;
    const perCycle = calcProfitAmount(shares, profitPerShare);

    // Cover unpaid cycles with leftover manual payouts (FIFO)
    let leftoverPayout = payoutCoverByInv.get(investment._id) || 0;
    const projCoverKey = `${investment.investorId}:${investment.projectId}`;
    if (!leftoverPayout && remainingProjectCover.has(projCoverKey)) {
      leftoverPayout = remainingProjectCover.get(projCoverKey) || 0;
    }

    for (let cycle = 1; cycle <= completed; cycle += 1) {
      if (paidCycleSet.has(cycle)) continue;
      if (leftoverPayout >= perCycle - 0.009) {
        leftoverPayout -= perCycle;
        if (!payoutCoverByInv.has(investment._id)) {
          remainingProjectCover.set(projCoverKey, leftoverPayout);
        }
        continue; // already paid via Profit Payouts page
      }
      if (!payoutCoverByInv.has(investment._id)) {
        remainingProjectCover.set(projCoverKey, leftoverPayout);
      }

      const period = getCyclePeriod(schedule, cycle);
      const daysMatured = Math.max(0, daysBetween(period.periodEnd, todayStr));
      rows.push({
        source: 'profit_schedule',
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
        profitAmount: perCycle,
        principalAmount: 0,
        totalPayoff: perCycle,
        maturityType: schedule.cycleType === 'monthly' ? 'monthly' : 'weekly',
        maturityStatus: 'MATURED',
        maturityStartDate: schedule.startDate,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        maturityDate: period.periodEnd,
        nextMaturityDate: period.periodEnd,
        currentCycleNumber: cycle,
        currentCyclePeriod: `${period.periodStart} → ${period.periodEnd}`,
        completedCycles: completed,
        daysRemaining: 0,
        daysMatured,
        isMatured: true,
        isPaid: false,
        recurring: true,
        includePrincipalOnPayoff: false,
        earnedFormula: `${shares} × ৳${profitPerShare.toLocaleString('en-US')} = ৳${perCycle.toLocaleString('en-US')}`,
        rowKey: `${investment._id}:s:${cycle}`
      });
    }

    // Upcoming / active current cycle (not yet matured)
    const nextCycle = completed + 1;
    const nextPeriod = getCyclePeriod(schedule, nextCycle);
    if (nextPeriod && todayStr <= nextPeriod.periodEnd) {
      const daysRemaining = Math.max(0, daysBetween(todayStr, nextPeriod.periodEnd));
      const upcomingStatus = daysRemaining <= 7 ? 'UPCOMING' : 'ACTIVE';
      rows.push({
        source: 'profit_schedule',
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
        profitAmount: perCycle,
        principalAmount: 0,
        totalPayoff: perCycle,
        maturityType: schedule.cycleType === 'monthly' ? 'monthly' : 'weekly',
        maturityStatus: upcomingStatus,
        maturityStartDate: schedule.startDate,
        periodStart: nextPeriod.periodStart,
        periodEnd: nextPeriod.periodEnd,
        maturityDate: nextPeriod.periodEnd,
        nextMaturityDate: nextPeriod.periodEnd,
        currentCycleNumber: nextCycle,
        currentCyclePeriod: `${nextPeriod.periodStart} → ${nextPeriod.periodEnd}`,
        completedCycles: completed,
        daysRemaining,
        daysMatured: 0,
        isMatured: false,
        isPaid: false,
        recurring: true,
        includePrincipalOnPayoff: false,
        rowKey: `${investment._id}:s:next:${nextCycle}`
      });
    }
  }

  return { rows, todayStr, maps };
};

/**
 * List matured / filtered rows with pagination (schedule + explicit maturity).
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

  const { rows: allRows, todayStr } = await buildAllMaturityRows();
  let rows = allRows;

  if (maturityType && maturityType !== 'all') {
    rows = rows.filter((r) => r.maturityType === maturityType);
  }
  if (projectId) {
    rows = rows.filter((r) => r.projectId === projectId);
  }

  if (status && status !== 'all') {
    if (status === 'MATURED') {
      rows = rows.filter((r) => r.isMatured && !r.isPaid);
    } else if (status === 'PAID') {
      rows = rows.filter((r) => r.isPaid || r.maturityStatus === 'PAID');
    } else if (status === 'UPCOMING') {
      rows = rows.filter((r) => !r.isMatured && !r.isPaid && r.maturityStatus === 'UPCOMING');
    } else if (status === 'ACTIVE') {
      rows = rows.filter((r) => !r.isMatured && !r.isPaid);
    } else {
      rows = rows.filter((r) => r.maturityStatus === status);
    }
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
 * Aggregate counts from schedule-backed + maturity-enabled rows.
 */
const getMaturityCounts = async () => {
  const { rows, todayStr } = await buildAllMaturityRows();
  const counts = {
    weeklyMatured: 0,
    monthlyMatured: 0,
    customMatured: 0,
    upcoming: 0,
    paidToday: 0,
    active: 0
  };

  for (const r of rows) {
    if (r.isMatured && !r.isPaid) {
      if (r.maturityType === 'weekly') counts.weeklyMatured += 1;
      else if (r.maturityType === 'monthly') counts.monthlyMatured += 1;
      else if (r.maturityType === 'custom') counts.customMatured += 1;
    } else if (!r.isPaid && r.maturityStatus === 'UPCOMING') {
      counts.upcoming += 1;
    } else if (!r.isPaid && !r.isMatured) {
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
 * Atomic payoff for one matured cycle (explicit maturity OR Assign Profit schedule).
 */
const payOffMaturity = async ({
  investmentId,
  adminId,
  paymentMethod = 'Bank Transfer',
  referenceNo = '',
  screenshotUrl = '',
  notes = '',
  includePrincipal,
  cycleNumber: requestedCycle
}) => {
  if (!investmentId) throw new Error('investmentId is required');
  if (!adminId) throw new Error('adminId is required');

  const investment = await DB.investments.findById(investmentId);
  if (!investment) throw new Error('Investment not found');

  const { rows } = await buildAllMaturityRows();
  const maturedRows = rows.filter((r) =>
    r.investmentId === investmentId && r.isMatured && !r.isPaid
  );

  let target = null;
  if (requestedCycle != null && requestedCycle !== '') {
    target = maturedRows.find((r) => Number(r.currentCycleNumber) === Number(requestedCycle));
  } else {
    // Earliest unpaid matured cycle
    target = maturedRows.sort((a, b) => a.currentCycleNumber - b.currentCycleNumber)[0];
  }

  if (!target) {
    throw new Error('No unpaid matured cycle found for this investment.');
  }

  const cycleNumber = target.currentCycleNumber;
  const existing = await DB.maturityPayoffs.findOne({ investmentId, cycleNumber });
  if (existing) {
    throw new Error('This maturity cycle has already been paid.');
  }

  const profitPerShare = Number(target.profitPerShare) || 0;
  const shares = Number(target.shares) || Number(investment.sharesCount) || 0;
  const profitAmount = Number(target.profitAmount) || calcProfitAmount(shares, profitPerShare);

  const wantPrincipal = includePrincipal != null
    ? Boolean(includePrincipal)
    : Boolean(target.includePrincipalOnPayoff);
  const principalAmount = wantPrincipal && !investment.principalReturned
    ? Number(investment.amount) || 0
    : 0;
  const totalPayoff = profitAmount + principalAmount;
  const now = new Date().toISOString();

  const investmentUpdate = {
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

  if (investment.maturityEnabled) {
    const nextPaid = Math.max(Number(investment.maturityCyclesPaid) || 0, cycleNumber);
    investmentUpdate.maturityCyclesPaid = nextPaid;
    if (target.recurring) {
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
  }

  // Tag schedule-backed payoffs with maturityType for history filters
  const investmentForLedger = {
    ...investment,
    maturityType: target.maturityType || investment.maturityType || 'weekly'
  };

  const result = await DB.maturityPayoffs.createPayoffTransaction({
    investment: investmentForLedger,
    cycleNumber,
    periodStart: target.periodStart,
    maturityDate: target.maturityDate,
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
  const { rows } = await buildAllMaturityRows();
  const mine = rows.filter((r) => r.investorId === investorId);
  const payoffs = await DB.maturityPayoffs.find({ investorId });

  // Prefer one summary row per investment (latest / matured first)
  const byInv = new Map();
  for (const r of mine) {
    const prev = byInv.get(r.investmentId);
    if (!prev || (r.isMatured && !prev.isMatured) || (r.currentCycleNumber > (prev.currentCycleNumber || 0))) {
      byInv.set(r.investmentId, {
        ...r,
        payoffHistory: payoffs
          .filter((p) => p.investmentId === r.investmentId)
          .sort((a, b) => (b.cycleNumber || 0) - (a.cycleNumber || 0))
      });
    }
  }
  return [...byInv.values()];
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
  buildAllMaturityRows,
  listMaturities,
  getMaturityCounts,
  payOffMaturity,
  getInvestorMaturitySummary,
  enrichInvestmentRow,
  loadScheduleMap
};
