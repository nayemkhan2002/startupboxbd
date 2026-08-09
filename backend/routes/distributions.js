const express = require('express');
const router = express.Router();
const DB = require('../db');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');
const {
  enrichSchedule,
  processDueCycles,
  processDueCyclesSafe,
  getDueCycleNumbers,
  getNextDueDate,
  CYCLE_DAYS
} = require('../services/profitScheduleService');

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// Process all due scheduled profit cycles (admin)
router.post('/process-due', protect, adminOnly, async (req, res) => {
  try {
    const adminId = req.user.role === 'admin' ? req.user._id : 'system';
    const result = await processDueCycles({
      adminId,
      scheduleId: req.body.scheduleId || null
    });
    res.json({
      processed: result.processed.length,
      skipped: result.skipped.length,
      items: result.processed,
      errors: result.errors
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: list profit schedules
router.get('/schedules', protect, adminOnly, async (req, res) => {
  try {
    const query = {};
    if (req.query.status) query.status = req.query.status;
    if (req.query.projectId) query.projectId = req.query.projectId;
    const schedules = await DB.profitSchedules.find(query);
    const enriched = await Promise.all(schedules.map(enrichSchedule));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: create recurring profit schedule
router.post('/schedules', protect, adminOnly, async (req, res) => {
  try {
    const { projectId, cycleType, profitPerShare, startDate } = req.body;
    if (!projectId) return res.status(400).json({ message: 'Project is required' });
    if (!startDate) return res.status(400).json({ message: 'Start date is required' });
    const pps = Number(profitPerShare);
    if (!pps || pps <= 0) return res.status(400).json({ message: 'Profit per share must be greater than zero' });
    if (!['weekly', 'monthly'].includes(cycleType)) {
      return res.status(400).json({ message: 'Cycle type must be weekly or monthly' });
    }

    const project = await DB.projects.findById(projectId);
    if (!project) return res.status(400).json({ message: 'Invalid project' });

    const schedule = await DB.profitSchedules.create({
      projectId,
      cycleType,
      profitPerShare: pps,
      startDate,
      createdBy: req.user._id
    });

    const enriched = await enrichSchedule(schedule);
    res.status(201).json(enriched);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Admin: pause or resume schedule
router.put('/schedules/:id/status', protect, adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'paused'].includes(status)) {
      return res.status(400).json({ message: 'Status must be active or paused' });
    }
    const updated = await DB.profitSchedules.updateStatus(req.params.id, status);
    if (!updated) return res.status(404).json({ message: 'Schedule not found' });
    res.json(await enrichSchedule(updated));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Preview distribution (no DB write)
router.post('/preview', protect, adminOnly, async (req, res) => {
  try {
    const { projectId, profitPerShare } = req.body;
    if (!projectId) return res.status(400).json({ message: 'Project is required' });
    const pps = Number(profitPerShare);
    if (!pps || pps <= 0) return res.status(400).json({ message: 'Profit per share must be greater than zero' });

    const project = await DB.projects.findById(projectId);
    if (!project) return res.status(400).json({ message: 'Invalid project' });

    const preview = await DB.distributions.preview(projectId, pps);
    res.json({ ...preview, project: { _id: project._id, title: project.title } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Confirm distribution (transactional)
router.post('/confirm', protect, adminOnly, async (req, res) => {
  try {
    const { projectId, profitPerShare, month, year, distributionDate } = req.body;
    if (!projectId) return res.status(400).json({ message: 'Project is required' });

    const pps = Number(profitPerShare);
    if (!pps || pps <= 0) return res.status(400).json({ message: 'Profit per share must be greater than zero' });

    const m = Number(month);
    const y = Number(year);
    if (!m || m < 1 || m > 12) return res.status(400).json({ message: 'Month must be between 1 and 12' });
    if (!y || y < 2020 || y > 2100) return res.status(400).json({ message: 'Year must be between 2020 and 2100' });

    const project = await DB.projects.findById(projectId);
    if (!project) return res.status(400).json({ message: 'Invalid project' });

    const distribution = await DB.distributions.confirm(projectId, pps, m, y, req.user._id, distributionDate || null);
    res.status(201).json({
      ...distribution,
      project: { _id: project._id, title: project.title },
      monthName: MONTH_NAMES[m]
    });
  } catch (err) {
    // Duplicate or validation error
    const status = err.message.includes('already distributed') ? 409 : 400;
    res.status(status).json({ message: err.message });
  }
});

// Admin: List all distributions (with optional filters)
router.get('/', protect, adminOnly, async (req, res) => {
  try {
    const query = {};
    if (req.query.projectId) query.projectId = req.query.projectId;
    if (req.query.month) query.month = req.query.month;
    if (req.query.year) query.year = req.query.year;
    const list = await DB.distributions.find(query);
    const populated = await DB.distributions.populateAll(list);
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Single distribution detail
router.get('/detail/:id', protect, adminOnly, async (req, res) => {
  try {
    const dist = await DB.distributions.findById(req.params.id);
    if (!dist) return res.status(404).json({ message: 'Distribution not found' });
    const [populated] = await DB.distributions.populateAll([dist]);
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Get ledger entries for a specific distribution
router.get('/detail/:id/ledger', protect, adminOnly, async (req, res) => {
  try {
    const entries = await DB.distributions.getLedgerByDistribution(req.params.id);
    res.json(entries);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Investor: My profit ledger
router.get('/my', protect, async (req, res) => {
  try {
    if (req.user.role !== 'investor' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized' });
    }
    await processDueCyclesSafe({ adminId: 'system' });
    const investorId = req.user.role === 'admin' && req.query.investorId
      ? req.query.investorId
      : req.user._id;
    const entries = await DB.distributions.getInvestorLedger(investorId);
    res.json(entries);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Investor: Summary (total earned, per-project, monthly, wallet)
router.get('/my/summary', protect, async (req, res) => {
  try {
    if (req.user.role !== 'investor' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized' });
    }
    await processDueCyclesSafe({ adminId: 'system' });
    const investorId = req.user.role === 'admin' && req.query.investorId
      ? req.query.investorId
      : req.user._id;
    const summary = await DB.distributions.getInvestorSummary(investorId);

    const activeSchedules = await DB.profitSchedules.find({ status: 'active' });
    const upcoming = [];
    for (const schedule of activeSchedules) {
      const fresh = await DB.profitSchedules.findById(schedule._id);
      if (!fresh || fresh.status !== 'active') continue;

      const investments = await DB.investments.find({ investorId, projectId: fresh.projectId });
      const investorShares = investments
        .filter(i => ['active', 'completed'].includes(i.status))
        .reduce((s, i) => s + (Number(i.sharesCount) || 0), 0);
      if (investorShares <= 0) continue;

      const project = await DB.projects.findById(fresh.projectId);
      const dueNow = getDueCycleNumbers(fresh).length > 0;
      upcoming.push({
        projectId: fresh.projectId,
        projectTitle: project ? project.title : 'Project',
        cycleType: fresh.cycleType,
        cycleDays: CYCLE_DAYS[fresh.cycleType] || 7,
        profitPerShare: fresh.profitPerShare,
        investorShares,
        expectedProfit: investorShares * Number(fresh.profitPerShare || 0),
        nextDueDate: getNextDueDate(fresh),
        nextCycleNumber: (fresh.cyclesProcessed || 0) + 1,
        dueNow
      });
    }
    summary.upcomingProfits = upcoming;

    res.json(summary);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Investor: Wallet balance
router.get('/my/wallet', protect, async (req, res) => {
  try {
    if (req.user.role !== 'investor' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized' });
    }
    const investorId = req.user.role === 'admin' && req.query.investorId
      ? req.query.investorId
      : req.user._id;
    const wallet = await DB.wallets.getOrCreate(investorId);
    res.json(wallet);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Audit log for profit distributions
router.get('/audit-log', protect, adminOnly, async (req, res) => {
  try {
    const logs = await DB.auditLog.find({ action: 'profit_distribution' });

    // Populate admin name and project title for each log entry
    const populated = await Promise.all(logs.map(async (log) => {
      let adminName = 'Admin';
      let projectTitle = 'Unknown Project';
      try {
        if (log.performedBy) {
          const admin = await DB.users.findById(log.performedBy);
          if (admin) adminName = admin.name || admin.email || 'Admin';
        }
        if (log.metadata?.projectId) {
          const project = await DB.projects.findById(log.metadata.projectId);
          if (project) projectTitle = project.title;
        }
      } catch (_) { /* ignore lookup errors */ }
      return {
        ...log,
        adminName,
        projectTitle
      };
    }));

    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Delete distribution / audit log entry
router.delete('/audit-log/:id', protect, adminOnly, async (req, res) => {
  try {
    const result = await DB.distributions.deleteDistribution(req.params.id);
    res.json({ message: 'Distribution record deleted successfully', ...result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const result = await DB.distributions.deleteDistribution(req.params.id);
    res.json({ message: 'Distribution record deleted successfully', ...result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
