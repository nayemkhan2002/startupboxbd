const DB = require('../db');

const CYCLE_DAYS = { weekly: 7 };
const BD_TIMEZONE = 'Asia/Dhaka';

const parseDateOnly = (str) => {
  const [y, m, d] = String(str).split('-').map(Number);
  return new Date(y, m - 1, d);
};

const dateToIsoDate = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const addCalendarMonths = (date, months) => {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() !== day) d.setDate(0);
  return d;
};

/** Today as YYYY-MM-DD in Bangladesh (UTC+6) — matches how admins set schedule dates */
const getTodayDateStr = (asOf = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: BD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(asOf);

const getCycleDays = (cycleType) => (cycleType === 'weekly' ? 7 : 0);

/**
 * Cycle periods (inclusive end dates):
 * Weekly start Aug 3 → Cycle 1: Aug 3–9, Cycle 2: Aug 10–16
 * Monthly → calendar-month periods from start date
 * Profit credits after periodEnd (today > periodEnd).
 */
const getCyclePeriod = (schedule, cycleNumber) => {
  const start = parseDateOnly(schedule.startDate);
  const n = Math.max(1, Number(cycleNumber) || 1);

  if (schedule.cycleType === 'monthly') {
    const periodStart = addCalendarMonths(start, n - 1);
    const nextMonthStart = addCalendarMonths(start, n);
    const periodEnd = new Date(nextMonthStart);
    periodEnd.setDate(periodEnd.getDate() - 1);
    return { periodStart: dateToIsoDate(periodStart), periodEnd: dateToIsoDate(periodEnd) };
  }

  const periodStart = new Date(start);
  periodStart.setDate(periodStart.getDate() + (n - 1) * 7);
  const periodEnd = new Date(periodStart);
  periodEnd.setDate(periodEnd.getDate() + 6);
  return { periodStart: dateToIsoDate(periodStart), periodEnd: dateToIsoDate(periodEnd) };
};

/** Cycles whose inclusive end date has passed (profit is due). */
const isCycleDue = (periodEnd, todayStr) => todayStr > periodEnd;

const getDueCycleNumbers = (schedule, asOf = new Date()) => {
  if (schedule.status !== 'active') return [];
  const todayStr = getTodayDateStr(asOf);
  const alreadyDone = schedule.cyclesProcessed || 0;
  const due = [];
  let cycle = alreadyDone + 1;

  while (cycle <= alreadyDone + 52) {
    const { periodEnd } = getCyclePeriod(schedule, cycle);
    if (!isCycleDue(periodEnd, todayStr)) break;
    due.push(cycle);
    cycle += 1;
  }
  return due;
};

/** Calendar-completed cycles (period ended) — used for display / manual payout workflow. */
const getCompletedCycleCount = (schedule, asOf = new Date()) => {
  if (!schedule || schedule.status !== 'active') return schedule?.cyclesProcessed || 0;
  const todayStr = getTodayDateStr(asOf);
  let count = 0;
  let cycle = 1;
  while (cycle <= 520) {
    const { periodEnd } = getCyclePeriod(schedule, cycle);
    if (!isCycleDue(periodEnd, todayStr)) break;
    count = cycle;
    cycle += 1;
  }
  return count;
};

const getNextDueDate = (schedule) => {
  const nextCycle = (schedule.cyclesProcessed || 0) + 1;
  return getCyclePeriod(schedule, nextCycle).periodEnd;
};

const getNextPeriodStart = (schedule) => {
  const nextCycle = (schedule.cyclesProcessed || 0) + 1;
  return getCyclePeriod(schedule, nextCycle).periodStart;
};

const enrichSchedule = async (schedule) => {
  const project = await DB.projects.findById(schedule.projectId);
  const dueCycles = getDueCycleNumbers(schedule);
  const nextDueDate = schedule.status === 'active' ? getNextDueDate(schedule) : null;
  return {
    ...schedule,
    project: project ? { _id: project._id, title: project.title, category: project.category } : null,
    cycleDays: schedule.cycleType === 'weekly' ? 7 : null,
    dueCyclesCount: dueCycles.length,
    nextDueDate,
    nextCycleNumber: (schedule.cyclesProcessed || 0) + 1
  };
};

const processDueCycles = async (options = {}) => {
  const { adminId = 'system', scheduleId = null } = options;
  let schedules = scheduleId
    ? [await DB.profitSchedules.findById(scheduleId)].filter(Boolean)
    : await DB.profitSchedules.find({ status: 'active' });

  const processed = [];
  const skipped = [];
  const errors = [];

  for (const schedule of schedules) {
    // One bad schedule must never block the others, nor fail the request that
    // triggered processing (investor pages call this on every load).
    try {
      const dueCycles = getDueCycleNumbers(schedule);
      for (const cycleNumber of dueCycles) {
        const fresh = await DB.profitSchedules.findById(schedule._id);
        if (!fresh || fresh.status !== 'active') break;

        const { periodStart, periodEnd } = getCyclePeriod(fresh, cycleNumber);
        const endDate = parseDateOnly(periodEnd);
        const dist = await DB.distributions.confirmScheduledCycle({
          scheduleId: fresh._id,
          projectId: fresh.projectId,
          profitPerShare: fresh.profitPerShare,
          cycleNumber,
          cycleType: fresh.cycleType,
          periodStart,
          periodEnd,
          month: endDate.getMonth() + 1,
          year: endDate.getFullYear(),
          adminId,
          distributionDate: periodEnd
        });

        // Advance the schedule only when the cycle was credited or intentionally skipped
        // (no share-holders). A hard failure leaves cyclesProcessed unchanged so the
        // cycle retries on the next page load instead of vanishing unpaid.
        if (dist === null) {
          await DB.profitSchedules.incrementCyclesProcessed(fresh._id);
          skipped.push({ scheduleId: fresh._id, cycleNumber, reason: 'No investors hold shares in this project' });
        } else if (dist) {
          await DB.profitSchedules.incrementCyclesProcessed(fresh._id);
          processed.push({ scheduleId: fresh._id, cycleNumber, distribution: dist });
        } else {
          errors.push({ scheduleId: fresh._id, cycleNumber, message: 'Cycle could not be credited' });
        }
      }
    } catch (err) {
      console.error(`processDueCycles failed for schedule ${schedule._id}:`, err.message);
      errors.push({ scheduleId: schedule._id, message: err.message });
    }
  }
  return { processed, skipped, errors };
};

/** Single-flight: multiple API calls in one page load share one processDueCycles run. */
let dueCyclesInFlight = null;
const processDueCyclesOnce = async (options = {}) => {
  if (!dueCyclesInFlight) {
    dueCyclesInFlight = processDueCycles(options).finally(() => {
      dueCyclesInFlight = null;
    });
  }
  return dueCyclesInFlight;
};

/** Never lets scheduled-profit processing break a read request. */
const processDueCyclesSafe = async (options = {}) => {
  try {
    return await processDueCyclesOnce(options);
  } catch (err) {
    console.error('processDueCycles crashed:', err.message);
    return { processed: [], skipped: [], errors: [{ message: err.message }] };
  }
};

module.exports = {
  CYCLE_DAYS,
  BD_TIMEZONE,
  getTodayDateStr,
  getDueCycleNumbers,
  getCompletedCycleCount,
  getCyclePeriod,
  isCycleDue,
  getNextDueDate,
  getNextPeriodStart,
  enrichSchedule,
  processDueCycles,
  processDueCyclesOnce,
  processDueCyclesSafe
};
