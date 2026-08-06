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
  resetPasswordToken: { type: String, index: true },
  resetPasswordExpires: Number,
  createdAt: String
}, opts);

const projectSchema = new mongoose.Schema({
  _id: idField,
  title: String,
  category: String,
  description: String,
  thumbnail: String,
  targetAmount: { type: Number, default: 0 },
  sharePrice: { type: Number, default: 0 },
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
  durationUnit: { type: String, default: 'months' },
  durationLabel: String,
  startDate: String,
  maturityDate: String,
  expectedReturn: { type: Number, default: 0 },
  returnEarned: mongoose.Schema.Types.Mixed,
  profitNotAssigned: { type: Boolean, default: false },
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

const profitImageSchema = new mongoose.Schema({
  _id: idField,
  imageUrl: String,
  caption: { type: String, default: '' },
  createdAt: String
}, opts);

const profitDistributionSchema = new mongoose.Schema({
  _id: idField,
  projectId: { type: String, required: true, index: true },
  profitPerShare: { type: Number, required: true },
  month: { type: Number, required: true },
  year: { type: Number, required: true },
  totalShares: { type: Number, default: 0 },
  totalInvestors: { type: Number, default: 0 },
  totalDistributed: { type: Number, default: 0 },
  status: { type: String, default: 'completed' },
  createdBy: { type: String, index: true },
  distributionDate: String,
  createdAt: String
}, opts);

// Duplicate protection: only one distribution per project per month per year
profitDistributionSchema.index({ projectId: 1, month: 1, year: 1 }, { unique: true });

const investorProfitLedgerSchema = new mongoose.Schema({
  _id: idField,
  distributionId: { type: String, required: true, index: true },
  investorId: { type: String, required: true, index: true },
  projectId: { type: String, required: true, index: true },
  investmentId: { type: String, index: true },
  shares: { type: Number, required: true },
  profitPerShare: { type: Number, required: true },
  calculatedProfit: { type: Number, required: true },
  month: { type: Number },
  year: { type: Number },
  createdAt: String
}, opts);

const auditLogSchema = new mongoose.Schema({
  _id: idField,
  action: { type: String, required: true, index: true },
  performedBy: { type: String, index: true },
  targetUserId: String,
  metadata: { type: Object, default: {} },
  createdAt: String
}, opts);

const walletSchema = new mongoose.Schema({
  _id: idField,
  investorId: { type: String, required: true, unique: true, index: true },
  availableBalance: { type: Number, default: 0 },
  pendingBalance: { type: Number, default: 0 },
  withdrawnBalance: { type: Number, default: 0 },
  updatedAt: String,
  createdAt: String
}, opts);

module.exports = {
  generateId,
  User: mongoose.model('User', userSchema),
  Project: mongoose.model('Project', projectSchema),
  Interest: mongoose.model('Interest', interestSchema),
  Investment: mongoose.model('Investment', investmentSchema),
  Withdrawal: mongoose.model('Withdrawal', withdrawalSchema),
  Payout: mongoose.model('Payout', payoutSchema),
  ProfitImage: mongoose.model('ProfitImage', profitImageSchema),
  ProfitDistribution: mongoose.model('ProfitDistribution', profitDistributionSchema),
  InvestorProfitLedger: mongoose.model('InvestorProfitLedger', investorProfitLedgerSchema),
  AuditLog: mongoose.model('AuditLog', auditLogSchema),
  Wallet: mongoose.model('Wallet', walletSchema)
};
