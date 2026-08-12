/**
 * Idempotent maturity demo seed — safe to re-run.
 * Creates NEW maturity-enabled investments only; never mutates legacy investments.
 *
 * Usage: node backend/scripts/seed-maturity-demo.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const DB = require('../db');
const bcrypt = require('bcrypt');
const { initMaturityFields, getMaturityCyclePeriod } = require('../services/maturityService');
const { getTodayDateStr, parseDateOnly, dateToIsoDate, addCalendarMonths } = require('../services/profitScheduleService');

const DEMO_TAG = 'maturity-demo';
let sharedPasswordHash = null;

const addDays = (dateStr, days) => {
  const d = parseDateOnly(dateStr);
  d.setDate(d.getDate() + days);
  return dateToIsoDate(d);
};

async function ensureInvestor(email, name) {
  let user = await DB.users.findOne({ email });
  if (user) return user;
  if (!sharedPasswordHash) {
    // Hash once for all demo users — bcrypt per user is the usual seed bottleneck.
    sharedPasswordHash = await bcrypt.hash('password123', Number(process.env.BCRYPT_ROUNDS) || 8);
  }
  user = await DB.users.create({
    name,
    email,
    passwordHash: sharedPasswordHash,
    role: 'investor',
    phone: '01700000000'
  });
  console.log('Created investor', email);
  return user;
}

async function ensureProject(title) {
  const projects = await DB.projects.find({});
  let project = projects.find((p) => p.title === title);
  if (project) return project;
  project = await DB.projects.create({
    title,
    category: 'Demo',
    description: 'Maturity demo project',
    sharePrice: 25000,
    targetAmount: 1000000,
    status: 'open'
  });
  console.log('Created project', title);
  return project;
}

async function ensureSchedule(projectId, cycleType, profitPerShare, startDate) {
  const existing = (await DB.profitSchedules.find({ projectId, status: 'active' }))
    .find((s) => s.cycleType === cycleType);
  if (existing) return existing;
  return DB.profitSchedules.create({
    projectId,
    cycleType,
    profitPerShare,
    startDate,
    status: 'active',
    cyclesProcessed: 0,
    createdBy: 'seed'
  });
}

async function upsertDemoInvestment(key, payload) {
  const all = await DB.investments.find({});
  const existing = all.find((i) => i.notes === `${DEMO_TAG}:${key}`);
  if (existing) {
    console.log('Skip existing demo investment', key, existing._id);
    return existing;
  }
  const maturityFields = initMaturityFields(payload);
  const created = await DB.investments.create({
    ...payload,
    ...maturityFields,
    notes: `${DEMO_TAG}:${key}`,
    profitNotAssigned: true
  });
  console.log('Created demo investment', key, created._id, {
    type: created.maturityType,
    start: created.maturityStartDate,
    next: created.nextMaturityDate
  });
  return created;
}

async function main() {
  await DB.initDb();
  const today = getTodayDateStr();
  console.log('Seeding maturity demos as of', today);

  const weeklyInvestor = await ensureInvestor('maturity.weekly@startupboxbd.com', 'Maturity Weekly Demo');
  const monthlyInvestor = await ensureInvestor('maturity.monthly@startupboxbd.com', 'Maturity Monthly Demo');
  const multiInvestor = await ensureInvestor('maturity.multi@startupboxbd.com', 'Maturity Multi Demo');
  const paidInvestor = await ensureInvestor('maturity.paid@startupboxbd.com', 'Maturity Paid Demo');

  const projectA = await ensureProject('Maturity Demo Alpha');
  const projectB = await ensureProject('Maturity Demo Beta');
  const projectC = await ensureProject('Maturity Demo Custom');

  await ensureSchedule(projectA._id, 'weekly', 367, '2026-08-03');
  await ensureSchedule(projectB._id, 'monthly', 500, '2026-08-03');

  // Weekly matured: start 8 days ago → cycle 1 ended yesterday or earlier
  const weeklyStart = addDays(today, -8);
  await upsertDemoInvestment('weekly-matured', {
    investorId: weeklyInvestor._id,
    projectId: projectA._id,
    amount: 100000,
    sharesCount: 4,
    maturityEnabled: true,
    maturityType: 'weekly',
    maturityStartDate: weeklyStart,
    startDate: weeklyStart,
    profitPerShareOverride: 367,
    recurringMaturity: true
  });

  // Weekly upcoming: start today → matures in 6 days
  await upsertDemoInvestment('weekly-upcoming', {
    investorId: weeklyInvestor._id,
    projectId: projectA._id,
    amount: 50000,
    sharesCount: 2,
    maturityEnabled: true,
    maturityType: 'weekly',
    maturityStartDate: today,
    startDate: today,
    profitPerShareOverride: 367,
    recurringMaturity: true
  });

  // Monthly matured: start ~35 days ago → first maturity ~5 days ago
  const monthlyStart = addDays(today, -35);
  await upsertDemoInvestment('monthly-matured', {
    investorId: monthlyInvestor._id,
    projectId: projectB._id,
    amount: 100000,
    sharesCount: 10,
    maturityEnabled: true,
    maturityType: 'monthly',
    maturityStartDate: monthlyStart,
    startDate: monthlyStart,
    profitPerShareOverride: 500,
    recurringMaturity: true
  });

  // Monthly upcoming: start 10 days ago → matures in ~20 days
  const monthlyUpcomingStart = addDays(today, -10);
  await upsertDemoInvestment('monthly-upcoming', {
    investorId: monthlyInvestor._id,
    projectId: projectB._id,
    amount: 75000,
    sharesCount: 5,
    maturityEnabled: true,
    maturityType: 'monthly',
    maturityStartDate: monthlyUpcomingStart,
    startDate: monthlyUpcomingStart,
    profitPerShareOverride: 500,
    recurringMaturity: true
  });

  // Custom matured
  await upsertDemoInvestment('custom-matured', {
    investorId: multiInvestor._id,
    projectId: projectC._id,
    amount: 200000,
    sharesCount: 8,
    maturityEnabled: true,
    maturityType: 'custom',
    maturityStartDate: addDays(today, -20),
    startDate: addDays(today, -20),
    customMaturityDate: addDays(today, -1),
    recurringMaturity: false,
    includePrincipalOnPayoff: true,
    profitPerShareOverride: 350
  });

  // Multi investments for one investor
  await upsertDemoInvestment('multi-weekly', {
    investorId: multiInvestor._id,
    projectId: projectA._id,
    amount: 100000,
    sharesCount: 4,
    maturityEnabled: true,
    maturityType: 'weekly',
    maturityStartDate: weeklyStart,
    startDate: weeklyStart,
    profitPerShareOverride: 367
  });
  await upsertDemoInvestment('multi-monthly', {
    investorId: multiInvestor._id,
    projectId: projectB._id,
    amount: 100000,
    sharesCount: 10,
    maturityEnabled: true,
    maturityType: 'monthly',
    maturityStartDate: monthlyStart,
    startDate: monthlyStart,
    profitPerShareOverride: 500
  });

  // Already-paid: create matured then payoff once
  const paidInv = await upsertDemoInvestment('already-paid', {
    investorId: paidInvestor._id,
    projectId: projectA._id,
    amount: 55000,
    sharesCount: 22,
    maturityEnabled: true,
    maturityType: 'weekly',
    maturityStartDate: weeklyStart,
    startDate: weeklyStart,
    profitPerShareOverride: 350,
    recurringMaturity: true
  });

  const existingPayoff = await DB.maturityPayoffs.findOne({
    investmentId: paidInv._id,
    cycleNumber: 1
  });
  if (!existingPayoff && (paidInv.maturityCyclesPaid || 0) === 0) {
    const { payOffMaturity } = require('../services/maturityService');
    const admin = (await DB.users.find({ role: 'admin' }))[0];
    try {
      await payOffMaturity({
        investmentId: paidInv._id,
        adminId: admin?._id || 'seed-admin',
        paymentMethod: 'bKash',
        referenceNo: 'SEED-PAID-001',
        notes: 'Seed already-paid cycle',
        includePrincipal: false
      });
      console.log('Paid seed investment cycle 1');
    } catch (err) {
      console.log('Payoff seed skipped:', err.message);
    }
  } else {
    console.log('Skip already-paid payoff (exists)');
  }

  // 22 shares × 350 check helper log
  const period = getMaturityCyclePeriod({
    maturityType: 'weekly',
    maturityStartDate: '2026-08-03'
  }, 1);
  console.log('Sanity weekly cycle1', period, '22×350=', 22 * 350);

  console.log('Maturity demo seed complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
