/**
 * Single source of truth for investor profit calculations and dashboard data.
 * All profit amounts derive from: investorShares × profitPerShare per cycle.
 */
const DB = require('../db');
const {
  getTodayDateStr,
  getCyclePeriod,
  getDueCycleNumbers,
  processDueCyclesOnce,
  BD_TIMEZONE
} = require('./profitScheduleService');

const calcCycleProfit = (shares, profitPerShare) =>
  (Number(shares) || 0) * (Number(profitPerShare) || 0);

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

const buildScheduleView = (schedule, investorShares, asOf = new Date()) => {
  if (!schedule || investorShares <= 0) return null;

  const processed = schedule.cyclesProcessed || 0;
  const nextCycleNumber = processed + 1;
  const current = getCyclePeriod(schedule, nextCycleNumber);
  const dueCycles = getDueCycleNumbers(schedule, asOf);
  const dueNow = dueCycles.length > 0;
  const todayStr = getTodayDateStr(asOf);

  // Completed = cycles already credited (cyclesProcessed)
  const completedCycles = processed;
  let lastCompletedPeriod = null;
  if (completedCycles > 0) {
    lastCompletedPeriod = getCyclePeriod(schedule, completedCycles);
  }

  // Current active cycle is the next one to earn (not yet credited unless due)
  const currentCycleLabel = `${current.periodStart} → ${current.periodEnd}`;
  const nextPayoutDate = current.periodEnd;

  return {
    projectId: schedule.projectId,
    scheduleId: schedule._id,
    cycleType: schedule.cycleType,
    profitPerShare: Number(schedule.profitPerShare) || 0,
    investorShares,
    expectedProfitPerCycle: calcCycleProfit(investorShares, schedule.profitPerShare),
    completedCycles,
    lastCompletedPeriod,
    currentCycleNumber: nextCycleNumber,
    currentCyclePeriod: currentCycleLabel,
    currentPeriodStart: current.periodStart,
    currentPeriodEnd: current.periodEnd,
    nextPayoutDate,
    nextCycleNumber,
    dueNow,
    isCurrentCycleComplete: todayStr > current.periodEnd
  };
};

/**
 * Build per-project profit breakdown for an investor.
 * Earned = max(ledger sum, investment.returnEarned sum) per project.
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
  const scheduleByProject = new Map(activeSchedules.map(s => [s.projectId, s]));

  const projects = [];
  for (const [projectId, shares] of sharesByProject) {
    const schedule = scheduleByProject.get(projectId);
    const meta = projectMeta.get(projectId) || {};
    const scheduleView = schedule ? buildScheduleView(schedule, shares, asOf) : null;

    let projectTitle = meta.projectTitle || 'Project';
    if (schedule && !meta.projectTitle) {
      const p = await DB.projects.findById(projectId);
      if (p) projectTitle = p.title;
    }

    projects.push({
      projectId,
      projectTitle,
      projectCategory: meta.projectCategory || '',
      shares,
      earnedSoFar: earnedMerged.get(projectId) || 0,
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
 * Full investor dashboard bundle — processes due cycles once, then returns
 * consistent stats + per-project breakdown + ledger summary.
 */
const getInvestorDashboardBundle = async (investorId, options = {}) => {
  const { processCycles = true, adminId = 'system' } = options;

  if (processCycles) {
    await processDueCyclesOnce({ adminId });
  }

  const [stats, ledger, summaryBase] = await Promise.all([
    DB.investments.getPortfolioStats(investorId),
    DB.distributions.getInvestorLedger(investorId),
    DB.distributions.getInvestorSummary(investorId)
  ]);

  const projectBreakdown = await buildProjectBreakdown(investorId);
  const totalFromProjects = projectBreakdown.reduce((s, p) => s + p.earnedSoFar, 0);

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
  buildScheduleView,
  buildProjectBreakdown,
  getInvestorDashboardBundle
};
