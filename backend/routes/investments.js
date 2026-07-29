const express = require('express');
const router = express.Router();
const DB = require('../db/jsonDb');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');

// Investor: my investments
router.get('/my', protect, async (req, res) => {
  try {
    if (req.user.role !== 'investor' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized' });
    }
    const investorId = req.user.role === 'admin' && req.query.investorId
      ? req.query.investorId
      : req.user._id;
    const list = await DB.investments.find({ investorId });
    const populated = await DB.investments.populateAll(list);
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Investor: portfolio stats
router.get('/stats', protect, async (req, res) => {
  try {
    const investorId = req.user.role === 'admin' && req.query.investorId
      ? req.query.investorId
      : req.user._id;
    if (req.user.role === 'investor' && investorId !== req.user._id) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    const stats = await DB.investments.getPortfolioStats(investorId);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: list all investments
router.get('/', protect, adminOnly, async (req, res) => {
  try {
    const list = await DB.investments.find(req.query.status ? { status: req.query.status } : {});
    const populated = await DB.investments.populateAll(list);
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Single investment (owner or admin)
router.get('/:id', protect, async (req, res) => {
  try {
    const item = await DB.investments.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Investment not found' });
    if (req.user.role !== 'admin' && item.investorId !== req.user._id) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    const [populated] = await DB.investments.populateAll([item]);
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: assign investment to investor
router.post('/', protect, adminOnly, async (req, res) => {
  try {
    const { investorId, projectId, amount, sharesCount, shares, roi, duration, startDate, status, notes, returnEarned } = req.body;
    if (!investorId || !projectId || !amount) {
      return res.status(400).json({ message: 'investorId, projectId and amount are required' });
    }
    const investor = await DB.users.findById(investorId);
    if (!investor || investor.role !== 'investor') {
      return res.status(400).json({ message: 'Invalid investor' });
    }
    const project = await DB.projects.findById(projectId);
    if (!project) return res.status(400).json({ message: 'Invalid project' });

    const investment = await DB.investments.create({
      investorId,
      projectId,
      amount,
      sharesCount: sharesCount || shares || 0,
      roi,
      duration,
      durationLabel: typeof duration === 'string' && /month/i.test(duration)
        ? duration
        : undefined,
      startDate,
      status: status || 'active',
      notes,
      returnEarned
    });
    const [populated] = await DB.investments.populateAll([investment]);
    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Admin: update investment
router.put('/:id', protect, adminOnly, async (req, res) => {
  try {
    const updated = await DB.investments.findByIdAndUpdate(req.params.id, req.body);
    if (!updated) return res.status(404).json({ message: 'Investment not found' });
    const [populated] = await DB.investments.populateAll([updated]);
    res.json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Admin: delete investment
router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const removed = await DB.investments.findByIdAndDelete(req.params.id);
    if (!removed) return res.status(404).json({ message: 'Investment not found' });
    res.json({ message: 'Investment removed' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
