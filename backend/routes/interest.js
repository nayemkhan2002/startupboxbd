const express = require('express');
const router = express.Router();
const DB = require('../db/jsonDb');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');

// Submit interest (Investor only)
router.post('/', protect, async (req, res) => {
  try {
    const { project, amountIntended, message } = req.body;
    
    const interest = await DB.interests.create({
      investor: req.user._id,
      project,
      amountIntended,
      message
    });
    
    res.status(201).json(interest);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Get all interests (Admin only)
router.get('/', protect, adminOnly, async (req, res) => {
  try {
    const interests = await DB.interests.find();
    const populated = await DB.interests.populateAll(interests);
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get user's own interests (Investor)
router.get('/my', protect, async (req, res) => {
  try {
    const interests = await DB.interests.find({ investor: req.user._id });
    const populated = await DB.interests.populateAll(interests);
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update interest status (Admin only)
router.put('/:id', protect, adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    const interest = await DB.interests.findByIdAndUpdate(req.params.id, { status });
    if (!interest) return res.status(404).json({ message: 'Interest not found' });
    res.json(interest);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
