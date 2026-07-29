const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const DB = require('../db/jsonDb');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');

// Configure Multer for image uploads
const uploadDir = path.join(__dirname, '../../frontend/assets/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `project_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|webp|svg|jfif|avif/i;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = file.mimetype && file.mimetype.startsWith('image/');
    if (extname || mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files (JPG, PNG, GIF, WEBP, etc.) are allowed!'));
    }
  }
});

// Image Upload Endpoint (Admin only)
router.post('/upload', protect, adminOnly, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: err.message || 'File upload error' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No image file provided' });
    }
    const imageUrl = `/assets/uploads/${req.file.filename}`;
    res.json({ imageUrl });
  });
});

// Get all projects (Public/Investor)
router.get('/', async (req, res) => {
  try {
    const filter = req.query.status ? { status: req.query.status } : {};
    const projects = await DB.projects.find(filter);
    res.json(projects);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get single project (Public/Investor)
router.get('/:id', async (req, res) => {
  try {
    const project = await DB.projects.findById(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    res.json(project);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Create project (Admin only)
router.post('/', protect, adminOnly, async (req, res) => {
  try {
    const project = await DB.projects.create(req.body);
    res.status(201).json(project);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Update project (Admin only)
router.put('/:id', protect, adminOnly, async (req, res) => {
  try {
    const project = await DB.projects.findByIdAndUpdate(req.params.id, req.body);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    res.json(project);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete project (Admin only)
router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const project = await DB.projects.findByIdAndDelete(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    res.json({ message: 'Project removed' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
