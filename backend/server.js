const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from both root .env and backend/.env
dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config({ path: path.join(__dirname, '.env') });

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
app.use('/api/profit-images', require('./routes/profitImages'));
app.use('/api/distributions', require('./routes/distributions'));

// Fallback for root
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

const PORT = process.env.PORT || 5000;

// Start HTTP server immediately to bind port for Passenger health check
const server = app.listen(PORT, () => {
  console.log(`Server running smoothly on port ${PORT}`);
});

// Initialize Database asynchronously
DB.initDb().then(() => {
  console.log('Database initialized successfully');
}).catch(err => {
  console.error('Failed to initialize database:', err);
});

module.exports = app;
