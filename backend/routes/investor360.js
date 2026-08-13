/**
 * Admin Investor 360 API Endpoints
 *
 * GET  /api/admin/investors/:id/360     — Complete Investor 360 bundle
 * PUT  /api/admin/investors/:id/profile — Non-financial profile update (validated + audit logged)
 * POST /api/admin/investors/:id/notes   — Add admin internal note
 * DELETE /api/admin/investors/:id/notes/:noteId — Delete admin note
 * GET  /api/admin/investors/:id/export  — Export investor 360 report
 */
const express = require('express');
const router = express.Router();
const DB = require('../db');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');
const { getInvestorDashboardBundle, buildProjectBreakdown } = require('../services/profitCalculationService');
const {
  User, Investment, InvestorProfitLedger, ProfitDistribution,
  Wallet, Withdrawal, MaturityPayoff, AuditLog, Project
} = require('../db/models');

// ── GET /api/admin/investors/:id/360 ─────────────────────────────
router.get('/investors/:id/360', protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Profile check
    const user = await DB.users.findById(id);
    if (!user || user.role !== 'investor') {
      return res.status(404).json({ message: 'Investor profile not found' });
    }

    // Strip password
    const { password, ...profile } = user;

    // 2. Fetch authoritative data sources in parallel
    const [
      investments,
      ledger,
      wallet,
      withdrawals,
      maturityPayoffs,
      auditLogs,
      dashboardBundle
    ] = await Promise.all([
      DB.investments.find({ investorId: id }),
      InvestorProfitLedger.find({ investorId: id }).lean(),
      DB.wallets.getOrCreate(id),
      Withdrawal.find({ investorId: id }).sort({ createdAt: -1 }).lean(),
      MaturityPayoff.find({ investorId: id }).sort({ createdAt: -1 }).lean(),
      AuditLog.find({ targetUserId: id }).sort({ createdAt: -1 }).lean(),
      getInvestorDashboardBundle(id).catch(err => {
        console.error(`360 bundle error for investor ${id}:`, err.message);
        return null;
      })
    ]);

    // Populate investments with project details
    const populatedInvestments = await DB.investments.populateAll(investments);

    // Project breakdown from authoritative calculation service
    const projectBreakdown = dashboardBundle?.projectBreakdown || await buildProjectBreakdown(id);

    // 3. Summaries & KPIs
    const activeInvestments = investments.filter(i => i.status === 'active');
    const validInvestments = investments.filter(i => ['active', 'completed', 'pending'].includes(i.status));
    const totalInvested = validInvestments.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const totalShares = investments
      .filter(i => ['active', 'completed'].includes(i.status))
      .reduce((s, i) => s + (Number(i.sharesCount) || 0), 0);

    const ledgerProfit = ledger.reduce((s, e) => s + (Number(e.calculatedProfit) || 0), 0);
    const maturityProfit = maturityPayoffs
      .filter(m => m.status === 'PAID')
      .reduce((s, m) => s + (Number(m.profitAmount) || 0), 0);
    const returnEarnedStat = investments.reduce((s, i) => s + (Number(i.returnEarned) || 0), 0);
    const totalFromProjects = projectBreakdown.reduce((s, p) => s + (p.earnedSoFar || 0), 0);

    const totalProfitEarned = Math.max(
      returnEarnedStat,
      ledgerProfit,
      maturityProfit,
      totalFromProjects,
      dashboardBundle?.totalEarned || 0
    );

    const walletAvailable = Number(wallet?.availableBalance) || 0;
    const pendingWithdrawalAmount = withdrawals
      .filter(w => ['pending', 'approved', 'processing'].includes(w.status))
      .reduce((s, w) => s + (Number(w.amount) || 0), 0);
    const totalWithdrawn = withdrawals
      .filter(w => w.status === 'completed')
      .reduce((s, w) => s + (Number(w.amount) || 0), 0);
    const maturedCount = investments.filter(i => i.status === 'completed' || i.maturityDate && new Date(i.maturityDate) <= new Date()).length;

    // 4. Build Activity Timeline
    const timeline = [];

    // Account creation event
    if (profile.createdAt) {
      timeline.push({
        id: `act_join_${profile._id}`,
        type: 'account_created',
        title: 'Investor Account Registered',
        description: `Account created for ${profile.name || profile.email}`,
        performedBy: 'system',
        date: profile.createdAt
      });
    }

    // Investments created
    for (const inv of populatedInvestments) {
      timeline.push({
        id: `act_inv_${inv._id}`,
        type: 'investment_created',
        title: `Invested in ${inv.project?.title || 'Project'}`,
        description: `Allocated ৳${Number(inv.amount).toLocaleString()} for ${inv.sharesCount || 0} shares`,
        referenceId: inv._id,
        performedBy: 'admin',
        date: inv.startDate || inv.createdAt || new Date().toISOString()
      });
    }

    // Profit ledger distributions
    for (const leg of ledger) {
      timeline.push({
        id: `act_prof_${leg._id}`,
        type: 'profit_credited',
        title: `Profit Credited (Cycle ${leg.cycleNumber || 1})`,
        description: `Earned ৳${Number(leg.calculatedProfit).toLocaleString()} from project`,
        referenceId: leg.investmentId || leg._id,
        performedBy: 'system',
        date: leg.createdAt || new Date().toISOString()
      });
    }

    // Withdrawals
    for (const w of withdrawals) {
      timeline.push({
        id: `act_wth_${w._id}`,
        type: 'withdrawal_request',
        title: `Withdrawal Request: ৳${Number(w.amount).toLocaleString()}`,
        description: `Status: ${(w.status || 'pending').toUpperCase()} via ${w.paymentMethod || 'bKash'}`,
        referenceId: w._id,
        performedBy: profile.name || 'investor',
        date: w.createdAt || new Date().toISOString()
      });
    }

    // Audit Log events (profile edits, status changes)
    for (const log of auditLogs) {
      timeline.push({
        id: `act_audit_${log._id}`,
        type: log.action || 'admin_action',
        title: `Admin Action: ${log.action}`,
        description: JSON.stringify(log.metadata || {}),
        performedBy: log.performedBy || 'admin',
        date: log.createdAt || new Date().toISOString()
      });
    }

    // Sort timeline descending by date
    timeline.sort((a, b) => new Date(b.date) - new Date(a.date));

    // 5. Data Integrity Check for this investor
    const anomalies = [];
    if (!wallet) {
      anomalies.push('Wallet missing for investor account');
    }
    const invWithNoProject = populatedInvestments.filter(i => !i.project);
    if (invWithNoProject.length) {
      anomalies.push(`${invWithNoProject.length} investment(s) missing project details`);
    }

    res.json({
      profile: {
        ...profile,
        dob: profile.dob || profile.dateOfBirth || '',
        address: profile.address || '',
        nid: profile.nid || profile.nationalId || '',
        notes: profile.notes || [],
        accountStatus: profile.accountStatus || 'active'
      },
      summary: {
        totalInvested,
        totalShares,
        activeInvestmentsCount: activeInvestments.length,
        investmentCount: investments.length,
        totalProfitEarned,
        walletBalance: walletAvailable,
        pendingWithdrawal: pendingWithdrawalAmount,
        totalWithdrawn,
        maturedCount,
        projectsCount: projectBreakdown.length
      },
      investments: populatedInvestments,
      projectBreakdown,
      profitLedger: ledger,
      wallet: {
        ...wallet,
        availableBalance: walletAvailable
      },
      withdrawals,
      maturityPayoffs,
      timeline,
      notes: profile.notes || [],
      integrity: {
        status: anomalies.length > 0 ? 'WARNING' : 'OK',
        anomalies
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── PUT /api/admin/investors/:id/profile ─────────────────────────
// Non-financial profile editor with strict validation & audit logging
router.get('/investors/check-email', protect, adminOnly, async (req, res) => {
  try {
    const { email, excludeId } = req.query;
    if (!email) return res.json({ available: true });
    const existing = await User.findOne({ email: email.toLowerCase().trim() }).lean();
    if (existing && existing._id !== excludeId) {
      return res.json({ available: false });
    }
    res.json({ available: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put('/investors/:id/profile', protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await DB.users.findById(id);
    if (!user || user.role !== 'investor') {
      return res.status(404).json({ message: 'Investor not found' });
    }

    const {
      name, email, phone, address, dob, dateOfBirth, nid, nationalId,
      profileImage, accountStatus, bankInfo
    } = req.body;

    // Strict non-financial fields whitelist
    const updates = {};
    const changes = [];

    if (name !== undefined && name !== user.name) {
      changes.push({ field: 'name', old: user.name, new: name });
      updates.name = name.trim();
    }
    if (email !== undefined && email.toLowerCase().trim() !== (user.email || '').toLowerCase()) {
      const cleanEmail = email.toLowerCase().trim();
      if (!/\S+@\S+\.\S+/.test(cleanEmail)) {
        return res.status(400).json({ message: 'Invalid email address format' });
      }
      const existing = await User.findOne({ email: cleanEmail }).lean();
      if (existing && existing._id !== id) {
        return res.status(400).json({ message: 'Email is already in use by another user' });
      }
      changes.push({ field: 'email', old: user.email, new: cleanEmail });
      updates.email = cleanEmail;
    }
    if (phone !== undefined && phone !== user.phone) {
      changes.push({ field: 'phone', old: user.phone, new: phone });
      updates.phone = phone.trim();
    }
    if (address !== undefined && address !== user.address) {
      changes.push({ field: 'address', old: user.address, new: address });
      updates.address = address.trim();
    }
    const newDob = dob || dateOfBirth;
    if (newDob !== undefined && newDob !== (user.dob || user.dateOfBirth)) {
      changes.push({ field: 'dob', old: user.dob || user.dateOfBirth, new: newDob });
      updates.dob = newDob;
    }
    const newNid = nid || nationalId;
    if (newNid !== undefined && newNid !== (user.nid || user.nationalId)) {
      changes.push({ field: 'nid', old: user.nid || user.nationalId, new: newNid });
      updates.nid = newNid;
    }
    if (profileImage !== undefined && profileImage !== user.profileImage) {
      updates.profileImage = profileImage;
    }
    if (accountStatus !== undefined && accountStatus !== user.accountStatus) {
      if (!['active', 'suspended', 'inactive'].includes(accountStatus)) {
        return res.status(400).json({ message: 'Invalid account status' });
      }
      changes.push({ field: 'accountStatus', old: user.accountStatus || 'active', new: accountStatus });
      updates.accountStatus = accountStatus;
    }
    if (bankInfo && typeof bankInfo === 'object') {
      updates.bankInfo = { ...(user.bankInfo || {}), ...bankInfo };
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ message: 'No changes detected', user: stripUserPassword(user) });
    }

    // Save changes
    const updatedUser = await DB.users.findByIdAndUpdate(id, updates);

    // Audit log entry
    if (changes.length > 0) {
      await DB.auditLog.create({
        action: 'investor_profile_update',
        performedBy: req.user._id,
        targetUserId: id,
        metadata: { changes }
      });
    }

    res.json({
      message: 'Investor profile updated successfully',
      user: updatedUser
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/admin/investors/:id/notes ──────────────────────────
router.post('/investors/:id/notes', protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'Note text is required' });
    }

    const user = await DB.users.findById(id);
    if (!user || user.role !== 'investor') {
      return res.status(404).json({ message: 'Investor not found' });
    }

    const notes = user.notes || [];
    const newNote = {
      id: 'note_' + Date.now().toString(36),
      text: text.trim(),
      createdBy: req.user.name || req.user.email || 'Admin',
      creatorId: req.user._id,
      createdAt: new Date().toISOString()
    };

    notes.unshift(newNote);
    await DB.users.findByIdAndUpdate(id, { notes });

    res.json({ message: 'Note added', note: newNote, notes });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── DELETE /api/admin/investors/:id/notes/:noteId ────────────────
router.delete('/investors/:id/notes/:noteId', protect, adminOnly, async (req, res) => {
  try {
    const { id, noteId } = req.params;
    const user = await DB.users.findById(id);
    if (!user || user.role !== 'investor') {
      return res.status(404).json({ message: 'Investor not found' });
    }

    const notes = (user.notes || []).filter(n => n.id !== noteId);
    await DB.users.findByIdAndUpdate(id, { notes });

    res.json({ message: 'Note removed', notes });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Helper
function stripUserPassword(user) {
  if (!user) return null;
  const { password, ...rest } = user;
  return rest;
}

module.exports = router;
