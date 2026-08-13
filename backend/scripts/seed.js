#!/usr/bin/env node
/**
 * Comprehensive idempotent seed — safe to re-run.
 *
 *   npm run seed              (default — dev only)
 *   npm run seed -- --force   (skip NODE_ENV guard)
 *
 * Creates:
 *   - 5 realistic test investors
 *   - 3 test projects
 *   - Investments linking investors → projects with correct shares
 *   - Profit schedules per project
 *   - Processes due cycles → credits profit ledger + wallets
 *
 * Works on both MongoDB Atlas and JSON file store via DB abstraction.
 * Idempotent: uses deterministic IDs prefixed 'seed_'.
 * Re-running updates existing records; never creates duplicates.
 */
const path = require('path');
const dns = require('dns');

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (_) {}

require('dotenv').config({ path: path.join(__dirname, '../../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const bcrypt = require('bcrypt');
const DB = require('../db');

// ── Safety guard ──
const FORCE = process.argv.includes('--force');
if (process.env.NODE_ENV === 'production' && !FORCE) {
  console.error('❌  Refusing to seed in production. Use --force to override.');
  process.exit(1);
}

// ── Deterministic seed IDs ──
const IDS = {
  investorA: 'seed_investor_a',
  investorB: 'seed_investor_b',
  investorC: 'seed_investor_c',
  investorD: 'seed_investor_d',
  investorE: 'seed_investor_e',

  projectAlpha: 'seed_project_alpha',
  projectBeta: 'seed_project_beta',
  projectGamma: 'seed_project_gamma',

  scheduleAlpha: 'seed_schedule_alpha',
  scheduleBeta: 'seed_schedule_beta',
  scheduleGamma: 'seed_schedule_gamma',

  inv_a_alpha: 'seed_inv_a_alpha',
  inv_a_beta: 'seed_inv_a_beta',
  inv_b_alpha: 'seed_inv_b_alpha',
  inv_b_gamma: 'seed_inv_b_gamma',
  inv_c_alpha: 'seed_inv_c_alpha',
  inv_c_beta: 'seed_inv_c_beta',
  inv_c_gamma: 'seed_inv_c_gamma',
  inv_d_beta: 'seed_inv_d_beta',
  inv_e_alpha: 'seed_inv_e_alpha',
};

const timer = (label) => {
  const start = Date.now();
  return () => {
    const ms = Date.now() - start;
    console.log(`  ⏱  ${label}: ${ms}ms`);
    return ms;
  };
};

async function main() {
  const totalTimer = timer('Total seed');

  // ── 1. Connect / Init DB ──
  const t1 = timer('Database init');
  try {
    await DB.initDb();
  } catch (err) {
    if (err.name === 'MongooseServerSelectionError' || err.message.includes('MongoDB Atlas')) {
      console.warn('  ⚠ MongoDB Atlas unreachable (IP whitelist/offline). Falling back to local JSON store.');
      process.env.USE_JSON_DB = 'true';
      // Re-require backend selector with USE_JSON_DB = true
      delete require.cache[require.resolve('../db')];
      delete require.cache[require.resolve('../db/index')];
      delete require.cache[require.resolve('../db/jsonDb')];
      const fallbackDB = require('../db');
      Object.assign(DB, fallbackDB);
      await DB.initDb();
    } else {
      throw err;
    }
  }
  t1();

  // ── 2. Hash password ONCE ──
  const t2 = timer('Password hash');
  const passwordHash = await bcrypt.hash('password123', Number(process.env.BCRYPT_ROUNDS) || 8);
  t2();

  // ── 3. Upsert investors ──
  const t3 = timer('Create investors');
  const investors = [
    { _id: IDS.investorA, name: 'John Doe', email: 'john@startupboxbd.com', phone: '01711111111' },
    { _id: IDS.investorB, name: 'Alex Rahman', email: 'alex@startupboxbd.com', phone: '01722222222' },
    { _id: IDS.investorC, name: 'Sara Ahmed', email: 'sara@startupboxbd.com', phone: '01733333333' },
    { _id: IDS.investorD, name: 'Karim Hossain', email: 'karim@startupboxbd.com', phone: '01744444444' },
    { _id: IDS.investorE, name: 'Fatema Begum', email: 'fatema@startupboxbd.com', phone: '01755555555' },
  ];

  for (const inv of investors) {
    const existing = await DB.users.findOne({ _id: inv._id });
    if (existing) {
      await DB.users.findByIdAndUpdate(inv._id, {
        name: inv.name,
        email: inv.email,
        password: passwordHash,
        role: 'investor',
        phone: inv.phone
      });
    } else {
      await DB.users.create({
        _id: inv._id,
        name: inv.name,
        email: inv.email,
        password: passwordHash,
        role: 'investor',
        phone: inv.phone,
        address: 'Dhaka, Bangladesh',
        profileImage: '',
        bankInfo: {
          method: 'bkash',
          bkashNumber: inv.phone,
          bkashAccountType: 'Personal',
          bankName: '', accountName: '', accountNumber: '', branch: '', routingNumber: ''
        }
      });
    }
  }
  console.log(`  ✓ ${investors.length} investors upserted`);
  t3();

  // ── 4. Upsert projects ──
  const t4 = timer('Create projects');
  const projects = [
    {
      _id: IDS.projectAlpha,
      title: 'Alpha Poultry Farm',
      category: 'Agriculture / Poultry Farming',
      description: 'Premium quail and poultry farming project with weekly profit distribution.',
      sharePrice: 25000,
      targetAmount: 500000,
      status: 'open',
      riskLevel: 'Low',
      expectedROI: 'Weekly ৳367/share',
      deadline: '2027-07-01',
    },
    {
      _id: IDS.projectBeta,
      title: 'Beta Frozen Foods',
      category: 'Food Industry',
      description: 'Frozen food manufacturing and distribution project.',
      sharePrice: 10000,
      targetAmount: 300000,
      status: 'open',
      riskLevel: 'Medium',
      expectedROI: 'Weekly ৳323/share',
      deadline: '2027-06-01',
    },
    {
      _id: IDS.projectGamma,
      title: 'Gamma Livestock',
      category: 'Farming',
      description: 'Goat rearing and fattening project with monthly returns.',
      sharePrice: 15000,
      targetAmount: 750000,
      status: 'open',
      riskLevel: 'Low',
      expectedROI: 'Monthly ৳500/share',
      deadline: '2027-12-01',
    }
  ];

  for (const p of projects) {
    const existing = await DB.projects.findById(p._id);
    if (existing) {
      await DB.projects.findByIdAndUpdate(p._id, p);
    } else {
      await DB.projects.create(p);
    }
  }
  console.log(`  ✓ ${projects.length} projects upserted`);
  t4();

  // ── 5. Upsert profit schedules ──
  const t5 = timer('Create profit schedules');
  const schedules = [
    { _id: IDS.scheduleAlpha, projectId: IDS.projectAlpha, cycleType: 'weekly', profitPerShare: 367, startDate: '2026-07-27' },
    { _id: IDS.scheduleBeta, projectId: IDS.projectBeta, cycleType: 'weekly', profitPerShare: 323, startDate: '2026-07-27' },
    { _id: IDS.scheduleGamma, projectId: IDS.projectGamma, cycleType: 'monthly', profitPerShare: 500, startDate: '2026-07-01' },
  ];

  for (const s of schedules) {
    const existing = await DB.profitSchedules.findActiveByProject(s.projectId);
    if (!existing) {
      await DB.profitSchedules.create({
        projectId: s.projectId,
        cycleType: s.cycleType,
        profitPerShare: s.profitPerShare,
        startDate: s.startDate,
        status: 'active',
        cyclesProcessed: 0,
        createdBy: 'seed'
      });
    }
  }
  console.log(`  ✓ ${schedules.length} profit schedules upserted`);
  t5();

  // ── 6. Upsert investments ──
  const t6 = timer('Create investments');
  const investmentDefs = [
    // John Doe: 4 shares in Alpha (৳367/share) + 1 share in Beta (৳323/share)
    // Expected total profit per cycle: 4×367 + 1×323 = 1468 + 323 = ৳1,791
    { _id: IDS.inv_a_alpha, investorId: IDS.investorA, projectId: IDS.projectAlpha, amount: 100000, sharesCount: 4, startDate: '2026-08-03' },
    { _id: IDS.inv_a_beta,  investorId: IDS.investorA, projectId: IDS.projectBeta,  amount: 10000,  sharesCount: 1, startDate: '2026-08-03' },

    // Alex: 3 shares in Alpha (৳367/share) + 2 shares in Gamma (৳500/share monthly)
    { _id: IDS.inv_b_alpha, investorId: IDS.investorB, projectId: IDS.projectAlpha, amount: 75000,  sharesCount: 3, startDate: '2026-08-03' },
    { _id: IDS.inv_b_gamma, investorId: IDS.investorB, projectId: IDS.projectGamma, amount: 30000,  sharesCount: 2, startDate: '2026-08-01' },

    // Sara: 2 shares in Alpha + 3 shares in Beta + 1 share in Gamma
    { _id: IDS.inv_c_alpha, investorId: IDS.investorC, projectId: IDS.projectAlpha, amount: 50000,  sharesCount: 2, startDate: '2026-08-03' },
    { _id: IDS.inv_c_beta,  investorId: IDS.investorC, projectId: IDS.projectBeta,  amount: 30000,  sharesCount: 3, startDate: '2026-08-03' },
    { _id: IDS.inv_c_gamma, investorId: IDS.investorC, projectId: IDS.projectGamma, amount: 15000,  sharesCount: 1, startDate: '2026-08-01' },

    // Karim: 5 shares in Beta
    { _id: IDS.inv_d_beta,  investorId: IDS.investorD, projectId: IDS.projectBeta,  amount: 50000,  sharesCount: 5, startDate: '2026-08-03' },

    // Fatema: 1 share in Alpha
    { _id: IDS.inv_e_alpha, investorId: IDS.investorE, projectId: IDS.projectAlpha, amount: 25000,  sharesCount: 1, startDate: '2026-08-03' },
  ];

  for (const inv of investmentDefs) {
    const existing = await DB.investments.findById(inv._id);
    if (existing) {
      await DB.investments.findByIdAndUpdate(inv._id, {
        investorId: inv.investorId,
        projectId: inv.projectId,
        amount: inv.amount,
        sharesCount: inv.sharesCount,
        startDate: inv.startDate,
        status: 'active'
      });
    } else {
      await DB.investments.create({
        _id: inv._id,
        investorId: inv.investorId,
        projectId: inv.projectId,
        amount: inv.amount,
        sharesCount: inv.sharesCount,
        roi: 0,
        duration: 0,
        durationUnit: 'months',
        durationLabel: '',
        startDate: inv.startDate,
        maturityDate: null,
        expectedReturn: 0,
        returnEarned: 0,
        profitNotAssigned: false,
        status: 'active',
        notes: 'seed',
        paymentHistory: [{
          type: 'investment',
          label: 'Initial Investment Allocated',
          amount: inv.amount,
          date: inv.startDate
        }],
        timeline: [
          { key: 'approved', label: 'Investment Approved', date: inv.startDate, done: true },
          { key: 'started',  label: 'Business Started',    date: inv.startDate, done: true },
          { key: 'profit',   label: 'Profit Generated',    date: null, done: false },
          { key: 'completed', label: 'Completed',          date: null, done: false }
        ]
      });
    }
  }
  console.log(`  ✓ ${investmentDefs.length} investments upserted`);
  t6();

  // ── 7. Process due profit cycles ──
  const t7 = timer('Process due cycles');
  const { processDueCycles } = require('../services/profitScheduleService');

  let totalProcessed = 0;
  let totalSkipped = 0;
  for (const s of schedules) {
    try {
      // Look up the actual schedule by projectId (create may have assigned a different _id)
      const actualSchedule = await DB.profitSchedules.findActiveByProject(s.projectId);
      if (!actualSchedule) {
        console.warn(`  ⚠  No active schedule found for project ${s.projectId}`);
        continue;
      }
      const result = await processDueCycles({ adminId: 'seed', scheduleId: actualSchedule._id });
      totalProcessed += (result.processed || []).length;
      totalSkipped += (result.skipped || []).length;
      if (result.errors && result.errors.length) {
        console.warn(`  ⚠  Schedule ${actualSchedule._id} errors:`, result.errors);
      }
    } catch (err) {
      console.warn(`  ⚠  Schedule for project ${s.projectId} process failed:`, err.message);
    }
  }
  console.log(`  ✓ Processed ${totalProcessed} cycles, skipped ${totalSkipped}`);
  t7();

  // ── 8. Ensure wallets exist ──
  const t8 = timer('Ensure wallets');
  for (const inv of investors) {
    await DB.wallets.getOrCreate(inv._id);
  }
  console.log(`  ✓ ${investors.length} wallets ensured`);
  t8();

  // ── 9. Verification ──
  const t9 = timer('Verification');
  console.log('\n── Verification ──');

  for (const inv of investors) {
    const stats = await DB.investments.getPortfolioStats(inv._id);
    const wallet = await DB.wallets.getByInvestorId(inv._id);
    const ledger = await DB.distributions.getInvestorLedger(inv._id);
    const ledgerTotal = (ledger || []).reduce((s, e) => s + (Number(e.calculatedProfit) || 0), 0);

    console.log(`\n  📊 ${inv.name} (${inv._id}):`);
    console.log(`     Investments: ${stats.investmentCount} | Active: ${stats.activeInvestments}`);
    console.log(`     Total Invested: ৳${stats.totalInvested.toLocaleString()}`);
    console.log(`     Total Shares: ${stats.totalShares}`);
    console.log(`     Return Earned (stats): ৳${stats.totalReturnEarned.toLocaleString()}`);
    console.log(`     Ledger Profit: ৳${ledgerTotal.toLocaleString()}`);
    console.log(`     Wallet Balance: ৳${(wallet?.availableBalance || 0).toLocaleString()}`);
  }

  // Test case check
  const johnStats = await DB.investments.getPortfolioStats(IDS.investorA);
  const johnLedger = await DB.distributions.getInvestorLedger(IDS.investorA);
  const johnLedgerTotal = (johnLedger || []).reduce((s, e) => s + (Number(e.calculatedProfit) || 0), 0);
  const expectedPerCycle = (4 * 367) + (1 * 323); // 1791

  console.log(`\n── Test Case: John Doe ──`);
  console.log(`  Expected per weekly cycle: 4×367 + 1×323 = ৳${expectedPerCycle.toLocaleString()}`);
  console.log(`  Actual ledger total: ৳${johnLedgerTotal.toLocaleString()}`);
  console.log(`  Portfolio totalReturnEarned: ৳${johnStats.totalReturnEarned.toLocaleString()}`);
  console.log(`  Total Invested: ৳${johnStats.totalInvested.toLocaleString()}`);
  console.log(`  Total Shares: ${johnStats.totalShares}`);
  t9();

  const totalMs = totalTimer();
  console.log(`\n✅ Seed complete in ${totalMs}ms`);

  if (require.main === module) {
    process.exit(0);
  }
}

main().catch(err => {
  console.error('❌ Seed failed:', err);
  if (require.main === module) {
    process.exit(1);
  }
});

module.exports = { main, IDS };
