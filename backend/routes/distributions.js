const express = require('express');
const router = express.Router();
const DB = require('../db');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

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
    const investorId = req.user.role === 'admin' && req.query.investorId
      ? req.query.investorId
      : req.user._id;
    const summary = await DB.distributions.getInvestorSummary(investorId);
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

module.exports = router;
