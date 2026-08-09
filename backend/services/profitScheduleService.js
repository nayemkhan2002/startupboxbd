const DB = require('../db');

const CYCLE_DAYS = { weekly: 7, monthly: 30 };
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

/** Today as YYYY-MM-DD in Bangladesh (UTC+6) — matches how admins set schedule dates */
const getTodayDateStr = (asOf = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: BD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(asOf);

const getCycleDays = (cycleType) => CYCLE_DAYS[cycleType] || 7;

const getDueCycleNumbers = (schedule, asOf = new Date()) => {
  if (schedule.status !== 'active') return [];
  const todayStr = getTodayDateStr(asOf);
  const alreadyDone = schedule.cyclesProcessed || 0;
  const due = [];
  let cycle = alreadyDone + 1;

  while (cycle <= alreadyDone + 52) {
    const { periodEnd } = getCyclePeriod(schedule, cycle);
    if (todayStr < periodEnd) break;
    due.push(cycle);
    cycle += 1;
  }
  return due;
};

const getCyclePeriod = (schedule, cycleNumber) => {
  const start = parseDateOnly(schedule.startDate);
  const cycleDays = getCycleDays(schedule.cycleType);
  const periodStart = new Date(start);
  periodStart.setDate(periodStart.getDate() + (cycleNumber - 1) * cycleDays);
  const periodEnd = new Date(periodStart);
  periodEnd.setDate(periodEnd.getDate() + cycleDays);
  return { periodStart: dateToIsoDate(periodStart), periodEnd: dateToIsoDate(periodEnd) };
};

const getNextDueDate = (schedule) => {
  const nextCycle = (schedule.cyclesProcessed || 0) + 1;
  return getCyclePeriod(schedule, nextCycle).periodEnd;
};

const enrichSchedule = async (schedule) => {
  const project = await DB.projects.findById(schedule.projectId);
  const dueCycles = getDueCycleNumbers(schedule);
  const nextDueDate = schedule.status === 'active' ? getNextDueDate(schedule) : null;
  return {
    ...schedule,
    project: project ? { _id: project._id, title: project.title, category: project.category } : null,
    cycleDays: getCycleDays(schedule.cycleType),
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
        await DB.profitSchedules.incrementCyclesProcessed(fresh._id);

        if (dist) {
          processed.push({ scheduleId: fresh._id, cycleNumber, distribution: dist });
        } else {
          skipped.push({ scheduleId: fresh._id, cycleNumber, reason: 'No investors hold shares in this project' });
        }
      }
    } catch (err) {
      console.error(`processDueCycles failed for schedule ${schedule._id}:`, err.message);
      errors.push({ scheduleId: schedule._id, message: err.message });
    }
  }
  return { processed, skipped, errors };
};

/** Never lets scheduled-profit processing break a read request. */
const processDueCyclesSafe = async (options = {}) => {
  try {
    return await processDueCycles(options);
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
  getCyclePeriod,
  getNextDueDate,
  enrichSchedule,
  processDueCycles,
  processDueCyclesSafe
};
