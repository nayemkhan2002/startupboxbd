const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const DB = require('../db/jsonDb');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');

const uploadDir = path.join(__dirname, '../../frontend/assets/uploads/profiles');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `profile_${req.user._id}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /jpeg|jpg|png|gif|webp/i.test(path.extname(file.originalname)) ||
      (file.mimetype && file.mimetype.startsWith('image/'));
    cb(ok ? null : new Error('Only image files allowed'), ok);
  }
});

const publicProfile = (user) => {
  if (!user) return null;
  const { password, ...rest } = user;
  return {
    _id: rest._id,
    name: rest.name,
    email: rest.email,
    role: rest.role,
    phone: rest.phone || '',
    address: rest.address || '',
    profileImage: rest.profileImage || '',
    bankInfo: rest.bankInfo || {
      method: 'bkash',
      bkashNumber: '',
      bkashAccountType: 'Personal',
      bankName: '',
      accountName: '',
      accountNumber: '',
      branch: '',
      routingNumber: ''
    },
    createdAt: rest.createdAt
  };
};

// Get own profile
router.get('/me', protect, async (req, res) => {
  try {
    const user = await DB.users.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(publicProfile(user));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update own profile
router.put('/me', protect, async (req, res) => {
  try {
    const { name, phone, address, bankInfo, profileImage } = req.body;
    const updated = await DB.users.findByIdAndUpdate(req.user._id, {
      ...(name !== undefined ? { name } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(address !== undefined ? { address } : {}),
      ...(profileImage !== undefined ? { profileImage } : {}),
      ...(bankInfo ? { bankInfo } : {})
    });
    if (!updated) return res.status(404).json({ message: 'User not found' });

    // keep localStorage-friendly fields in sync for clients that refresh user blob
    res.json(publicProfile(updated));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Upload profile image
router.post('/me/avatar', protect, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ message: 'No image provided' });
    try {
      const profileImage = `/assets/uploads/profiles/${req.file.filename}`;
      const updated = await DB.users.findByIdAndUpdate(req.user._id, { profileImage });
      res.json({ profileImage, user: publicProfile(updated) });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });
});

// Change password
router.put('/me/password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new password are required' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }
    const result = await DB.users.updatePassword(req.user._id, currentPassword, newPassword);
    if (!result.ok) return res.status(400).json({ message: result.message });
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Admin: list investors
router.get('/investors', protect, adminOnly, async (req, res) => {
  try {
    const investors = await DB.users.listInvestors();
    res.json(investors);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
