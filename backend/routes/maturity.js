const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');
const DB = require('../db');
const {
  listMaturities,
  getMaturityCounts,
  payOffMaturity,
  getInvestorMaturitySummary,
  buildMaturityView
} = require('../services/maturityService');

// Admin: maturity notification counts
router.get('/counts', protect, adminOnly, async (req, res) => {
  try {
    const counts = await getMaturityCounts();
    res.json(counts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: paginated matured / filtered list
router.get('/', protect, adminOnly, async (req, res) => {
  try {
    const result = await listMaturities({
      maturityType: req.query.maturityType || req.query.type || 'all',
      status: req.query.status || 'MATURED',
      search: req.query.search || '',
      projectId: req.query.projectId || '',
      page: req.query.page,
      limit: req.query.limit,
      sortBy: req.query.sortBy || 'maturityDate',
      sortDir: req.query.sortDir || 'asc'
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: maturity payoff history
router.get('/history', protect, adminOnly, async (req, res) => {
  try {
    const query = {};
    if (req.query.investorId) query.investorId = req.query.investorId;
    if (req.query.investmentId) query.investmentId = req.query.investmentId;
    if (req.query.maturityType) query.maturityType = req.query.maturityType;
    const list = await DB.maturityPayoffs.find(query);
    const investorIds = [...new Set(list.map((p) => p.investorId))];
    const projectIds = [...new Set(list.map((p) => p.projectId))];
    const [users, projects] = await Promise.all([
      DB.users.listInvestors(),
      DB.projects.find({})
    ]);
    const uMap = new Map(users.map((u) => [u._id, u]));
    const pMap = new Map(projects.map((p) => [p._id, p]));
    res.json(list.map((p) => ({
      ...p,
      investor: uMap.get(p.investorId)
        ? { _id: p.investorId, name: uMap.get(p.investorId).name, email: uMap.get(p.investorId).email }
        : null,
      project: pMap.get(p.projectId)
        ? { _id: p.projectId, title: pMap.get(p.projectId).title }
        : null
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: single investment maturity detail
router.get('/investment/:id', protect, adminOnly, async (req, res) => {
  try {
    const investment = await DB.investments.findById(req.params.id);
    if (!investment) return res.status(404).json({ message: 'Investment not found' });
    const [populated] = await DB.investments.populateAll([investment]);
    const view = buildMaturityView(investment);
    const history = await DB.maturityPayoffs.find({ investmentId: investment._id });
    res.json({ investment: populated, maturity: view, history });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: confirm payoff
router.post('/payoff', protect, adminOnly, async (req, res) => {
  try {
    const {
      investmentId,
      paymentMethod,
      referenceNo,
      screenshotUrl,
      notes,
      includePrincipal,
      confirm
    } = req.body;

    if (!confirm) {
      return res.status(400).json({ message: 'Confirmation required. Set confirm=true to proceed.' });
    }

    const result = await payOffMaturity({
      investmentId,
      adminId: req.user._id,
      paymentMethod,
      referenceNo,
      screenshotUrl,
      notes,
      includePrincipal
    });

    res.status(201).json(result);
  } catch (err) {
    const status = /already been paid|not matured|does not use/i.test(err.message) ? 400 : 500;
    res.status(status).json({ message: err.message });
  }
});

// Investor (or admin with investorId): maturity summary for dashboard
router.get('/my', protect, async (req, res) => {
  try {
    if (req.user.role !== 'investor' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized' });
    }
    const investorId = req.user.role === 'admin' && req.query.investorId
      ? req.query.investorId
      : req.user._id;
    if (req.user.role === 'investor' && investorId !== req.user._id) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    const rows = await getInvestorMaturitySummary(investorId);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
