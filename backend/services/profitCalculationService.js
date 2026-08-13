/**
 * Single source of truth for investor profit calculations and dashboard data.
 * All profit amounts derive from: investorShares × profitPerShare per cycle.
 */
const DB = require('../db');
const {
  getTodayDateStr,
  getCyclePeriod,
  getCompletedCycleCount,
  processDueCyclesOnce,
  BD_TIMEZONE
} = require('./profitScheduleService');

const calcCycleProfit = (shares, profitPerShare) =>
  (Number(shares) || 0) * (Number(profitPerShare) || 0);

/** Sum manual profit payouts recorded per project for an investor. */
const getPaidByProject = async (investorId) => {
  const payouts = await DB.payouts.find({ investorId });
  const paidByProject = new Map();
  let totalPaid = 0;
  for (const p of payouts) {
    const amt = Number(p.amount) || 0;
    totalPaid += amt;
    if (p.projectId) {
      paidByProject.set(p.projectId, (paidByProject.get(p.projectId) || 0) + amt);
    }
  }
  return { paidByProject, totalPaid };
};

const settledEarned = (projectId, ledgerByProject, investmentByProject, paidByProject) =>
  Math.max(
    ledgerByProject.get(projectId) || 0,
    investmentByProject.get(projectId) || 0,
    paidByProject.get(projectId) || 0
  );

const buildCycleRows = (schedule, shares, completedCycles, paidSoFar) => {
  if (!schedule || completedCycles <= 0) return [];
  const perCycle = calcCycleProfit(shares, schedule.profitPerShare);
  let remainingPaid = Number(paidSoFar) || 0;
  const rows = [];
  for (let cycle = 1; cycle <= completedCycles; cycle += 1) {
    const { periodStart, periodEnd } = getCyclePeriod(schedule, cycle);
    const isPaid = remainingPaid >= perCycle - 0.009;
    if (isPaid) remainingPaid -= perCycle;
    rows.push({
      cycleNumber: cycle,
      cycleType: schedule.cycleType,
      periodStart,
      periodEnd,
      periodLabel: `${periodStart} → ${periodEnd}`,
      shares,
      profitPerShare: Number(schedule.profitPerShare) || 0,
      amount: perCycle,
      formula: formatEarnedFormula(shares, schedule.profitPerShare, 1),
      status: isPaid ? 'paid' : 'unpaid'
    });
  }
  return rows;
};

/** Merge ledger-based and investment.returnEarned per project (max avoids under-count). */
const mergeProjectEarned = (ledgerByProject, investmentByProject) => {
  const ids = new Set([...ledgerByProject.keys(), ...investmentByProject.keys()]);
  const merged = new Map();
  for (const projectId of ids) {
    merged.set(projectId, Math.max(
      ledgerByProject.get(projectId) || 0,
      investmentByProject.get(projectId) || 0
    ));
  }
  return merged;
};

const formatEarnedFormula = (shares, profitPerShare, cycles) => {
  const perCycle = calcCycleProfit(shares, profitPerShare);
  if (!cycles || cycles <= 0) return null;
  if (cycles === 1) {
    return `${shares} × ৳${Number(profitPerShare).toLocaleString('en-US')} = ৳${perCycle.toLocaleString('en-US')}`;
  }
  return `${cycles} × (${shares} × ৳${Number(profitPerShare).toLocaleString('en-US')}) = ৳${(perCycle * cycles).toLocaleString('en-US')}`;
};

const buildScheduleView = (schedule, investorShares, settledAmount = 0, asOf = new Date()) => {
  if (!schedule || investorShares <= 0) return null;

  const completedCycles = getCompletedCycleCount(schedule, asOf);
  const earningCycleNumber = completedCycles + 1;
  const current = getCyclePeriod(schedule, earningCycleNumber);
  const todayStr = getTodayDateStr(asOf);

  const perCycleProfit = calcCycleProfit(investorShares, schedule.profitPerShare);
  const accruedEarned = perCycleProfit * completedCycles;

  let lastCompletedPeriod = null;
  if (completedCycles > 0) {
    lastCompletedPeriod = getCyclePeriod(schedule, completedCycles);
  }

  const unpaidAccrued = Math.max(0, accruedEarned - (Number(settledAmount) || 0));
  const dueNow = unpaidAccrued > 0.009;

  const currentCycleLabel = `${current.periodStart} → ${current.periodEnd}`;
  const nextPayoutDate = dueNow && lastCompletedPeriod
    ? lastCompletedPeriod.periodEnd
    : current.periodEnd;

  return {
    projectId: schedule.projectId,
    scheduleId: schedule._id,
    cycleType: schedule.cycleType,
    profitPerShare: Number(schedule.profitPerShare) || 0,
    investorShares,
    expectedProfitPerCycle: perCycleProfit,
    completedCycles,
    accruedEarned,
    earnedFormula: formatEarnedFormula(investorShares, schedule.profitPerShare, completedCycles),
    lastCompletedPeriod,
    currentCycleNumber: earningCycleNumber,
    currentCyclePeriod: currentCycleLabel,
    currentPeriodStart: current.periodStart,
    currentPeriodEnd: current.periodEnd,
    nextPayoutDate,
    nextCycleNumber: earningCycleNumber,
    dueNow,
    unpaidAccrued,
    isCurrentCycleComplete: todayStr > current.periodEnd
  };
};

/**
 * Build per-project profit breakdown for an investor.
 * With an active schedule, earned = completed calendar cycles × shares × rate
 * (display for manual admin payout). Falls back to ledger / returnEarned otherwise.
 */
const buildProjectBreakdown = async (investorId, asOf = new Date()) => {
  const [investments, ledgerEntries, activeSchedules] = await Promise.all([
    DB.investments.find({ investorId }),
    DB.distributions.getInvestorLedger(investorId),
    DB.profitSchedules.find({ status: 'active' })
  ]);

  const ledgerByProject = new Map();
  for (const e of ledgerEntries) {
    const pid = e.projectId;
    ledgerByProject.set(pid, (ledgerByProject.get(pid) || 0) + (Number(e.calculatedProfit) || 0));
  }

  const investmentByProject = new Map();
  const sharesByProject = new Map();
  const projectMeta = new Map();

  for (const inv of investments) {
    if (!['active', 'completed'].includes(inv.status)) continue;
    const pid = inv.projectId;
    const shares = Number(inv.sharesCount) || 0;
    if (shares <= 0) continue;
    sharesByProject.set(pid, (sharesByProject.get(pid) || 0) + shares);
    investmentByProject.set(pid, (investmentByProject.get(pid) || 0) + (Number(inv.returnEarned) || 0));
    if (!projectMeta.has(pid) && inv.project) {
      projectMeta.set(pid, {
        projectTitle: inv.project.title,
        projectCategory: inv.project.category
      });
    }
  }

  // Populate project titles if investments weren't populated
  const projectIds = [...sharesByProject.keys()];
  if (projectIds.length) {
    await Promise.all(projectIds.map(async (pid) => {
      if (projectMeta.has(pid)) return;
      const p = await DB.projects.findById(pid);
      if (p) projectMeta.set(pid, { projectTitle: p.title, projectCategory: p.category });
    }));
  }

  const earnedMerged = mergeProjectEarned(ledgerByProject, investmentByProject);
  const { paidByProject } = await getPaidByProject(investorId);
  const scheduleByProject = new Map(activeSchedules.map(s => [s.projectId, s]));

  const projects = [];
  for (const [projectId, shares] of sharesByProject) {
    const schedule = scheduleByProject.get(projectId);
    const meta = projectMeta.get(projectId) || {};
    const paidSoFar = settledEarned(projectId, ledgerByProject, investmentByProject, paidByProject);
    const scheduleView = schedule ? buildScheduleView(schedule, shares, paidSoFar, asOf) : null;

    let projectTitle = meta.projectTitle || 'Project';
    if (schedule && !meta.projectTitle) {
      const p = await DB.projects.findById(projectId);
      if (p) projectTitle = p.title;
    }

    const accruedEarned = scheduleView ? scheduleView.accruedEarned : 0;
    const earnedSoFar = schedule
      ? Math.max(accruedEarned, paidSoFar)
      : paidSoFar;

    projects.push({
      projectId,
      projectTitle,
      projectCategory: meta.projectCategory || '',
      shares,
      earnedSoFar,
      accruedEarned,
      paidSoFar,
      creditedEarned: paidSoFar,
      earnedFormula: scheduleView ? scheduleView.earnedFormula : null,
      unpaidAccrued: scheduleView ? scheduleView.unpaidAccrued : 0,
      profitPerShare: scheduleView ? scheduleView.profitPerShare : null,
      frequency: schedule ? schedule.cycleType : null,
      profitSchedule: schedule
        ? `${schedule.cycleType === 'monthly' ? 'Monthly' : 'Weekly'} · ৳${Number(schedule.profitPerShare).toLocaleString()}/share`
        : null,
      completedCycles: scheduleView ? scheduleView.completedCycles : 0,
      currentCycleNumber: scheduleView ? scheduleView.currentCycleNumber : null,
      currentCyclePeriod: scheduleView ? scheduleView.currentCyclePeriod : null,
      currentPeriodStart: scheduleView ? scheduleView.currentPeriodStart : null,
      currentPeriodEnd: scheduleView ? scheduleView.currentPeriodEnd : null,
      nextPayoutDate: scheduleView ? scheduleView.nextPayoutDate : null,
      expectedNextPayout: scheduleView ? scheduleView.expectedProfitPerCycle : null,
      dueNow: scheduleView ? scheduleView.dueNow : false,
      scheduleStatus: schedule ? schedule.status : 'none'
    });
  }

  return projects.sort((a, b) => a.projectTitle.localeCompare(b.projectTitle));
};

/**
 * Admin manual payout preview — investor search result with weekly/monthly earnings.
 */
const buildInvestorEarningsPreview = async (investorId, options = {}) => {
  const { frequency = 'all', asOf = new Date() } = options;
  const investor = await DB.users.getInvestorById(investorId);
  if (!investor) return null;

  const projects = await buildProjectBreakdown(investorId, asOf);
  const filtered = frequency === 'all'
    ? projects
    : projects.filter(p => p.frequency === frequency);

  const scheduleByProject = new Map(
    (await DB.profitSchedules.find({ status: 'active' })).map(s => [s.projectId, s])
  );

  const enriched = filtered.map((p) => {
    const schedule = scheduleByProject.get(p.projectId);
    const cycles = schedule
      ? buildCycleRows(schedule, p.shares, p.completedCycles || 0, p.paidSoFar || 0)
      : [];
    const unpaidCycles = cycles.filter(c => c.status === 'unpaid');
    return {
      ...p,
      cycles,
      unpaidCycleCount: unpaidCycles.length,
      unpaidCycleAmount: unpaidCycles.reduce((s, c) => s + c.amount, 0)
    };
  });

  const totalAccrued = enriched.reduce((s, p) => s + (p.accruedEarned || 0), 0);
  const totalPaid = enriched.reduce((s, p) => s + (p.paidSoFar || 0), 0);
  const totalUnpaid = enriched.reduce((s, p) => s + (p.unpaidAccrued || 0), 0);

  return {
    investor: {
      _id: investor._id,
      name: investor.name,
      email: investor.email,
      phone: investor.phone || '',
      bankInfo: investor.bankInfo || null
    },
    frequency,
    totalAccrued,
    totalPaid,
    totalUnpaid,
    projects: enriched
  };
};

/**
 * Full investor dashboard bundle — display-first (manual payout workflow).
 * Auto-credit via processDueCycles is opt-in (admin "Process Due" only).
 */
const getInvestorDashboardBundle = async (investorId, options = {}) => {
  const { processCycles = false, adminId = 'system' } = options;

  if (processCycles) {
    await processDueCyclesOnce({ adminId });
  }

  const [statsResult, ledgerResult, summaryBaseResult] = await Promise.allSettled([
    DB.investments.getPortfolioStats(investorId),
    DB.distributions.getInvestorLedger(investorId),
    DB.distributions.getInvestorSummary(investorId)
  ]);

  const stats = statsResult.status === 'fulfilled' ? statsResult.value : {
    totalInvested: 0,
    totalShares: 0,
    activeInvestments: 0,
    investmentCount: 0,
    totalReturnEarned: 0,
    availableBalance: 0,
    pendingWithdrawals: 0
  };
  const ledger = ledgerResult.status === 'fulfilled' ? ledgerResult.value : [];
  const summaryBase = summaryBaseResult.status === 'fulfilled' ? summaryBaseResult.value : { totalEarned: 0, monthly: [] };

  let projectBreakdown = [];
  try {
    projectBreakdown = await buildProjectBreakdown(investorId);
  } catch (err) {
    console.error(`buildProjectBreakdown failed for ${investorId}:`, err.message);
  }
  const totalFromProjects = projectBreakdown.reduce((s, p) => s + (p.earnedSoFar || 0), 0);

  return {
    stats: {
      ...stats,
      totalReturnEarned: Math.max(
        Number(stats.totalReturnEarned) || 0,
        totalFromProjects,
        Number(summaryBase.totalEarned) || 0
      )
    },
    projectBreakdown,
    ledger,
    monthly: summaryBase.monthly || [],
    totalEarned: Math.max(
      Number(stats.totalReturnEarned) || 0,
      totalFromProjects,
      Number(summaryBase.totalEarned) || 0
    ),
    perProject: projectBreakdown.map(p => ({
      projectId: p.projectId,
      projectTitle: p.projectTitle,
      projectCategory: p.projectCategory,
      totalProfit: p.earnedSoFar,
      totalShares: p.shares,
      distributions: p.completedCycles
    })),
    upcomingProfits: projectBreakdown
      .filter(p => p.frequency)
      .map(p => ({
        projectId: p.projectId,
        projectTitle: p.projectTitle,
        cycleType: p.frequency,
        profitPerShare: p.profitPerShare,
        investorShares: p.shares,
        expectedProfit: p.expectedNextPayout,
        nextDueDate: p.nextPayoutDate,
        nextPeriodStart: p.currentPeriodStart,
        nextCycleNumber: p.currentCycleNumber,
        currentCyclePeriod: p.currentCyclePeriod,
        dueNow: p.dueNow
      }))
  };
};

module.exports = {
  BD_TIMEZONE,
  calcCycleProfit,
  mergeProjectEarned,
  getPaidByProject,
  buildCycleRows,
  buildScheduleView,
  buildProjectBreakdown,
  buildInvestorEarningsPreview,
  getInvestorDashboardBundle
};
