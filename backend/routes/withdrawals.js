const express = require('express');
const router = express.Router();
const DB = require('../db');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');

// Investor: my withdrawals
router.get('/my', protect, async (req, res) => {
  try {
    const list = await DB.withdrawals.find({ investorId: req.user._id });
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: all withdrawals
router.get('/', protect, adminOnly, async (req, res) => {
  try {
    const list = await DB.withdrawals.find(req.query.status ? { status: req.query.status } : {});
    const populated = await DB.withdrawals.populateAll(list);
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Investor: create withdrawal request
router.post('/', protect, async (req, res) => {
  try {
    if (req.user.role !== 'investor') {
      return res.status(403).json({ message: 'Only investors can request withdrawals' });
    }

    const { amount, method, paymentInfo } = req.body;
    const amt = Number(amount);

    if (!amt || amt <= 0) {
      return res.status(400).json({ message: 'Enter a valid withdrawal amount' });
    }
    if (!method || !['bkash', 'bank'].includes(method)) {
      return res.status(400).json({ message: 'Select bKash or Bank Account' });
    }

    if (method === 'bkash') {
      if (!paymentInfo?.bkashNumber || !paymentInfo?.accountName) {
        return res.status(400).json({ message: 'bKash number and account holder name are required' });
      }
    }
    if (method === 'bank') {
      if (!paymentInfo?.bankName || !paymentInfo?.accountName || !paymentInfo?.accountNumber) {
        return res.status(400).json({ message: 'Bank name, account holder and account number are required' });
      }
    }

    const stats = await DB.investments.getPortfolioStats(req.user._id);
    if (amt > stats.availableBalance) {
      return res.status(400).json({
        message: `Amount exceeds available balance (${stats.availableBalance})`
      });
    }

    const withdrawal = await DB.withdrawals.create({
      investorId: req.user._id,
      amount: amt,
      method,
      paymentInfo
    });

    res.status(201).json(withdrawal);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Admin: update status / note
router.put('/:id', protect, adminOnly, async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    const allowed = ['pending', 'approved', 'processing', 'completed', 'rejected'];
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    const updated = await DB.withdrawals.findByIdAndUpdate(req.params.id, {
      ...(status ? { status } : {}),
      ...(adminNote !== undefined ? { adminNote } : {})
    });
    if (!updated) return res.status(404).json({ message: 'Withdrawal not found' });
    const [populated] = await DB.withdrawals.populateAll([updated]);
    res.json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
