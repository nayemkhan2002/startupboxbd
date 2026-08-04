const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');

// ── Storage ──
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../data');

const PROFIT_IMAGES_FILE = path.join(DATA_DIR, 'profitImages.json');

const readImages = () => {
  if (!fs.existsSync(PROFIT_IMAGES_FILE)) {
    fs.writeFileSync(PROFIT_IMAGES_FILE, JSON.stringify([]), 'utf8');
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(PROFIT_IMAGES_FILE, 'utf8') || '[]');
  } catch {
    return [];
  }
};

const writeImages = (data) => {
  fs.writeFileSync(PROFIT_IMAGES_FILE, JSON.stringify(data, null, 2), 'utf8');
};

const generateId = () =>
  Math.random().toString(36).substring(2, 11) + Date.now().toString(36);

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
    const images = readImages().sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    res.json(images);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/profit-images (admin — upload + create) ──
router.post('/', protect, adminOnly, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message });
    if (!req.file) return res.status(400).json({ message: 'No image file provided' });

    const imageUrl = `/assets/uploads/profit/${req.file.filename}`;
    const images = readImages();
    const newEntry = {
      _id: generateId(),
      imageUrl,
      caption: req.body.caption || '',
      createdAt: new Date().toISOString()
    };
    images.push(newEntry);
    writeImages(images);
    res.status(201).json(newEntry);
  });
});

// ── DELETE /api/profit-images/:id (admin) ──
router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    let images = readImages();
    const image = images.find((i) => i._id === req.params.id);
    if (!image) return res.status(404).json({ message: 'Image not found' });

    // Delete file from disk
    const filePath = path.join(__dirname, '../../frontend', image.imageUrl);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    images = images.filter((i) => i._id !== req.params.id);
    writeImages(images);
    res.json({ message: 'Image deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
