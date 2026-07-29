const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  title: { type: String, required: true },
  category: { type: String, required: true },
  description: { type: String, required: true },
  thumbnail: { type: String }, // URL or path
  targetAmount: { type: Number, required: true },
  raisedAmount: { type: Number, default: 0 },
  deadline: { type: Date, required: true },
  riskLevel: { type: String, enum: ['Low', 'Medium', 'High'], required: true },
  expectedROI: { type: String, required: true },
  teamInfo: { type: String },
  milestones: [{ type: String }],
  documents: [{ type: String }], // Array of URLs or paths
  status: { type: String, enum: ['open', 'closed', 'coming_soon'], default: 'open' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Project', projectSchema);
