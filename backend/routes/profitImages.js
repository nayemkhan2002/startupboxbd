const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const DB = require('../db');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');

// ── Multer for profit images ──
const uploadDir = path.join(__dirname, '../../frontend/assets/uploads/profit');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `profit_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|webp|svg|jfif|avif/i;
    const extOk = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = file.mimetype && file.mimetype.startsWith('image/');
    if (extOk || mimeOk) return cb(null, true);
    cb(new Error('Only image files are allowed!'));
  }
});

// ── GET /api/profit-images (public) ──
router.get('/', async (req, res) => {
  try {
    const images = await DB.profitImages.find();
    res.json(images);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/profit-images (admin — upload + create) ──
router.post('/', protect, adminOnly, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });
    if (!req.file) return res.status(400).json({ message: 'No image file provided' });

    try {
      const imageUrl = `/assets/uploads/profit/${req.file.filename}`;
      const newEntry = await DB.profitImages.create({
        imageUrl,
        caption: req.body.caption || ''
      });
      res.status(201).json(newEntry);
    } catch (dbErr) {
      res.status(500).json({ message: dbErr.message });
    }
  });
});

// ── DELETE /api/profit-images/:id (admin) ──
router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const image = await DB.profitImages.findByIdAndDelete(req.params.id);
    if (!image) return res.status(404).json({ message: 'Image not found' });

    // Try to delete file from disk (best-effort, won't fail if file missing)
    try {
      const filePath = path.join(__dirname, '../../frontend', image.imageUrl);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (_) { /* ignore file cleanup errors */ }

    res.json({ message: 'Image deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
