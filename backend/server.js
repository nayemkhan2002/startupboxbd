const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

// Must run before requiring ./db — the storage backend is chosen from
// process.env.MONGO_URI at require time.
dotenv.config();

const DB = require('./db');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files
const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/interest', require('./routes/interest'));
app.use('/api/investments', require('./routes/investments'));
app.use('/api/withdrawals', require('./routes/withdrawals'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/payouts', require('./routes/payouts'));

// Fallback for root
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

const PORT = process.env.PORT || 5000;

// Initialize Database & Start Server
DB.initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running smoothly on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
});
