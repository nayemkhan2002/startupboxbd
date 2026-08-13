/**
 * Admin-only audit endpoints for investor data integrity verification.
 *
 * GET /api/admin/audit/investors   — per-investor audit report
 * GET /api/admin/audit/integrity   — database integrity check
 */
const express = require('express');
const router = express.Router();
const DB = require('../db');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');
const { getInvestorDashboardBundle, buildProjectBreakdown } = require('../services/profitCalculationService');
const {
  User, Investment, ProfitSchedule, InvestorProfitLedger,
  ProfitDistribution, Wallet, Payout, Withdrawal, Project, MaturityPayoff
} = require('../db/models');

// ── Per-investor audit ──────────────────────────────────────────
router.get('/audit/investors', protect, adminOnly, async (req, res) => {
  try {
    const startMs = Date.now();

    // Batch-fetch all data upfront to avoid N+1
    const [allInvestors, allInvestments, allLedger, allWallets, allWithdrawals, allPayouts, allMaturityPayoffs] =
      await Promise.all([
        User.find({ role: 'investor' }).lean(),
        Investment.find({}).lean(),
        InvestorProfitLedger.find({}).lean(),
        Wallet.find({}).lean(),
        Withdrawal.find({}).lean(),
        Payout.find({}).lean(),
        MaturityPayoff.find({ status: 'PAID' }).lean()
      ]);

    // Build lookup maps
    const investmentsByInvestor = new Map();
    for (const inv of allInvestments) {
      if (!investmentsByInvestor.has(inv.investorId)) investmentsByInvestor.set(inv.investorId, []);
      investmentsByInvestor.get(inv.investorId).push(inv);
    }
    const ledgerByInvestor = new Map();
    for (const e of allLedger) {
      if (!ledgerByInvestor.has(e.investorId)) ledgerByInvestor.set(e.investorId, []);
      ledgerByInvestor.get(e.investorId).push(e);
    }
    const walletByInvestor = new Map();
    for (const w of allWallets) walletByInvestor.set(w.investorId, w);
    const withdrawalsByInvestor = new Map();
    for (const w of allWithdrawals) {
      if (!withdrawalsByInvestor.has(w.investorId)) withdrawalsByInvestor.set(w.investorId, []);
      withdrawalsByInvestor.get(w.investorId).push(w);
    }
    const payoutsByInvestor = new Map();
    for (const p of allPayouts) {
      if (!payoutsByInvestor.has(p.investorId)) payoutsByInvestor.set(p.investorId, []);
      payoutsByInvestor.get(p.investorId).push(p);
    }
    const maturityByInvestor = new Map();
    for (const m of allMaturityPayoffs) {
      if (!maturityByInvestor.has(m.investorId)) maturityByInvestor.set(m.investorId, []);
      maturityByInvestor.get(m.investorId).push(m);
    }

    const report = [];
    let healthy = 0;
    let warnings = 0;
    let critical = 0;

    for (const investor of allInvestors) {
      const id = investor._id;
      const investments = investmentsByInvestor.get(id) || [];
      const ledger = ledgerByInvestor.get(id) || [];
      const wallet = walletByInvestor.get(id) || null;
      const withdrawals = withdrawalsByInvestor.get(id) || [];
      const payouts = payoutsByInvestor.get(id) || [];
      const maturityPayoffs = maturityByInvestor.get(id) || [];

      // Database calculations
      const activeInvestments = investments.filter(i => i.status === 'active');
      const validInvestments = investments.filter(i => ['active', 'completed', 'pending'].includes(i.status));
      const dbTotalInvested = validInvestments.reduce((s, i) => s + (Number(i.amount) || 0), 0);
      const dbTotalShares = investments
        .filter(i => ['active', 'completed'].includes(i.status))
        .reduce((s, i) => s + (Number(i.sharesCount) || 0), 0);
      const dbReturnEarned = investments.reduce((s, i) => s + (Number(i.returnEarned) || 0), 0);
      const dbLedgerProfit = ledger.reduce((s, e) => s + (Number(e.calculatedProfit) || 0), 0);
      const dbMaturityProfit = maturityPayoffs.reduce((s, m) => s + (Number(m.profitAmount) || 0), 0);
      const dbTotalProfit = Math.max(dbReturnEarned, dbLedgerProfit, dbMaturityProfit);
      const dbWalletBalance = wallet ? Number(wallet.availableBalance) || 0 : 0;
      const dbPendingWithdrawals = withdrawals
        .filter(w => ['pending', 'approved', 'processing'].includes(w.status))
        .reduce((s, w) => s + (Number(w.amount) || 0), 0);
      const dbCompletedWithdrawals = withdrawals
        .filter(w => w.status === 'completed')
        .reduce((s, w) => s + (Number(w.amount) || 0), 0);

      // Dashboard API calculations (via the actual service)
      let dashStats = null;
      let dashError = null;
      try {
        const stats = await DB.investments.getPortfolioStats(id);
        dashStats = stats;
      } catch (err) {
        dashError = err.message;
      }

      // Compare
      const issues = [];

      if (dashStats) {
        if (dbTotalInvested !== dashStats.totalInvested) {
          issues.push(`Investment amount mismatch: DB=৳${dbTotalInvested} vs API=৳${dashStats.totalInvested}`);
        }
        if (dbTotalShares !== dashStats.totalShares) {
          issues.push(`Shares mismatch: DB=${dbTotalShares} vs API=${dashStats.totalShares}`);
        }
        if (Math.abs(dbTotalProfit - dashStats.totalReturnEarned) > 1) {
          issues.push(`Profit mismatch: DB=৳${dbTotalProfit} vs API=৳${dashStats.totalReturnEarned}`);
        }
      }
      if (dashError) {
        issues.push(`Dashboard API error: ${dashError}`);
      }

      // Check for investments with no project
      const projectIds = new Set(investments.map(i => i.projectId).filter(Boolean));
      // investmentsByProject orphan check is done in integrity endpoint

      // Determine status
      let status;
      if (dashError) {
        status = 'CRITICAL';
        critical++;
      } else if (issues.length > 0) {
        status = 'WARNING';
        warnings++;
      } else {
        status = 'OK';
        healthy++;
      }

      report.push({
        investorId: id,
        name: investor.name,
        email: investor.email,
        accountStatus: investor.accountStatus || 'active',
        investmentCount: investments.length,
        db: {
          totalInvested: dbTotalInvested,
          totalShares: dbTotalShares,
          activeInvestments: activeInvestments.length,
          returnEarned: dbReturnEarned,
          ledgerProfit: dbLedgerProfit,
          maturityProfit: dbMaturityProfit,
          totalProfit: dbTotalProfit,
          walletBalance: dbWalletBalance,
          pendingWithdrawals: dbPendingWithdrawals,
          completedWithdrawals: dbCompletedWithdrawals,
          projectsCount: projectIds.size,
          ledgerEntries: ledger.length,
          payoutCount: payouts.length,
        },
        dashboard: dashStats ? {
          totalInvested: dashStats.totalInvested,
          totalShares: dashStats.totalShares,
          activeInvestments: dashStats.activeInvestments,
          totalReturnEarned: dashStats.totalReturnEarned,
          availableBalance: dashStats.availableBalance,
          pendingWithdrawals: dashStats.pendingWithdrawals,
        } : null,
        issues,
        status,
      });
    }

    res.json({
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      summary: {
        totalInvestors: allInvestors.length,
        healthy,
        warnings,
        critical,
      },
      investors: report,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Database integrity check ────────────────────────────────────
router.get('/audit/integrity', protect, adminOnly, async (req, res) => {
  try {
    const startMs = Date.now();

    const [allInvestments, allLedger, allWallets, allUsers, allProjects,
           allDistributions, allPayouts, allWithdrawals, allMaturityPayoffs] =
      await Promise.all([
        Investment.find({}).lean(),
        InvestorProfitLedger.find({}).lean(),
        Wallet.find({}).lean(),
        User.find({}).lean(),
        Project.find({}).lean(),
        ProfitDistribution.find({}).lean(),
        Payout.find({}).lean(),
        Withdrawal.find({}).lean(),
        MaturityPayoff.find({}).lean()
      ]);

    const userIds = new Set(allUsers.map(u => u._id));
    const investorIds = new Set(allUsers.filter(u => u.role === 'investor').map(u => u._id));
    const projectIds = new Set(allProjects.map(p => p._id));
    const investmentIds = new Set(allInvestments.map(i => i._id));

    const anomalies = [];

    // Investments with no valid investor
    const orphanedInvestments = allInvestments.filter(i => !userIds.has(i.investorId));
    if (orphanedInvestments.length) {
      anomalies.push({
        type: 'ORPHANED_INVESTMENT',
        severity: 'CRITICAL',
        count: orphanedInvestments.length,
        details: orphanedInvestments.map(i => ({
          investmentId: i._id, investorId: i.investorId, amount: i.amount
        }))
      });
    }

    // Investments with no valid project
    const noProjectInvestments = allInvestments.filter(i => i.projectId && !projectIds.has(i.projectId));
    if (noProjectInvestments.length) {
      anomalies.push({
        type: 'INVESTMENT_NO_PROJECT',
        severity: 'WARNING',
        count: noProjectInvestments.length,
        details: noProjectInvestments.map(i => ({
          investmentId: i._id, projectId: i.projectId, investorId: i.investorId
        }))
      });
    }

    // Profit records with no valid investor
    const orphanedLedger = allLedger.filter(e => !userIds.has(e.investorId));
    if (orphanedLedger.length) {
      anomalies.push({
        type: 'ORPHANED_LEDGER',
        severity: 'CRITICAL',
        count: orphanedLedger.length,
        details: orphanedLedger.slice(0, 10).map(e => ({
          ledgerId: e._id, investorId: e.investorId, amount: e.calculatedProfit
        }))
      });
    }

    // Profit records with no valid investment
    const orphanedLedgerInv = allLedger.filter(e => e.investmentId && !investmentIds.has(e.investmentId));
    if (orphanedLedgerInv.length) {
      anomalies.push({
        type: 'LEDGER_NO_INVESTMENT',
        severity: 'WARNING',
        count: orphanedLedgerInv.length,
        details: orphanedLedgerInv.slice(0, 10).map(e => ({
          ledgerId: e._id, investmentId: e.investmentId
        }))
      });
    }

    // Wallets with no valid investor
    const orphanedWallets = allWallets.filter(w => !userIds.has(w.investorId));
    if (orphanedWallets.length) {
      anomalies.push({
        type: 'ORPHANED_WALLET',
        severity: 'WARNING',
        count: orphanedWallets.length,
        details: orphanedWallets.map(w => ({
          walletId: w._id, investorId: w.investorId, balance: w.availableBalance
        }))
      });
    }

    // Duplicate investments (same investor + project + amount — potential duplicates)
    const invKeys = new Map();
    for (const inv of allInvestments) {
      const key = `${inv.investorId}_${inv.projectId}_${inv.amount}`;
      if (!invKeys.has(key)) invKeys.set(key, []);
      invKeys.get(key).push(inv._id);
    }
    const duplicateInvestments = [...invKeys.entries()]
      .filter(([_, ids]) => ids.length > 1)
      .map(([key, ids]) => ({ key, ids, count: ids.length }));
    if (duplicateInvestments.length) {
      anomalies.push({
        type: 'POTENTIAL_DUPLICATE_INVESTMENTS',
        severity: 'WARNING',
        count: duplicateInvestments.length,
        details: duplicateInvestments
      });
    }

    // Negative amounts
    const negativeInvestments = allInvestments.filter(i => (Number(i.amount) || 0) < 0);
    if (negativeInvestments.length) {
      anomalies.push({
        type: 'NEGATIVE_INVESTMENT_AMOUNT',
        severity: 'CRITICAL',
        count: negativeInvestments.length,
        details: negativeInvestments.map(i => ({ investmentId: i._id, amount: i.amount }))
      });
    }

    // Negative shares
    const negativeShares = allInvestments.filter(i => (Number(i.sharesCount) || 0) < 0);
    if (negativeShares.length) {
      anomalies.push({
        type: 'NEGATIVE_SHARES',
        severity: 'CRITICAL',
        count: negativeShares.length,
        details: negativeShares.map(i => ({ investmentId: i._id, shares: i.sharesCount }))
      });
    }

    // Negative wallet balance (if not permitted)
    const negativeWallets = allWallets.filter(w => (Number(w.availableBalance) || 0) < 0);
    if (negativeWallets.length) {
      anomalies.push({
        type: 'NEGATIVE_WALLET_BALANCE',
        severity: 'CRITICAL',
        count: negativeWallets.length,
        details: negativeWallets.map(w => ({
          walletId: w._id, investorId: w.investorId, balance: w.availableBalance
        }))
      });
    }

    // Maturity records pointing to deleted investments
    const orphanedMaturity = allMaturityPayoffs.filter(m => !investmentIds.has(m.investmentId));
    if (orphanedMaturity.length) {
      anomalies.push({
        type: 'ORPHANED_MATURITY_PAYOFF',
        severity: 'WARNING',
        count: orphanedMaturity.length,
        details: orphanedMaturity.slice(0, 10).map(m => ({
          payoffId: m._id, investmentId: m.investmentId
        }))
      });
    }

    // Investors with investments but no wallet
    const investorIdsWithInvestments = new Set(allInvestments.map(i => i.investorId));
    const walletInvestorIds = new Set(allWallets.map(w => w.investorId));
    const noWalletInvestors = [...investorIdsWithInvestments].filter(
      id => investorIds.has(id) && !walletInvestorIds.has(id)
    );
    if (noWalletInvestors.length) {
      anomalies.push({
        type: 'INVESTOR_NO_WALLET',
        severity: 'WARNING',
        count: noWalletInvestors.length,
        details: noWalletInvestors.map(id => ({ investorId: id }))
      });
    }

    res.json({
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      counts: {
        users: allUsers.length,
        investors: investorIds.size,
        projects: allProjects.length,
        investments: allInvestments.length,
        ledgerEntries: allLedger.length,
        wallets: allWallets.length,
        distributions: allDistributions.length,
        payouts: allPayouts.length,
        withdrawals: allWithdrawals.length,
        maturityPayoffs: allMaturityPayoffs.length,
      },
      anomalies,
      summary: {
        totalAnomalies: anomalies.length,
        critical: anomalies.filter(a => a.severity === 'CRITICAL').length,
        warnings: anomalies.filter(a => a.severity === 'WARNING').length,
        status: anomalies.some(a => a.severity === 'CRITICAL') ? 'CRITICAL'
          : anomalies.length > 0 ? 'WARNING' : 'HEALTHY'
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
