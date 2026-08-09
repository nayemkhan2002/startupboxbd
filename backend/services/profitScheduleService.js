const DB = require('../db');

const CYCLE_DAYS = { weekly: 7, monthly: 30 };

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

const getCycleDays = (cycleType) => CYCLE_DAYS[cycleType] || 7;

const getDueCycleNumbers = (schedule, asOf = new Date()) => {
  if (schedule.status !== 'active') return [];
  const start = parseDateOnly(schedule.startDate);
  const cycleDays = getCycleDays(schedule.cycleType);
  const today = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const daysSince = Math.floor((today - startDay) / 86400000);
  if (daysSince < cycleDays) return [];

  const totalCompleted = Math.floor(daysSince / cycleDays);
  const alreadyDone = schedule.cyclesProcessed || 0;
  const due = [];
  for (let c = alreadyDone + 1; c <= totalCompleted; c++) due.push(c);
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
  for (const schedule of schedules) {
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
      processed.push({ scheduleId: fresh._id, cycleNumber, distribution: dist });
    }
  }
  return processed;
};

module.exports = {
  CYCLE_DAYS,
  getDueCycleNumbers,
  getCyclePeriod,
  getNextDueDate,
  enrichSchedule,
  processDueCycles
};
