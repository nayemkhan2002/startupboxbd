const mongoose = require('mongoose');

const interestSchema = new mongoose.Schema({
  investor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
  amountIntended: { type: Number, required: true },
  message: { type: String },
  status: { type: String, enum: ['pending', 'reviewed', 'contacted', 'closed'], default: 'pending' },
  submittedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Interest', interestSchema);
