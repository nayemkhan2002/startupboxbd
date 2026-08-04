const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const DB = require('../db');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');

// Multer memory storage for cloud/serverless compatibility (Base64 encoding)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|webp|svg|jfif|avif/i;
    const extOk = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = file.mimetype && file.mimetype.startsWith('image/');
    if (extOk || mimeOk) return cb(null, true);
    cb(new Error('Only image files are allowed!'));
  }
});

// Also setup optional local disk storage directory fallback if needed
const uploadDir = path.join(__dirname, '../../frontend/assets/uploads/profit');
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (_) {
  // Read-only filesystem environments (Vercel, Netlify, etc.) ignore local disk
}

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

    try {
      let finalImageUrl = req.body.imageUrl || '';

      if (req.file) {
        // Convert file buffer to Base64 Data URI for database storage
        const mimeType = req.file.mimetype || 'image/jpeg';
        const base64Str = req.file.buffer.toString('base64');
        finalImageUrl = `data:${mimeType};base64,${base64Str}`;

        // Best-effort local file write if directory is writable
        try {
          const filename = `profit_${Date.now()}${path.extname(req.file.originalname).toLowerCase() || '.jpg'}`;
          fs.writeFileSync(path.join(uploadDir, filename), req.file.buffer);
        } catch (_) {
          // Ignore if filesystem is read-only in production serverless environment
        }
      }

      if (!finalImageUrl) {
        return res.status(400).json({ message: 'Please upload an image file or provide an image URL.' });
      }

      const newEntry = await DB.profitImages.create({
        imageUrl: finalImageUrl,
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

    // Try to delete local file from disk if path exists
    try {
      if (image.imageUrl && image.imageUrl.startsWith('/assets/uploads/')) {
        const filePath = path.join(__dirname, '../../frontend', image.imageUrl);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (_) { /* ignore file cleanup errors on read-only systems */ }

    res.json({ message: 'Image deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
