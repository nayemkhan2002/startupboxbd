const mongoose = require('mongoose');

// Same ID shape the JSON store used, so existing string comparisons in the
// routes (item.investorId !== req.user._id) keep working untouched.
const generateId = () =>
  Math.random().toString(36).substring(2, 11) + Date.now().toString(36);

// strict:false mirrors the schemaless JSON store — payloads keep any extra
// fields the routes pass through. minimize:false preserves empty objects.
const opts = { strict: false, minimize: false, versionKey: false };

const idField = { type: String, default: generateId };

const userSchema = new mongoose.Schema({
  _id: idField,
  name: String,
  email: { type: String, index: true },
  password: String,
  role: { type: String, default: 'investor', index: true },
  phone: String,
  address: String,
  profileImage: String,
  bankInfo: {
    method: { type: String, default: 'bkash' },
    bkashNumber: String,
    bkashAccountType: { type: String, default: 'Personal' },
    bankName: String,
    accountName: String,
    accountNumber: String,
    branch: String,
    routingNumber: String
  },
  createdAt: String
}, opts);

const projectSchema = new mongoose.Schema({
  _id: idField,
  title: String,
  category: String,
  description: String,
  thumbnail: String,
  targetAmount: { type: Number, default: 0 },
  raisedAmount: { type: Number, default: 0 },
  totalShares: { type: Number, default: 0 },
  duration: String,
  deadline: String,
  riskLevel: { type: String, default: 'Medium' },
  expectedROI: { type: String, default: 'N/A' },
  teamInfo: String,
  milestones: { type: Array, default: [] },
  documents: { type: Array, default: [] },
  status: { type: String, default: 'open', index: true },
  createdAt: String
}, opts);

const interestSchema = new mongoose.Schema({
  _id: idField,
  investor: { type: String, index: true },
  project: String,
  amountIntended: { type: Number, default: 0 },
  message: String,
  status: { type: String, default: 'pending' },
  submittedAt: String
}, opts);

const investmentSchema = new mongoose.Schema({
  _id: idField,
  investorId: { type: String, index: true },
  projectId: { type: String, index: true },
  amount: { type: Number, default: 0 },
  sharesCount: { type: Number, default: 0 },
  roi: { type: Number, default: 0 },
  duration: mongoose.Schema.Types.Mixed,
  durationLabel: String,
  startDate: String,
  maturityDate: String,
  expectedReturn: { type: Number, default: 0 },
  returnEarned: { type: Number, default: 0 },
  status: { type: String, default: 'active', index: true },
  paymentHistory: { type: Array, default: [] },
  timeline: { type: Array, default: [] },
  notes: String,
  createdAt: String
}, opts);

const withdrawalSchema = new mongoose.Schema({
  _id: idField,
  investorId: { type: String, index: true },
  amount: { type: Number, default: 0 },
  method: String,
  paymentInfo: { type: Object, default: {} },
  status: { type: String, default: 'pending', index: true },
  adminNote: String,
  createdAt: String,
  updatedAt: String
}, opts);

const payoutSchema = new mongoose.Schema({
  _id: idField,
  investorId: { type: String, index: true },
  investmentId: { type: String, index: true },
  projectId: { type: String, index: true },
  amount: { type: Number, default: 0 },
  monthYear: String,
  paymentMethod: { type: String, default: 'Bank Transfer' },
  referenceNo: String,
  screenshotUrl: String,
  notes: String,
  payoutDate: String,
  createdAt: String
}, opts);

module.exports = {
  generateId,
  User: mongoose.model('User', userSchema),
  Project: mongoose.model('Project', projectSchema),
  Interest: mongoose.model('Interest', interestSchema),
  Investment: mongoose.model('Investment', investmentSchema),
  Withdrawal: mongoose.model('Withdrawal', withdrawalSchema),
  Payout: mongoose.model('Payout', payoutSchema)
};
