const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const {
  generateId, User, Project, Interest, Investment, Withdrawal, Payout, ProfitImage,
  ProfitDistribution, ProfitSchedule, InvestorProfitLedger, AuditLog, Wallet
} = require('./models');

const stripPassword = (user) => {
  if (!user) return null;
  const { password, ...rest } = user;
  return rest;
};

const addMonths = (dateStr, months) => {
  const d = new Date(dateStr || Date.now());
  if (!months) return d.toISOString();
  d.setMonth(d.getMonth() + Number(months));
  return d.toISOString();
};

const parseDurationMonths = (duration) => {
  if (duration == null) return 0;
  if (typeof duration === 'number') return duration;
  const match = String(duration).match(/(\d+)/);
  return match ? Number(match[1]) : 0;
};

const calcExpectedReturn = (amount, roi) => {
  const amt = Number(amount) || 0;
  const r = Number(roi) || 0;
  if (!amt || !r) return 0;
  return Math.round(amt * (r / 100));
};

const connect = async () => {
  if (mongoose.connection.readyState === 1) return;
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not set');
  }
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 20000
  });
  console.log(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
};

/**
 * A pre-schedule deploy created a plain unique index on {projectId, month, year},
 * which rejects the 2nd+ weekly cycle of a month. Mongoose cannot replace an index
 * whose options changed, so the stale one is dropped explicitly.
 */
const reconcileDistributionIndexes = async () => {
  try {
    const coll = ProfitDistribution.collection;
    const existing = await coll.indexes();
    for (const idx of existing) {
      const key = idx.key || {};
      const isMonthYearKey = key.projectId === 1 && key.month === 1 && key.year === 1;
      if (isMonthYearKey && idx.unique && !idx.partialFilterExpression) {
        await coll.dropIndex(idx.name);
        console.log(`Dropped legacy unique index "${idx.name}" on profit distributions`);
      }
    }
    await ProfitDistribution.createIndexes();
    await InvestorProfitLedger.createIndexes();
  } catch (err) {
    console.warn('Profit distribution index reconciliation skipped:', err.message);
  }
};

const initDb = async () => {
  await connect();
  await reconcileDistributionIndexes();

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@startupboxbd.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'password123';
  const adminExists = await User.findOne({ email: adminEmail }).lean();
  if (!adminExists) {
    if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
      console.warn('⚠️  ADMIN_PASSWORD not set — seeding admin with default password. Set ADMIN_PASSWORD in production!');
    }
    await User.create({
      _id: 'admin_id_default',
      name: 'Admin',
      email: adminEmail,
      password: await bcrypt.hash(adminPassword, 10),
      role: 'admin',
      phone: '',
      address: '',
      profileImage: '',
      bankInfo: { method: 'bkash', bkashAccountType: 'Personal' },
      createdAt: new Date().toISOString()
    });
    console.log(`Seeded Admin user (${adminEmail})`);
  } else {
    const passwordOk = await bcrypt.compare(adminPassword, adminExists.password);
    if (!passwordOk) {
      await User.updateOne(
        { email: adminEmail },
        { $set: { password: await bcrypt.hash(adminPassword, 10) } }
      );
      console.log('Admin password was out of sync — reset to match ADMIN_PASSWORD / default.');
    }
  }

  // Demo investor is a local-development convenience only.
  if (process.env.NODE_ENV !== 'production') {
    const demo = await User.findOne({ email: 'investor@startupboxbd.com' }).lean();
    if (!demo) {
      await User.create({
        _id: 'investor_id_default',
        name: 'Demo Investor',
        email: 'investor@startupboxbd.com',
        password: await bcrypt.hash('password123', 10),
        role: 'investor',
        phone: '01700000000',
        address: 'Dhaka, Bangladesh',
        profileImage: '',
        bankInfo: { method: 'bkash', bkashNumber: '01700000000', bkashAccountType: 'Personal' },
        createdAt: new Date().toISOString()
      });
      console.log('Seeded Investor user (investor@startupboxbd.com / password123)');
    }
  }

  // Auto-seed projects if collection is empty
  const projectCount = await Project.countDocuments();
  if (projectCount === 0) {
    const seedFile = path.join(__dirname, 'seed-projects.json');
    if (fs.existsSync(seedFile)) {
      try {
        const seedData = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
        if (Array.isArray(seedData) && seedData.length > 0) {
          await Project.insertMany(seedData);
          console.log(`Seeded ${seedData.length} projects into MongoDB`);
        }
      } catch (e) {
        console.error('Failed to seed projects into MongoDB:', e);
      }
    }
  }
};

const DB = {
  initDb,
  connect,

  users: {
    find: async (query = {}) => {
      const q = {};
      if (query.email) q.email = query.email;
      if (query.role) q.role = query.role;
      return User.find(q).lean();
    },
    findOne: async (query = {}) => User.findOne(query).lean(),
    findById: async (id) => User.findById(id).lean(),
    create: async (userData) => {
      const doc = await User.create({
        name: userData.name,
        email: userData.email,
        password: await bcrypt.hash(userData.password, 10),
        role: userData.role || 'investor',
        phone: userData.phone || '',
        address: userData.address || '',
        profileImage: userData.profileImage || '',
        bankInfo: {
          method: 'bkash',
          bkashNumber: '',
          bkashAccountType: 'Personal',
          bankName: '',
          accountName: '',
          accountNumber: '',
          branch: '',
          routingNumber: ''
        },
        createdAt: new Date().toISOString()
      });
      return doc.toObject();
    },
    findByIdAndUpdate: async (id, updateData) => {
      const allowed = { ...updateData };
      delete allowed.password;
      delete allowed.role;
      delete allowed._id;
      delete allowed.email;

      const $set = {};
      if (allowed.bankInfo) {
        // Merge, don't replace, matching the previous behaviour.
        for (const [k, v] of Object.entries(allowed.bankInfo)) {
          $set[`bankInfo.${k}`] = v;
        }
        delete allowed.bankInfo;
      }
      Object.assign($set, allowed);

      const updated = await User.findByIdAndUpdate(id, { $set }, { new: true }).lean();
      return stripPassword(updated);
    },
    updatePassword: async (id, currentPassword, newPassword) => {
      const user = await User.findById(id).lean();
      if (!user) return { ok: false, message: 'User not found' };
      const match = await bcrypt.compare(currentPassword, user.password);
      if (!match) return { ok: false, message: 'Current password is incorrect' };
      await User.updateOne(
        { _id: id },
        { $set: { password: await bcrypt.hash(newPassword, 10) } }
      );
      return { ok: true };
    },
    resetPassword: async (id, newPassword) => {
      await User.updateOne(
        { _id: id },
        {
          $set: { password: await bcrypt.hash(newPassword, 10) },
          $unset: { resetPasswordToken: 1, resetPasswordExpires: 1 }
        }
      );
      return { ok: true };
    },
    matchPassword: async (enteredPassword, hashedPassword) =>
      bcrypt.compare(enteredPassword, hashedPassword),
    listInvestors: async () => {
      const list = await User.find({ role: 'investor' }).lean();
      return list.map(stripPassword);
    },
    listInvestorsWithStats: async () => {
      const investors = await User.find({ role: 'investor' }).lean();
      const investments = await Investment.find({}).lean();

      return investors.map((inv) => {
        const invInvestments = investments.filter(i => i.investorId === inv._id);
        const projectIds = new Set(invInvestments.map(i => i.projectId).filter(Boolean));
        const totalShares = invInvestments
          .filter(i => ['active', 'completed'].includes(i.status))
          .reduce((s, i) => s + (Number(i.sharesCount) || 0), 0);
        const totalInvested = invInvestments
          .filter(i => ['active', 'completed', 'pending'].includes(i.status))
          .reduce((s, i) => s + (Number(i.amount) || 0), 0);

        return {
          ...stripPassword(inv),
          stats: {
            projectsCount: projectIds.size,
            investmentCount: invInvestments.length,
            totalShares,
            totalInvested,
            activeInvestments: invInvestments.filter(i => i.status === 'active').length
          }
        };
      });
    },
    getInvestorById: async (id) => {
      const user = await User.findOne({ _id: id, role: 'investor' }).lean();
      if (!user) return null;
      const investments = await Investment.find({ investorId: id }).lean();
      const projectIds = new Set(investments.map(i => i.projectId).filter(Boolean));
      const totalShares = investments
        .filter(i => ['active', 'completed'].includes(i.status))
        .reduce((s, i) => s + (Number(i.sharesCount) || 0), 0);
      const totalInvested = investments
        .filter(i => ['active', 'completed', 'pending'].includes(i.status))
        .reduce((s, i) => s + (Number(i.amount) || 0), 0);

      return {
        ...stripPassword(user),
        stats: {
          projectsCount: projectIds.size,
          investmentCount: investments.length,
          totalShares,
          totalInvested,
          activeInvestments: investments.filter(i => i.status === 'active').length
        }
      };
    },
    suspendUser: async (id) => {
      const user = await User.findById(id).lean();
      if (!user || user.role === 'admin') return null;
      const current = user.accountStatus || 'active';
      const newStatus = current === 'suspended' ? 'active' : 'suspended';
      const updated = await User.findByIdAndUpdate(id, { $set: { accountStatus: newStatus } }, { new: true }).lean();
      return stripPassword(updated);
    },
    deleteUser: async (id) => {
      const user = await User.findById(id).lean();
      if (!user || user.role === 'admin') return null;
      await User.deleteOne({ _id: id });
      return stripPassword(user);
    },
    deleteAdmin: async (id, requesterId) => {
      if (id === requesterId) return null;
      const user = await User.findOne({ _id: id, role: 'admin' }).lean();
      if (!user) return null;
      await User.deleteOne({ _id: id });
      return stripPassword(user);
    }
  },

  projects: {
    find: async (query = {}) => {
      const q = query.status ? { status: query.status } : {};
      // ISO-8601 strings sort lexicographically == chronologically.
      return Project.find(q).sort({ createdAt: -1 }).lean();
    },
    findById: async (id) => Project.findById(id).lean(),
    create: async (projectData) => {
      const doc = await Project.create({
        title: projectData.title,
        category: projectData.category,
        description: projectData.description,
        thumbnail: projectData.thumbnail || '',
        targetAmount: Number(projectData.targetAmount) || 0,
        sharePrice: Number(projectData.sharePrice) || 0,
        raisedAmount: Number(projectData.raisedAmount) || 0,
        totalShares: Number(projectData.totalShares) || 0,
        duration: projectData.duration || '',
        deadline: projectData.deadline,
        riskLevel: projectData.riskLevel || 'Medium',
        expectedROI: projectData.expectedROI || 'N/A',
        teamInfo: projectData.teamInfo || '',
        milestones: projectData.milestones || [],
        documents: projectData.documents || [],
        status: projectData.status || 'open',
        createdAt: new Date().toISOString()
      });
      return doc.toObject();
    },
    findByIdAndUpdate: async (id, updateData) =>
      Project.findByIdAndUpdate(id, { $set: updateData }, { new: true }).lean(),
    findByIdAndDelete: async (id) => Project.findByIdAndDelete(id).lean()
  },

  interests: {
    find: async (query = {}) => {
      const q = query.investor ? { investor: query.investor } : {};
      return Interest.find(q).sort({ submittedAt: -1 }).lean();
    },
    findById: async (id) => Interest.findById(id).lean(),
    create: async (payload) => {
      const doc = await Interest.create({
        investor: payload.investor,
        project: payload.project,
        amountIntended: Number(payload.amountIntended) || 0,
        message: payload.message || '',
        status: payload.status || 'pending',
        submittedAt: new Date().toISOString()
      });
      return doc.toObject();
    },
    findByIdAndUpdate: async (id, updateData) =>
      Interest.findByIdAndUpdate(id, { $set: updateData }, { new: true }).lean(),
    findByIdAndDelete: async (id) => Interest.findByIdAndDelete(id).lean(),
    populateAll: async (list) => {
      if (!list.length) return [];
      const users = await User.find({ _id: { $in: list.map(i => i.investor) } }).lean();
      const projects = await Project.find({ _id: { $in: list.map(i => i.project) } }).lean();
      const uMap = new Map(users.map(u => [u._id, u]));
      const pMap = new Map(projects.map(p => [p._id, p]));
      return list.map(item => {
        const inv = uMap.get(item.investor);
        const proj = pMap.get(item.project);
        return {
          ...item,
          investor: inv ? { _id: inv._id, name: inv.name, email: inv.email } : null,
          project: proj
            ? { _id: proj._id, title: proj.title, category: proj.category, thumbnail: proj.thumbnail }
            : null
        };
      });
    }
  },

  investments: {
    find: async (query = {}) => {
      const q = {};
      if (query.investorId) q.investorId = query.investorId;
      if (query.projectId) q.projectId = query.projectId;
      if (query.status) q.status = query.status;
      const data = await Investment.find(q).lean();
      return data.sort((a, b) =>
        new Date(b.createdAt || b.startDate) - new Date(a.createdAt || a.startDate));
    },
    findById: async (id) => Investment.findById(id).lean(),
    create: async (payload) => {
      const amount = Number(payload.amount) || 0;
      const roi = Number(payload.roi) || 0;
      const durationMonths = parseDurationMonths(payload.duration);
      const startDate = payload.startDate || null;
      const maturityDate = payload.maturityDate || (startDate ? addMonths(startDate, durationMonths || 12) : null);
      const expectedReturn = payload.expectedReturn != null
        ? Number(payload.expectedReturn)
        : calcExpectedReturn(amount, roi);

      const unit = payload.durationUnit || 'months';
      let label = payload.durationLabel;
      if (!label && payload.duration) {
        label = `${payload.duration} ${unit.charAt(0).toUpperCase() + unit.slice(1)}`;
      }

      const profitNotAssigned = Boolean(payload.profitNotAssigned);
      let returnEarned = null;
      if (!profitNotAssigned && payload.returnEarned !== undefined && payload.returnEarned !== null && payload.returnEarned !== '') {
        returnEarned = Number(payload.returnEarned);
      }

      const doc = await Investment.create({
        investorId: payload.investorId,
        projectId: payload.projectId,
        amount,
        sharesCount: Number(payload.sharesCount || payload.shares) || 0,
        roi,
        duration: payload.duration || durationMonths || 0,
        durationUnit: unit,
        durationLabel: label || (durationMonths ? `${durationMonths} Months` : String(payload.duration || '')),
        startDate,
        maturityDate,
        expectedReturn,
        returnEarned,
        profitNotAssigned,
        status: payload.status || 'active',
        paymentHistory: payload.paymentHistory || [
          { type: 'investment', label: 'Initial Investment Allocated', amount, date: startDate || new Date().toISOString() }
        ],
        timeline: payload.timeline || [
          { key: 'approved', label: 'Investment Approved', date: startDate, done: true },
          { key: 'started', label: 'Business Started', date: startDate, done: true },
          { key: 'profit', label: 'Profit Generated', date: null, done: false },
          { key: 'completed', label: 'Completed', date: null, done: false }
        ],
        notes: payload.notes || '',
        createdAt: new Date().toISOString()
      });

      // Atomic increment, unlike the old read-modify-write.
      if (payload.projectId) {
        await Project.updateOne({ _id: payload.projectId }, { $inc: { raisedAmount: amount } });
      }
      return doc.toObject();
    },
    findByIdAndUpdate: async (id, updateData) => {
      const current = await Investment.findById(id).lean();
      if (!current) return null;
      const next = { ...current, ...updateData };

      if (updateData.amount != null || updateData.roi != null) {
        if (updateData.expectedReturn == null) {
          next.expectedReturn = calcExpectedReturn(
            Number(next.amount) || 0,
            Number(next.roi) || 0
          );
        }
      }
      if (next.status === 'completed') {
        next.timeline = (next.timeline || []).map(t => ({
          ...t,
          done: true,
          date: t.date || new Date().toISOString()
        }));
        if (!next.returnEarned) next.returnEarned = Number(next.expectedReturn) || 0;
      }
      delete next._id;
      return Investment.findByIdAndUpdate(id, { $set: next }, { new: true }).lean();
    },
    findByIdAndDelete: async (id) => Investment.findByIdAndDelete(id).lean(),
    populateAll: async (list) => {
      if (!list.length) return [];
      const users = await User.find({ _id: { $in: list.map(i => i.investorId) } }).lean();
      const projects = await Project.find({ _id: { $in: list.map(i => i.projectId) } }).lean();
      const uMap = new Map(users.map(u => [u._id, u]));
      const pMap = new Map(projects.map(p => [p._id, p]));
      return list.map(item => {
        const inv = uMap.get(item.investorId);
        const proj = pMap.get(item.projectId);
        return {
          ...item,
          investor: inv ? { _id: inv._id, name: inv.name, email: inv.email } : null,
          project: proj
            ? {
                _id: proj._id,
                title: proj.title,
                category: proj.category,
                thumbnail: proj.thumbnail,
                description: proj.description,
                riskLevel: proj.riskLevel,
                status: proj.status
              }
            : null
        };
      });
    },
    getPortfolioStats: async (investorId) => {
      const [investments, withdrawals, ledger] = await Promise.all([
        Investment.find({ investorId }).lean(),
        Withdrawal.find({ investorId }).lean(),
        InvestorProfitLedger.find({ investorId }).lean()
      ]);

      const totalInvested = investments
        .filter(i => ['active', 'completed', 'pending'].includes(i.status))
        .reduce((s, i) => s + (Number(i.amount) || 0), 0);

      const activeInvestments = investments.filter(i => i.status === 'active').length;

      const expectedReturnActive = investments
        .filter(i => i.status === 'active')
        .reduce((s, i) => s + (Number(i.expectedReturn) || 0), 0);

      // Lifetime earnings live on the investments (written by every distribution and
      // by legacy payouts), so they stay correct for pre-wallet records too.
      const earnedFromInvestments = investments
        .reduce((s, i) => s + (Number(i.returnEarned) || 0), 0);
      const earnedFromLedger = ledger
        .reduce((s, e) => s + (Number(e.calculatedProfit) || 0), 0);
      const totalReturnEarned = Math.max(earnedFromInvestments, earnedFromLedger);

      const pendingWithdrawals = withdrawals
        .filter(w => ['pending', 'approved', 'processing'].includes(w.status))
        .reduce((s, w) => s + (Number(w.amount) || 0), 0);
      const totalWithdrawn = withdrawals
        .filter(w => w.status === 'completed')
        .reduce((s, w) => s + (Number(w.amount) || 0), 0);

      const availableBalance = Math.max(0, totalReturnEarned - totalWithdrawn - pendingWithdrawals);

      const totalShares = investments
        .filter(i => ['active', 'completed'].includes(i.status))
        .reduce((s, i) => s + (Number(i.sharesCount) || 0), 0);

      return {
        totalInvested,
        totalShares,
        activeInvestments,
        totalReturnEarned,
        expectedReturn: expectedReturnActive,
        pendingWithdrawals,
        totalWithdrawn,
        availableBalance,
        investmentCount: investments.length
      };
    }
  },

  withdrawals: {
    find: async (query = {}) => {
      const q = {};
      if (query.investorId) q.investorId = query.investorId;
      if (query.status) q.status = query.status;
      return Withdrawal.find(q).sort({ createdAt: -1 }).lean();
    },
    findById: async (id) => Withdrawal.findById(id).lean(),
    create: async (payload) => {
      const doc = await Withdrawal.create({
        investorId: payload.investorId,
        amount: Number(payload.amount) || 0,
        method: payload.method, // bkash | bank
        paymentInfo: payload.paymentInfo || {},
        status: 'pending',
        adminNote: '',
        createdAt: new Date().toISOString()
      });
      return doc.toObject();
    },
    findByIdAndUpdate: async (id, updateData) => {
      const prev = await Withdrawal.findById(id).lean();
      if (!prev) return null;

      const oldStatus = prev.status;
      const newStatus = updateData.status !== undefined ? updateData.status : oldStatus;
      const now = new Date().toISOString();

      if (newStatus === 'completed' && oldStatus !== 'completed') {
        const amt = Number(prev.amount) || 0;
        const stats = await DB.investments.getPortfolioStats(prev.investorId);
        // The request itself is counted as pending, so add it back before comparing.
        const spendable = stats.availableBalance + amt;
        if (amt > spendable) {
          throw new Error(`Amount exceeds investor's earned balance (৳${spendable} available, ৳${amt} requested)`);
        }

        const wallet = await Wallet.findOne({ investorId: prev.investorId }).lean();
        const avail = wallet ? Number(wallet.availableBalance) || 0 : 0;
        await Wallet.findOneAndUpdate(
          { investorId: prev.investorId },
          {
            $set: { availableBalance: Math.max(0, avail - amt), updatedAt: now },
            $inc: { withdrawnBalance: amt },
            $setOnInsert: { investorId: prev.investorId, pendingBalance: 0, createdAt: now }
          },
          { upsert: true }
        );

        const existing = await Payout.findOne({ withdrawalId: id }).lean();
        if (!existing) {
          await Payout.create({
            investorId: prev.investorId,
            withdrawalId: id,
            amount: amt,
            monthYear: 'Withdrawal',
            paymentMethod: prev.method === 'bkash' ? 'bKash' : 'Bank Transfer',
            referenceNo: updateData.referenceNo || prev.referenceNo || '',
            screenshotUrl: updateData.screenshotUrl || prev.screenshotUrl || '',
            notes: updateData.adminNote !== undefined ? updateData.adminNote : (prev.adminNote || ''),
            payoutDate: now,
            createdAt: now
          });
        }
        updateData.completedAt = now;
      }

      return Withdrawal.findByIdAndUpdate(
        id,
        { $set: { ...updateData, updatedAt: now } },
        { new: true }
      ).lean();
    },
    populateAll: async (list) => {
      if (!list.length) return [];
      const users = await User.find({ _id: { $in: list.map(w => w.investorId) } }).lean();
      const uMap = new Map(users.map(u => [u._id, u]));
      return list.map(item => {
        const inv = uMap.get(item.investorId);
        return {
          ...item,
          investor: inv
            ? { _id: inv._id, name: inv.name, email: inv.email, phone: inv.phone || '' }
            : null
        };
      });
    }
  },

  payouts: {
    find: async (query = {}) => {
      const q = {};
      if (query.investorId) q.investorId = query.investorId;
      if (query.investmentId) q.investmentId = query.investmentId;
      if (query.projectId) q.projectId = query.projectId;
      const data = await Payout.find(q).lean();
      return data.sort((a, b) =>
        new Date(b.payoutDate || b.createdAt) - new Date(a.payoutDate || a.createdAt));
    },
    findById: async (id) => Payout.findById(id).lean(),
    create: async (payload) => {
      const amount = Number(payload.amount) || 0;
      const payoutDate = payload.payoutDate || new Date().toISOString();
      const doc = await Payout.create({
        investorId: payload.investorId,
        investmentId: payload.investmentId || '',
        projectId: payload.projectId || '',
        withdrawalId: payload.withdrawalId || '',
        amount,
        monthYear: payload.monthYear || '',
        paymentMethod: payload.paymentMethod || 'Bank Transfer',
        referenceNo: payload.referenceNo || '',
        screenshotUrl: payload.screenshotUrl || '',
        notes: payload.notes || '',
        payoutDate,
        createdAt: new Date().toISOString()
      });
      return doc.toObject();
    },
    findByIdAndDelete: async (id) => {
      const item = await Payout.findByIdAndDelete(id).lean();
      return item || null;
    },
    populateAll: async (list) => {
      if (!list.length) return [];
      const users = await User.find({ _id: { $in: list.map(p => p.investorId) } }).lean();
      const projects = await Project.find({ _id: { $in: list.map(p => p.projectId) } }).lean();
      const investments = await Investment.find({ _id: { $in: list.map(p => p.investmentId) } }).lean();
      const uMap = new Map(users.map(u => [u._id, u]));
      const pMap = new Map(projects.map(p => [p._id, p]));
      const iMap = new Map(investments.map(i => [i._id, i]));
      return list.map(item => {
        const inv = uMap.get(item.investorId);
        const proj = pMap.get(item.projectId);
        const investment = iMap.get(item.investmentId);
        return {
          ...item,
          investor: inv
            ? { _id: inv._id, name: inv.name, email: inv.email, phone: inv.phone || '' }
            : null,
          project: proj
            ? { _id: proj._id, title: proj.title, category: proj.category, thumbnail: proj.thumbnail }
            : null,
          investment: investment
            ? { _id: investment._id, amount: investment.amount, sharesCount: investment.sharesCount }
            : null
        };
      });
    }
  },

  profitImages: {
    find: async () => ProfitImage.find().sort({ createdAt: -1 }).lean(),
    create: async (data) => {
      const doc = await ProfitImage.create({
        imageUrl: data.imageUrl,
        caption: data.caption || '',
        createdAt: new Date().toISOString()
      });
      return doc.toObject();
    },
    findByIdAndDelete: async (id) => ProfitImage.findByIdAndDelete(id).lean()
  },

  // Idempotent investor crediting for a scheduled distribution record.
  _creditScheduledCycleInvestors: async (distribution, preview, payload, session = null) => {
    const {
      projectId, profitPerShare, cycleNumber, cycleType,
      periodStart, periodEnd, month, year, adminId, distributionDate, scheduleId
    } = payload;
    const now = distributionDate ? new Date(distributionDate).toISOString() : new Date().toISOString();
    const cycleLabel = cycleType === 'monthly' ? 'Monthly' : 'Weekly';

    const run = async (sess) => {
      const cycleCredited = await InvestorProfitLedger.findOne({ scheduleId, cycleNumber })
        .session(sess)
        .lean();
      if (cycleCredited) return;

      const existingLedger = await InvestorProfitLedger.find({ distributionId: distribution._id })
        .session(sess)
        .lean();
      if (existingLedger.length > 0) return;

      const ledgerDocs = [];
      for (const inv of preview.investors) {
        for (const invDetail of inv.investments) {
          const profit = invDetail.shares * profitPerShare;
          ledgerDocs.push({
            distributionId: distribution._id,
            scheduleId,
            investorId: inv.investorId,
            projectId,
            investmentId: invDetail.investmentId,
            shares: invDetail.shares,
            profitPerShare,
            calculatedProfit: profit,
            month,
            year,
            cycleNumber,
            cycleType,
            periodStart,
            periodEnd,
            createdAt: now
          });
        }
      }
      await InvestorProfitLedger.insertMany(ledgerDocs, { session: sess });

      for (const inv of preview.investors) {
        await Wallet.updateOne(
          { investorId: inv.investorId },
          {
            $inc: { availableBalance: inv.calculatedProfit },
            $set: { updatedAt: now },
            $setOnInsert: {
              investorId: inv.investorId,
              pendingBalance: 0,
              withdrawnBalance: 0,
              createdAt: now
            }
          },
          { upsert: true, session: sess }
        );

        for (const invDetail of inv.investments) {
          const profit = invDetail.shares * profitPerShare;
          await Investment.updateOne(
            { _id: invDetail.investmentId },
            {
              $inc: { returnEarned: profit },
              $set: { profitNotAssigned: false },
              $push: {
                paymentHistory: {
                  type: 'profit_distribution',
                  label: `${cycleLabel} Profit — Cycle ${cycleNumber} (${periodStart} → ${periodEnd})`,
                  amount: profit,
                  date: now
                }
              }
            },
            { session: sess }
          );
        }
      }

      const auditExists = await AuditLog.findOne({
        action: 'profit_distribution',
        'metadata.distributionId': distribution._id
      }).session(sess).lean();
      if (!auditExists) {
        await AuditLog.create([{
          action: 'profit_distribution',
          performedBy: adminId,
          metadata: {
            distributionId: distribution._id,
            scheduleId,
            cycleNumber,
            cycleType,
            periodStart,
            periodEnd,
            projectId,
            profitPerShare,
            month,
            year,
            distributionDate: distributionDate || now,
            totalInvestors: preview.totalInvestors,
            totalShares: preview.totalShares,
            totalDistributed: preview.grandTotal
          },
          createdAt: now
        }], { session: sess });
      }
    };

    if (session) {
      await run(session);
      return;
    }

    const ownSession = await mongoose.startSession();
    try {
      await ownSession.withTransaction(() => run(ownSession));
    } finally {
      await ownSession.endSession();
    }
  },

  // ─── Profit Distribution System ─────────────────────────────
  distributions: {
    /**
     * Preview distribution — read-only, no DB writes.
     * Fetches all investments for the project and calculates per-investor profit.
     */
    preview: async (projectId, profitPerShare) => {
      const investments = await Investment.find({
        projectId,
        status: { $in: ['active', 'completed'] }
      }).lean();

      if (!investments.length) return { investors: [], totalShares: 0, totalInvestors: 0, grandTotal: 0 };

      // Group shares by investor (an investor may have multiple investments in the same project)
      const investorMap = new Map();
      for (const inv of investments) {
        const shares = Number(inv.sharesCount) || 0;
        if (shares <= 0) continue;
        const existing = investorMap.get(inv.investorId);
        if (existing) {
          existing.totalShares += shares;
          existing.investments.push({ investmentId: inv._id, shares });
        } else {
          investorMap.set(inv.investorId, {
            investorId: inv.investorId,
            totalShares: shares,
            investments: [{ investmentId: inv._id, shares }]
          });
        }
      }

      // Populate investor names
      const investorIds = Array.from(investorMap.keys());
      const users = await User.find({ _id: { $in: investorIds } }).lean();
      const uMap = new Map(users.map(u => [u._id, u]));

      const investors = [];
      let totalShares = 0;
      let grandTotal = 0;
      for (const [id, data] of investorMap) {
        const user = uMap.get(id);
        const profit = data.totalShares * profitPerShare;
        totalShares += data.totalShares;
        grandTotal += profit;
        investors.push({
          investorId: id,
          investorName: user ? user.name : 'Unknown',
          investorEmail: user ? user.email : '',
          totalShares: data.totalShares,
          profitPerShare,
          calculatedProfit: profit,
          investments: data.investments
        });
      }

      return {
        investors,
        totalShares,
        totalInvestors: investors.length,
        grandTotal
      };
    },

    /**
     * Confirm distribution — full transactional write.
     * Creates distribution record, ledger entries, wallet credits, and audit log.
     */
    confirm: async (projectId, profitPerShare, month, year, adminId, distributionDate) => {
      // Check for duplicates BEFORE starting the transaction
      const existing = await ProfitDistribution.findOne({
        projectId, month, year, scheduleId: { $exists: false }
      }).lean();
      if (existing) {
        throw new Error(`Profit already distributed for this project for ${month}/${year}`);
      }

      // Get the preview data
      const preview = await DB.distributions.preview(projectId, profitPerShare);
      if (!preview.investors.length) {
        throw new Error('No investors with shares found for this project');
      }

      const now = distributionDate ? new Date(distributionDate).toISOString() : new Date().toISOString();
      const session = await mongoose.startSession();
      let distribution;

      try {
        await session.withTransaction(async () => {
          // 1. Create the distribution record
          const [distDoc] = await ProfitDistribution.create([{
            projectId,
            profitPerShare,
            month,
            year,
            totalShares: preview.totalShares,
            totalInvestors: preview.totalInvestors,
            totalDistributed: preview.grandTotal,
            status: 'completed',
            createdBy: adminId,
            distributionDate: distributionDate || now,
            createdAt: now
          }], { session });
          distribution = distDoc.toObject();

          // 2. Create ledger entries for every investor
          const ledgerDocs = [];
          for (const inv of preview.investors) {
            for (const invDetail of inv.investments) {
              const profit = invDetail.shares * profitPerShare;
              ledgerDocs.push({
                distributionId: distribution._id,
                investorId: inv.investorId,
                projectId,
                investmentId: invDetail.investmentId,
                shares: invDetail.shares,
                profitPerShare,
                calculatedProfit: profit,
                month,
                year,
                createdAt: now
              });
            }
          }
          await InvestorProfitLedger.insertMany(ledgerDocs, { session });

          // 3. Update wallets and investment returnEarned for each investor
          for (const inv of preview.investors) {
            // Wallet: upsert and increment
            await Wallet.updateOne(
              { investorId: inv.investorId },
              {
                $inc: { availableBalance: inv.calculatedProfit },
                $set: { updatedAt: now },
                $setOnInsert: {
                  investorId: inv.investorId,
                  pendingBalance: 0,
                  withdrawnBalance: 0,
                  createdAt: now
                }
              },
              { upsert: true, session }
            );

            // Update returnEarned safely on each investment record
            for (const invDetail of inv.investments) {
              const profit = invDetail.shares * profitPerShare;
              const currentInv = await Investment.findById(invDetail.investmentId).lean().session(session);
              const currentEarned = currentInv && typeof currentInv.returnEarned === 'number' ? currentInv.returnEarned : 0;
              await Investment.updateOne(
                { _id: invDetail.investmentId },
                {
                  $set: {
                    returnEarned: currentEarned + profit,
                    profitNotAssigned: false
                  },
                  $push: {
                    paymentHistory: {
                      type: 'profit_distribution',
                      label: `Profit Distribution (${month}/${year})`,
                      amount: profit,
                      date: now
                    }
                  }
                },
                { session }
              );
            }
          }

          // 4. Audit log
          await AuditLog.create([{
            action: 'profit_distribution',
            performedBy: adminId,
            metadata: {
              distributionId: distribution._id,
              projectId,
              profitPerShare,
              month,
              year,
              distributionDate: distributionDate || now,
              totalInvestors: preview.totalInvestors,
              totalShares: preview.totalShares,
              totalDistributed: preview.grandTotal
            },
            createdAt: now
          }], { session });
        });
      } finally {
        await session.endSession();
      }

      return distribution;
    },

    confirmScheduledCycle: async (payload) => {
      const {
        scheduleId, projectId, profitPerShare, cycleNumber, cycleType,
        periodStart, periodEnd, month, year, adminId, distributionDate
      } = payload;

      const preview = await DB.distributions.preview(projectId, profitPerShare);
      if (!preview.investors.length) return null;

      // Ledger is the source of truth — if this cycle was already paid, return
      // immediately without creating another distribution record.
      const cycleCredited = await InvestorProfitLedger.findOne({ scheduleId, cycleNumber }).lean();
      if (cycleCredited) {
        return ProfitDistribution.findOne({ scheduleId, cycleNumber }).lean();
      }

      const existing = await ProfitDistribution.findOne({ scheduleId, cycleNumber }).lean();
      if (existing) {
        await DB._creditScheduledCycleInvestors(existing, preview, payload);
        return existing;
      }

      const now = distributionDate ? new Date(distributionDate).toISOString() : new Date().toISOString();
      const session = await mongoose.startSession();
      let distribution;

      try {
        await session.withTransaction(async () => {
          const [distDoc] = await ProfitDistribution.create([{
            projectId,
            scheduleId,
            cycleNumber,
            cycleType,
            periodStart,
            periodEnd,
            profitPerShare,
            month,
            year,
            totalShares: preview.totalShares,
            totalInvestors: preview.totalInvestors,
            totalDistributed: preview.grandTotal,
            status: 'completed',
            createdBy: adminId,
            distributionDate: distributionDate || now,
            createdAt: now
          }], { session });
          distribution = distDoc.toObject();
          await DB._creditScheduledCycleInvestors(distribution, preview, payload, session);
        });
      } catch (err) {
        if (err && err.code === 11000) {
          const already = await ProfitDistribution.findOne({ scheduleId, cycleNumber }).lean();
          if (already) {
            await DB._creditScheduledCycleInvestors(already, preview, payload);
            return already;
          }
          console.warn(`Cycle ${cycleNumber} rejected by a duplicate-key index:`, err.message);
          return undefined;
        }
        throw err;
      } finally {
        await session.endSession();
      }

      return distribution;
    },

    find: async (query = {}) => {
      const q = {};
      if (query.projectId) q.projectId = query.projectId;
      if (query.month) q.month = Number(query.month);
      if (query.year) q.year = Number(query.year);
      return ProfitDistribution.find(q).sort({ createdAt: -1 }).lean();
    },

    findById: async (id) => ProfitDistribution.findById(id).lean(),

    getLedgerByDistribution: async (distributionId) => {
      const entries = await InvestorProfitLedger.find({ distributionId }).lean();
      if (!entries.length) return [];
      const userIds = [...new Set(entries.map(e => e.investorId))];
      const users = await User.find({ _id: { $in: userIds } }).lean();
      const uMap = new Map(users.map(u => [u._id, u]));
      return entries.map(e => ({
        ...e,
        investor: uMap.get(e.investorId) ? {
          _id: uMap.get(e.investorId)._id,
          name: uMap.get(e.investorId).name,
          email: uMap.get(e.investorId).email
        } : null
      }));
    },

    getInvestorLedger: async (investorId) => {
      const entries = await InvestorProfitLedger.find({ investorId }).sort({ createdAt: -1 }).lean();
      if (!entries.length) return [];
      const projectIds = [...new Set(entries.map(e => e.projectId))];
      const projects = await Project.find({ _id: { $in: projectIds } }).lean();
      const pMap = new Map(projects.map(p => [p._id, p]));
      return entries.map(e => ({
        ...e,
        project: pMap.get(e.projectId) ? {
          _id: pMap.get(e.projectId)._id,
          title: pMap.get(e.projectId).title,
          category: pMap.get(e.projectId).category
        } : null
      }));
    },

    getInvestorSummary: async (investorId) => {
      const [entries, investments, wallet] = await Promise.all([
        InvestorProfitLedger.find({ investorId }).lean(),
        Investment.find({ investorId }).lean(),
        Wallet.findOne({ investorId }).lean()
      ]);

      const earnedFromLedger = entries.reduce((s, e) => s + (Number(e.calculatedProfit) || 0), 0);
      const earnedFromInvestments = investments
        .filter(i => ['active', 'completed'].includes(i.status))
        .reduce((s, i) => s + (Number(i.returnEarned) || 0), 0);
      const totalEarned = Math.max(earnedFromLedger, earnedFromInvestments);

      const projectMap = new Map();

      // Investments are the source of truth for current share holdings.
      for (const inv of investments) {
        if (!['active', 'completed'].includes(inv.status)) continue;
        const pid = inv.projectId;
        const shares = Number(inv.sharesCount) || 0;
        if (shares <= 0) continue;
        const existing = projectMap.get(pid);
        if (existing) {
          existing.totalShares += shares;
          existing.totalProfit += Number(inv.returnEarned) || 0;
        } else {
          projectMap.set(pid, {
            projectId: pid,
            totalProfit: Number(inv.returnEarned) || 0,
            totalShares: shares,
            distributions: 0,
            ledgerProfit: 0
          });
        }
      }

      // Ledger tracks credited profit and distribution count — not share holdings.
      for (const e of entries) {
        let entry = projectMap.get(e.projectId);
        if (!entry) {
          entry = {
            projectId: e.projectId,
            totalProfit: 0,
            totalShares: 0,
            distributions: 0,
            ledgerProfit: 0
          };
          projectMap.set(e.projectId, entry);
        }
        entry.ledgerProfit += Number(e.calculatedProfit) || 0;
        entry.distributions += 1;
      }

      for (const entry of projectMap.values()) {
        entry.totalProfit = Math.max(entry.totalProfit, entry.ledgerProfit || 0);
        delete entry.ledgerProfit;
      }

      const projectIds = Array.from(projectMap.keys());
      if (projectIds.length) {
        const projects = await Project.find({ _id: { $in: projectIds } }).lean();
        for (const p of projects) {
          const entry = projectMap.get(p._id);
          if (entry) {
            entry.projectTitle = p.title;
            entry.projectCategory = p.category;
          }
        }
      }

      // Monthly breakdown
      const monthlyMap = new Map();
      for (const e of entries) {
        const key = `${e.year}-${String(e.month).padStart(2, '0')}`;
        const existing = monthlyMap.get(key);
        if (existing) {
          existing.amount += Number(e.calculatedProfit) || 0;
        } else {
          monthlyMap.set(key, { month: e.month, year: e.year, amount: Number(e.calculatedProfit) || 0 });
        }
      }

      return {
        totalEarned,
        wallet: wallet || { availableBalance: 0, pendingBalance: 0, withdrawnBalance: 0 },
        perProject: Array.from(projectMap.values()),
        monthly: Array.from(monthlyMap.values()).sort((a, b) => {
          if (a.year !== b.year) return b.year - a.year;
          return b.month - a.month;
        })
      };
    },

    deleteDistribution: async (id) => {
      // Find audit log or distribution doc by id
      let log = await AuditLog.findById(id).lean();
      let distId = id;
      if (log) {
        distId = log.metadata?.distributionId || id;
      } else {
        log = await AuditLog.findOne({ 'metadata.distributionId': id }).lean();
      }

      if (distId) {
        const ledgers = await InvestorProfitLedger.find({ distributionId: distId }).lean();
        for (const entry of ledgers) {
          if (entry.investorId && entry.calculatedProfit) {
            const wallet = await Wallet.findOne({ investorId: entry.investorId }).lean();
            if (wallet) {
              const newBal = Math.max(0, (wallet.availableBalance || 0) - entry.calculatedProfit);
              await Wallet.updateOne({ investorId: entry.investorId }, { $set: { availableBalance: newBal } });
            }
          }
          if (entry.investmentId && entry.calculatedProfit) {
            const inv = await Investment.findById(entry.investmentId).lean();
            if (inv) {
              const newEarned = Math.max(0, (inv.returnEarned || 0) - entry.calculatedProfit);
              const updatedHistory = (inv.paymentHistory || []).filter(h => h.type !== 'profit_distribution' || h.amount !== entry.calculatedProfit);
              await Investment.updateOne({ _id: entry.investmentId }, {
                $set: { returnEarned: newEarned, paymentHistory: updatedHistory }
              });
            }
          }
        }

        await InvestorProfitLedger.deleteMany({ distributionId: distId });
        await ProfitDistribution.deleteOne({ _id: distId });
      }

      // Delete matching audit log entries
      await AuditLog.deleteMany({
        $or: [{ _id: id }, { 'metadata.distributionId': distId }]
      });

      return { success: true };
    },

    populateAll: async (list) => {
      if (!list.length) return [];
      const projectIds = [...new Set(list.map(d => d.projectId))];
      const adminIds = [...new Set(list.map(d => d.createdBy).filter(Boolean))];
      const projects = await Project.find({ _id: { $in: projectIds } }).lean();
      const admins = await User.find({ _id: { $in: adminIds } }).lean();
      const pMap = new Map(projects.map(p => [p._id, p]));
      const aMap = new Map(admins.map(a => [a._id, a]));
      return list.map(d => ({
        ...d,
        project: pMap.get(d.projectId) ? {
          _id: pMap.get(d.projectId)._id,
          title: pMap.get(d.projectId).title,
          category: pMap.get(d.projectId).category
        } : null,
        admin: aMap.get(d.createdBy) ? {
          _id: aMap.get(d.createdBy)._id,
          name: aMap.get(d.createdBy).name,
          email: aMap.get(d.createdBy).email
        } : null
      }));
    }
  },

  profitSchedules: {
    find: async (query = {}) => {
      const q = {};
      if (query.status) q.status = query.status;
      if (query.projectId) q.projectId = query.projectId;
      return ProfitSchedule.find(q).sort({ createdAt: -1 }).lean();
    },
    findById: async (id) => ProfitSchedule.findById(id).lean(),
    findActiveByProject: async (projectId) =>
      ProfitSchedule.findOne({ projectId, status: 'active' }).lean(),
    create: async (payload) => {
      const active = await ProfitSchedule.findOne({ projectId: payload.projectId, status: 'active' }).lean();
      if (active) {
        throw new Error('This project already has an active profit schedule. Pause it before creating a new one.');
      }
      const now = new Date().toISOString();
      const doc = await ProfitSchedule.create({
        projectId: payload.projectId,
        cycleType: payload.cycleType === 'monthly' ? 'monthly' : 'weekly',
        profitPerShare: Number(payload.profitPerShare) || 0,
        startDate: payload.startDate,
        status: 'active',
        cyclesProcessed: 0,
        createdBy: payload.createdBy,
        createdAt: now,
        updatedAt: now
      });
      return doc.toObject();
    },
    updateStatus: async (id, status) =>
      ProfitSchedule.findByIdAndUpdate(id, { $set: { status, updatedAt: new Date().toISOString() } }, { new: true }).lean(),
    incrementCyclesProcessed: async (id) =>
      ProfitSchedule.findByIdAndUpdate(
        id,
        { $inc: { cyclesProcessed: 1 }, $set: { updatedAt: new Date().toISOString() } },
        { new: true }
      ).lean()
  },

  wallets: {
    getOrCreate: async (investorId) => {
      let wallet = await Wallet.findOne({ investorId }).lean();
      if (!wallet) {
        const now = new Date().toISOString();
        const doc = await Wallet.create({
          investorId,
          availableBalance: 0,
          pendingBalance: 0,
          withdrawnBalance: 0,
          createdAt: now,
          updatedAt: now
        });
        wallet = doc.toObject();
      }
      return wallet;
    },
    getByInvestorId: async (investorId) => {
      return Wallet.findOne({ investorId }).lean();
    },
    credit: async (investorId, amount) => {
      const now = new Date().toISOString();
      return Wallet.findOneAndUpdate(
        { investorId },
        {
          $inc: { availableBalance: amount },
          $set: { updatedAt: now },
          $setOnInsert: { investorId, pendingBalance: 0, withdrawnBalance: 0, createdAt: now }
        },
        { upsert: true, new: true }
      ).lean();
    }
  },

  auditLog: {
    create: async (entry) => {
      const doc = await AuditLog.create({
        action: entry.action,
        performedBy: entry.performedBy,
        targetUserId: entry.targetUserId || '',
        metadata: entry.metadata || {},
        createdAt: new Date().toISOString()
      });
      return doc.toObject();
    },
    find: async (query = {}) => {
      const q = {};
      if (query.action) q.action = query.action;
      if (query.performedBy) q.performedBy = query.performedBy;
      return AuditLog.find(q).sort({ createdAt: -1 }).lean();
    }
  },

  adminStats: {
    getDashboard: async () => {
      const [projects, interests, investors, investments, withdrawals, distributions, schedules] =
        await Promise.all([
          Project.find({}).lean(),
          Interest.find({}).lean(),
          User.find({ role: 'investor' }).lean(),
          Investment.find({}).lean(),
          Withdrawal.find({}).lean(),
          ProfitDistribution.find({ status: 'completed' }).lean(),
          ProfitSchedule.find({ status: 'active' }).lean()
        ]);

      const investedStatuses = ['active', 'completed', 'pending'];
      const totalInvested = investments
        .filter(i => investedStatuses.includes(i.status))
        .reduce((s, i) => s + (Number(i.amount) || 0), 0);
      const totalShares = investments
        .filter(i => ['active', 'completed'].includes(i.status))
        .reduce((s, i) => s + (Number(i.sharesCount) || 0), 0);
      const activeInvestments = investments.filter(i => i.status === 'active').length;
      const investorsWithInvestment = new Set(investments.map(i => i.investorId).filter(Boolean)).size;

      const distributedFromCycles = distributions
        .reduce((s, d) => s + (Number(d.totalDistributed) || 0), 0);
      const creditedToInvestments = investments
        .reduce((s, i) => s + (Number(i.returnEarned) || 0), 0);
      const totalProfitDistributed = Math.max(distributedFromCycles, creditedToInvestments);

      const pendingList = withdrawals.filter(w => ['pending', 'approved', 'processing'].includes(w.status));
      const pendingWithdrawalAmount = pendingList.reduce((s, w) => s + (Number(w.amount) || 0), 0);
      const totalWithdrawn = withdrawals
        .filter(w => w.status === 'completed')
        .reduce((s, w) => s + (Number(w.amount) || 0), 0);
      const totalWalletAvailable = Math.max(
        0,
        totalProfitDistributed - totalWithdrawn - pendingWithdrawalAmount
      );

      const interestStatus = { pending: 0, reviewed: 0, contacted: 0, closed: 0 };
      interests.forEach((i) => {
        const s = (i.status || 'pending').toLowerCase();
        interestStatus[s] = (interestStatus[s] || 0) + 1;
      });

      const categoryMap = {};
      projects.forEach((p) => {
        const key = (p.category || 'Other').split('(')[0].trim() || 'Other';
        const short = key.length > 22 ? `${key.slice(0, 20)}…` : key;
        categoryMap[short] = (categoryMap[short] || 0) + 1;
      });

      return {
        totalProjects: projects.length,
        openProjects: projects.filter(p => p.status === 'open').length,
        totalInvestors: investors.length,
        activeInvestors: investorsWithInvestment,
        interestRequests: interests.length,
        totalInvested,
        totalShares,
        activeInvestments,
        totalProfitDistributed,
        totalWalletAvailable,
        totalWithdrawn,
        pendingWithdrawals: pendingList.length,
        pendingWithdrawalAmount,
        activeProfitSchedules: schedules.length,
        categoryBreakdown: Object.entries(categoryMap).map(([label, count]) => ({ label, count })),
        interestStatusBreakdown: Object.entries(interestStatus).map(([label, count]) => ({ label, count }))
      };
    }
  }
};

module.exports = DB;
