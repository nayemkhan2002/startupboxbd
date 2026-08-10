const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const DB = require('../db');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');
const { buildInvestorEarningsPreview } = require('../services/profitCalculationService');

// Configure Multer for bank receipt screenshot uploads
const uploadDir = path.join(__dirname, '../../frontend/assets/uploads/payouts');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `payout_ss_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|webp|pdf|jfif|avif/i;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = file.mimetype && (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf');
    if (extname || mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Only image/PDF receipt files are allowed!'));
    }
  }
});

// Admin: Upload Bank Receipt Screenshot
router.post('/upload', protect, adminOnly, (req, res) => {
  upload.single('screenshot')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: err.message || 'File upload error' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No screenshot file provided' });
    }
    const screenshotUrl = `/assets/uploads/payouts/${req.file.filename}`;
    res.json({ screenshotUrl });
  });
});

// Investor: Get my profit payouts
router.get('/my', protect, async (req, res) => {
  try {
    const list = await DB.payouts.find({ investorId: req.user._id });
    const populated = await DB.payouts.populateAll(list);
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: List all profit payouts
router.get('/', protect, adminOnly, async (req, res) => {
  try {
    const query = {};
    if (req.query.investorId) query.investorId = req.query.investorId;
    if (req.query.investmentId) query.investmentId = req.query.investmentId;
    const list = await DB.payouts.find(query);
    const populated = await DB.payouts.populateAll(list);
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Search investors by email or name
router.get('/investor-search', protect, adminOnly, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q || q.length < 2) {
      return res.json([]);
    }
    const investors = await DB.users.listInvestors();
    const matches = investors
      .filter((inv) =>
        (inv.email || '').toLowerCase().includes(q) ||
        (inv.name || '').toLowerCase().includes(q))
      .slice(0, 20)
      .map((inv) => ({
        _id: inv._id,
        name: inv.name,
        email: inv.email,
        phone: inv.phone || ''
      }));
    res.json(matches);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Preview investor earnings for manual payout
router.get('/earnings-preview', protect, adminOnly, async (req, res) => {
  try {
    const { investorId } = req.query;
    if (!investorId) {
      return res.status(400).json({ message: 'investorId is required' });
    }
    const frequency = ['weekly', 'monthly', 'all'].includes(req.query.frequency)
      ? req.query.frequency
      : 'all';
    const preview = await buildInvestorEarningsPreview(investorId, { frequency });
    if (!preview) {
      return res.status(404).json({ message: 'Investor not found' });
    }
    res.json(preview);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Record manual profit payout (bank / bKash)
router.post('/manual', protect, adminOnly, async (req, res) => {
  try {
    const {
      investorId,
      projectId,
      amount,
      paymentMethod,
      referenceNo,
      screenshotUrl,
      notes,
      periodLabel,
      cycleNumber
    } = req.body;

    if (!investorId) {
      return res.status(400).json({ message: 'Investor is required' });
    }
    const investor = await DB.users.getInvestorById(investorId);
    if (!investor) {
      return res.status(404).json({ message: 'Investor not found' });
    }

    const payoutAmount = Number(amount);
    if (!payoutAmount || payoutAmount <= 0) {
      return res.status(400).json({ message: 'Enter a valid payout amount' });
    }

    const method = paymentMethod === 'bKash' ? 'bKash' : 'Bank Transfer';
    if (!referenceNo && !screenshotUrl) {
      return res.status(400).json({ message: 'Provide a reference number or transfer proof screenshot' });
    }

    if (projectId) {
      const preview = await buildInvestorEarningsPreview(investorId, { frequency: 'all' });
      const project = preview?.projects?.find((p) => p.projectId === projectId);
      if (!project) {
        return res.status(400).json({ message: 'Investor has no shares in this project' });
      }
      if (payoutAmount > project.unpaidAccrued + 0.01) {
        return res.status(400).json({
          message: `Amount exceeds unpaid profit for this project (max ৳${Math.round(project.unpaidAccrued).toLocaleString()})`
        });
      }
    } else {
      const preview = await buildInvestorEarningsPreview(investorId, { frequency: 'all' });
      const totalUnpaid = preview?.totalUnpaid || 0;
      if (payoutAmount > totalUnpaid + 0.01) {
        return res.status(400).json({
          message: `Amount exceeds total unpaid profit (max ৳${Math.round(totalUnpaid).toLocaleString()})`
        });
      }
    }

    const payout = await DB.payouts.create({
      investorId,
      projectId: projectId || '',
      amount: payoutAmount,
      paymentMethod: method,
      referenceNo: referenceNo || '',
      screenshotUrl: screenshotUrl || '',
      notes: notes || '',
      monthYear: periodLabel || '',
      cycleNumber: cycleNumber || null,
      payoutType: 'manual_profit',
      payoutDate: new Date().toISOString()
    });

    const [populated] = await DB.payouts.populateAll([payout]);
    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Admin: Delete profit payout
router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const removed = await DB.payouts.findByIdAndDelete(req.params.id);
    if (!removed) return res.status(404).json({ message: 'Payout record not found' });
    res.json({ message: 'Payout record deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
