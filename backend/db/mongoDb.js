const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const {
  generateId, User, Project, Interest, Investment, Withdrawal, Payout
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

const initDb = async () => {
  await connect();

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
    // Verify existing admin password is correct; reset if it doesn't match.
    const passwordOk = await bcrypt.compare(adminPassword, adminExists.password);
    if (!passwordOk) {
      await User.updateOne(
        { email: adminEmail },
        { $set: { password: await bcrypt.hash(adminPassword, 10) } }
      );
      console.log(`Admin password was out of sync — reset to match ADMIN_PASSWORD / default.`);
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
    create: async (interestData) => {
      const doc = await Interest.create({
        investor: interestData.investor,
        project: interestData.project,
        amountIntended: Number(interestData.amountIntended) || 0,
        message: interestData.message || '',
        status: 'pending',
        submittedAt: new Date().toISOString()
      });
      return doc.toObject();
    },
    findByIdAndUpdate: async (id, updateData) =>
      Interest.findByIdAndUpdate(id, { $set: updateData }, { new: true }).lean(),
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
      // createdAt||startDate fallback can't be expressed in a Mongo sort.
      return data.sort((a, b) =>
        new Date(b.createdAt || b.startDate) - new Date(a.createdAt || a.startDate));
    },
    findById: async (id) => Investment.findById(id).lean(),
    create: async (payload) => {
      const amount = Number(payload.amount) || 0;
      const roi = Number(payload.roi) || 0;
      const durationMonths = parseDurationMonths(payload.duration);
      const startDate = payload.startDate || new Date().toISOString();
      const maturityDate = payload.maturityDate || addMonths(startDate, durationMonths);
      const expectedReturn = payload.expectedReturn != null
        ? Number(payload.expectedReturn)
        : calcExpectedReturn(amount, roi);

      const doc = await Investment.create({
        investorId: payload.investorId,
        projectId: payload.projectId,
        amount,
        sharesCount: Number(payload.sharesCount || payload.shares) || 0,
        roi,
        duration: durationMonths || payload.duration || 0,
        durationLabel: payload.durationLabel
          || (durationMonths ? `${durationMonths} Months` : String(payload.duration || '')),
        startDate,
        maturityDate,
        expectedReturn,
        returnEarned: Number(payload.returnEarned) || 0,
        status: payload.status || 'active',
        paymentHistory: payload.paymentHistory || [
          { type: 'investment', label: 'Initial Investment Allocated', amount, date: startDate }
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
      const investments = await Investment.find({ investorId }).lean();
      const withdrawals = await Withdrawal.find({ investorId }).lean();

      const totalInvested = investments
        .filter(i => ['active', 'completed', 'pending'].includes(i.status))
        .reduce((s, i) => s + (Number(i.amount) || 0), 0);

      const activeInvestments = investments.filter(i => i.status === 'active').length;

      const totalReturnEarned = investments.reduce((s, i) => {
        const earned = Number(i.returnEarned) || 0;
        if (earned > 0) return s + earned;
        if (i.status === 'completed') return s + (Number(i.expectedReturn) || 0);
        return s;
      }, 0);

      const expectedReturnActive = investments
        .filter(i => i.status === 'active')
        .reduce((s, i) => s + (Number(i.expectedReturn) || 0), 0);

      const pendingWithdrawals = withdrawals
        .filter(w => ['pending', 'approved', 'processing'].includes(w.status))
        .reduce((s, w) => s + (Number(w.amount) || 0), 0);

      const reserved = withdrawals
        .filter(w => ['pending', 'approved', 'processing', 'completed'].includes(w.status))
        .reduce((s, w) => s + (Number(w.amount) || 0), 0);

      const availableBalance = Math.max(0, totalReturnEarned - reserved);

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
    findByIdAndUpdate: async (id, updateData) =>
      Withdrawal.findByIdAndUpdate(
        id,
        { $set: { ...updateData, updatedAt: new Date().toISOString() } },
        { new: true }
      ).lean(),
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
        amount,
        monthYear: payload.monthYear || '',
        paymentMethod: payload.paymentMethod || 'Bank Transfer',
        referenceNo: payload.referenceNo || '',
        screenshotUrl: payload.screenshotUrl || '',
        notes: payload.notes || '',
        payoutDate,
        createdAt: new Date().toISOString()
      });

      // Increment the investment's earned balance atomically.
      if (payload.investmentId) {
        await Investment.updateOne(
          { _id: payload.investmentId },
          {
            $inc: { returnEarned: amount },
            $push: {
              paymentHistory: {
                type: 'profit_payout',
                label: `Profit Payout (${payload.monthYear || 'Monthly'})`,
                amount,
                date: payoutDate,
                screenshotUrl: payload.screenshotUrl || ''
              }
            }
          }
        );
      }
      return doc.toObject();
    },
    findByIdAndDelete: async (id) => {
      const item = await Payout.findByIdAndDelete(id).lean();
      if (!item) return null;

      if (item.investmentId) {
        const inv = await Investment.findById(item.investmentId).lean();
        if (inv) {
          const next = Math.max(0, (Number(inv.returnEarned) || 0) - Number(item.amount || 0));
          await Investment.updateOne(
            { _id: item.investmentId },
            { $set: { returnEarned: next } }
          );
        }
      }
      return item;
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
  }
};

module.exports = DB;
