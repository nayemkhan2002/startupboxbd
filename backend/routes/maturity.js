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

// Admin: maturity counts for dashboard cards
router.get('/counts', protect, adminOnly, async (req, res) => {
  try {
    const counts = await getMaturityCounts();
    res.json(counts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: diagnose why maturity list may be empty (schedules, investments, today)
router.get('/diagnose', protect, adminOnly, async (req, res) => {
  try {
    const {
      getTodayDateStr,
      getCompletedCycleCount,
      getCyclePeriod
    } = require('../services/profitScheduleService');
    const { buildAllMaturityRows } = require('../services/maturityService');

    const todayStr = getTodayDateStr();
    const schedules = await DB.profitSchedules.find({ status: 'active' });
    const projectIds = schedules.map((s) => s.projectId);
    const investments = projectIds.length
      ? await DB.investments.find({ projectIds, statusIn: ['active', 'completed'] })
      : [];
    const maturityEnabled = (await DB.investments.find({})).filter((i) => i.maturityEnabled).length;
    const { rows } = await buildAllMaturityRows();
    const matured = rows.filter((r) => r.isMatured && !r.isPaid);

    res.json({
      today: todayStr,
      timezone: 'Asia/Dhaka',
      activeSchedules: schedules.map((s) => {
        const completed = getCompletedCycleCount(s);
        const last = completed > 0 ? getCyclePeriod(s, completed) : null;
        return {
          scheduleId: s._id,
          projectId: s.projectId,
          cycleType: s.cycleType,
          startDate: s.startDate,
          profitPerShare: s.profitPerShare,
          completedCycles: completed,
          lastPeriodEnd: last?.periodEnd || null
        };
      }),
      investmentsOnScheduledProjects: investments.length,
      maturityEnabledInvestments: maturityEnabled,
      totalReportRows: rows.length,
      unpaidMaturedRows: matured.length,
      sampleMatured: matured.slice(0, 5).map((r) => ({
        investor: r.investorName,
        project: r.projectTitle,
        shares: r.shares,
        profit: r.profitAmount,
        cycle: r.currentCycleNumber,
        maturityDate: r.maturityDate,
        source: r.source
      })),
      hint: matured.length
        ? 'Data looks OK — if the page still shows 0, hard-refresh or redeploy frontend/admin/maturity.html'
        : (schedules.length === 0
          ? 'No active Assign Profit schedules found'
          : (investments.length === 0
            ? 'Schedules exist but no active investments on those projects'
            : 'Schedules/investments found but no completed cycles yet for today\'s date'))
    });
  } catch (err) {
    res.status(500).json({ message: err.message, stack: err.stack });
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
      cycleNumber,
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
      includePrincipal,
      cycleNumber
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
