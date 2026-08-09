const express = require('express');
const router = express.Router();
const DB = require('../db');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');

router.get('/dashboard-stats', protect, adminOnly, async (req, res) => {
  try {
    const stats = await DB.adminStats.getDashboard();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
