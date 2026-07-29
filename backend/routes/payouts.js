const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const DB = require('../db/jsonDb');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');

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

// Admin: Create profit payout
router.post('/', protect, adminOnly, async (req, res) => {
  try {
    const { investorId, investmentId, projectId, amount, monthYear, paymentMethod, referenceNo, screenshotUrl, notes, payoutDate } = req.body;
    if (!investorId || !amount || amount <= 0) {
      return res.status(400).json({ message: 'investorId and valid amount are required' });
    }

    const investor = await DB.users.findById(investorId);
    if (!investor) return res.status(400).json({ message: 'Invalid investor' });

    const payout = await DB.payouts.create({
      investorId,
      investmentId: investmentId || '',
      projectId: projectId || '',
      amount: Number(amount),
      monthYear: monthYear || '',
      paymentMethod: paymentMethod || 'Bank Transfer',
      referenceNo: referenceNo || '',
      screenshotUrl: screenshotUrl || '',
      notes: notes || '',
      payoutDate: payoutDate || new Date().toISOString()
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
