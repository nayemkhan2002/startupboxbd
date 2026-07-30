const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

// Data lives outside the deploy tree in production so releases never overwrite it.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const getFilePath = (collection) => path.join(DATA_DIR, `${collection}.json`);

const readCollection = (collection) => {
  const file = getFilePath(collection);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify([]), 'utf8');
    return [];
  }
  try {
    const data = fs.readFileSync(file, 'utf8');
    return JSON.parse(data || '[]');
  } catch (e) {
    return [];
  }
};

const writeCollection = (collection, data) => {
  const file = getFilePath(collection);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
};

const generateId = () => Math.random().toString(36).substring(2, 11) + Date.now().toString(36);

const stripPassword = (user) => {
  if (!user) return null;
  const { password, ...rest } = user;
  return rest;
};

const addMonths = (dateStr, months) => {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + (Number(months) || 0));
  return d.toISOString();
};

const parseDurationMonths = (duration) => {
  if (duration == null || duration === '') return 0;
  if (typeof duration === 'number') return duration;
  const match = String(duration).match(/(\d+)/);
  return match ? Number(match[1]) : 0;
};

const calcExpectedReturn = (amount, roi) => {
  const amt = Number(amount) || 0;
  const r = Number(roi);
  if (Number.isNaN(r)) return 0;
  // ROI stored as percent e.g. 18 => 18% of amount
  return Math.round(amt * (r / 100));
};

const initDb = async () => {
  const users = readCollection('users');
  let updated = false;

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@startupboxbd.com';
  const adminExists = users.find(u => u.email === adminEmail);
  if (!adminExists) {
    if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
      console.warn('⚠️  ADMIN_PASSWORD not set — seeding admin with default password. Set ADMIN_PASSWORD in production!');
    }
    const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'password123', 10);
    users.push({
      _id: 'admin_id_default',
      name: 'Admin',
      email: adminEmail,
      password: hashedPassword,
      role: 'admin',
      phone: '',
      address: '',
      profileImage: '',
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
    updated = true;
    console.log('Seeded Admin user (admin@startupboxbd.com / password123)');
  }

  // Demo investor is a local-development convenience only.
  const investorExists = users.find(u => u.email === 'investor@startupboxbd.com');
  if (!investorExists && process.env.NODE_ENV !== 'production') {
    const hashedPassword = await bcrypt.hash('password123', 10);
    users.push({
      _id: 'investor_id_default',
      name: 'Demo Investor',
      email: 'investor@startupboxbd.com',
      password: hashedPassword,
      role: 'investor',
      phone: '01700000000',
      address: 'Dhaka, Bangladesh',
      profileImage: '',
      bankInfo: {
        method: 'bkash',
        bkashNumber: '01700000000',
        bkashAccountType: 'Personal',
        bankName: '',
        accountName: '',
        accountNumber: '',
        branch: '',
        routingNumber: ''
      },
      createdAt: new Date().toISOString()
    });
    updated = true;
    console.log('Seeded Investor user (investor@startupboxbd.com / password123)');
  }

  if (updated) {
    writeCollection('users', users);
  }

  // Ensure investment / withdrawal / payout collections exist
  readCollection('investments');
  readCollection('withdrawals');
  readCollection('payouts');
};

const DB = {
  initDb,
  users: {
    find: async (query = {}) => {
      let data = readCollection('users');
      if (query.email) data = data.filter(u => u.email === query.email);
      if (query.role) data = data.filter(u => u.role === query.role);
      return data;
    },
    findOne: async (query = {}) => {
      const data = readCollection('users');
      return data.find(u => u.email === query.email) || null;
    },
    findById: async (id) => {
      const data = readCollection('users');
      const user = data.find(u => u._id === id);
      if (!user) return null;
      return {
        ...user,
        select: (fields) => {
          if (fields.includes('-password')) return stripPassword(user);
          return user;
        }
      };
    },
    create: async (userData) => {
      const users = readCollection('users');
      const hashedPassword = await bcrypt.hash(userData.password, 10);
      const newUser = {
        _id: generateId(),
        name: userData.name,
        email: userData.email,
        password: hashedPassword,
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
      };
      users.push(newUser);
      writeCollection('users', users);
      return newUser;
    },
    findByIdAndUpdate: async (id, updateData) => {
      const users = readCollection('users');
      const index = users.findIndex(u => u._id === id);
      if (index === -1) return null;
      const allowed = { ...updateData };
      delete allowed.password;
      delete allowed.role;
      delete allowed._id;
      delete allowed.email;
      if (allowed.bankInfo) {
        users[index].bankInfo = { ...(users[index].bankInfo || {}), ...allowed.bankInfo };
        delete allowed.bankInfo;
      }
      users[index] = { ...users[index], ...allowed };
      writeCollection('users', users);
      return stripPassword(users[index]);
    },
    updatePassword: async (id, currentPassword, newPassword) => {
      const users = readCollection('users');
      const index = users.findIndex(u => u._id === id);
      if (index === -1) return { ok: false, message: 'User not found' };
      const match = await bcrypt.compare(currentPassword, users[index].password);
      if (!match) return { ok: false, message: 'Current password is incorrect' };
      users[index].password = await bcrypt.hash(newPassword, 10);
      writeCollection('users', users);
      return { ok: true };
    },
    matchPassword: async (enteredPassword, hashedPassword) => {
      return await bcrypt.compare(enteredPassword, hashedPassword);
    },
    listInvestors: async () => {
      return readCollection('users')
        .filter(u => u.role === 'investor')
        .map(stripPassword);
    }
  },
  projects: {
    find: async (query = {}) => {
      let data = readCollection('projects');
      if (query.status) {
        data = data.filter(p => p.status === query.status);
      }
      return data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
    findById: async (id) => {
      const data = readCollection('projects');
      return data.find(p => p._id === id) || null;
    },
    create: async (projectData) => {
      const projects = readCollection('projects');
      const newProject = {
        _id: generateId(),
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
      };
      projects.push(newProject);
      writeCollection('projects', projects);
      return newProject;
    },
    findByIdAndUpdate: async (id, updateData) => {
      const projects = readCollection('projects');
      const index = projects.findIndex(p => p._id === id);
      if (index === -1) return null;
      projects[index] = { ...projects[index], ...updateData };
      writeCollection('projects', projects);
      return projects[index];
    },
    findByIdAndDelete: async (id) => {
      let projects = readCollection('projects');
      const project = projects.find(p => p._id === id);
      if (!project) return null;
      projects = projects.filter(p => p._id !== id);
      writeCollection('projects', projects);
      return project;
    }
  },
  interests: {
    find: async (query = {}) => {
      let data = readCollection('interests');
      if (query.investor) {
        data = data.filter(i => i.investor === query.investor || (i.investor && i.investor._id === query.investor));
      }
      return data.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    },
    create: async (interestData) => {
      const interests = readCollection('interests');
      const newInterest = {
        _id: generateId(),
        investor: interestData.investor,
        project: interestData.project,
        amountIntended: Number(interestData.amountIntended) || 0,
        message: interestData.message || '',
        status: 'pending',
        submittedAt: new Date().toISOString()
      };
      interests.push(newInterest);
      writeCollection('interests', interests);
      return newInterest;
    },
    findByIdAndUpdate: async (id, updateData) => {
      const interests = readCollection('interests');
      const index = interests.findIndex(i => i._id === id);
      if (index === -1) return null;
      interests[index] = { ...interests[index], ...updateData };
      writeCollection('interests', interests);
      return interests[index];
    },
    populateAll: async (interestsList) => {
      const users = readCollection('users');
      const projects = readCollection('projects');
      return interestsList.map(item => {
        const inv = users.find(u => u._id === item.investor);
        const proj = projects.find(p => p._id === item.project);
        return {
          ...item,
          investor: inv ? { _id: inv._id, name: inv.name, email: inv.email } : null,
          project: proj ? { _id: proj._id, title: proj.title, category: proj.category, thumbnail: proj.thumbnail } : null
        };
      });
    }
  },
  investments: {
    find: async (query = {}) => {
      let data = readCollection('investments');
      if (query.investorId) data = data.filter(i => i.investorId === query.investorId);
      if (query.projectId) data = data.filter(i => i.projectId === query.projectId);
      if (query.status) data = data.filter(i => i.status === query.status);
      return data.sort((a, b) => new Date(b.createdAt || b.startDate) - new Date(a.createdAt || a.startDate));
    },
    findById: async (id) => {
      const data = readCollection('investments');
      return data.find(i => i._id === id) || null;
    },
    create: async (payload) => {
      const investments = readCollection('investments');
      const amount = Number(payload.amount) || 0;
      const roi = Number(payload.roi) || 0;
      const durationMonths = parseDurationMonths(payload.duration);
      const startDate = payload.startDate || new Date().toISOString();
      const maturityDate = payload.maturityDate || addMonths(startDate, durationMonths);
      const expectedReturn = payload.expectedReturn != null
        ? Number(payload.expectedReturn)
        : calcExpectedReturn(amount, roi);

      const newItem = {
        _id: generateId(),
        investorId: payload.investorId,
        projectId: payload.projectId,
        amount,
        sharesCount: Number(payload.sharesCount || payload.shares) || 0,
        roi,
        duration: durationMonths || payload.duration || 0,
        durationLabel: payload.durationLabel || (durationMonths ? `${durationMonths} Months` : String(payload.duration || '')),
        startDate,
        maturityDate,
        expectedReturn,
        returnEarned: Number(payload.returnEarned) || 0,
        status: payload.status || 'active',
        paymentHistory: payload.paymentHistory || [
          {
            type: 'investment',
            label: 'Initial Investment Allocated',
            amount,
            date: startDate
          }
        ],
        timeline: payload.timeline || [
          { key: 'approved', label: 'Investment Approved', date: startDate, done: true },
          { key: 'started', label: 'Business Started', date: startDate, done: true },
          { key: 'profit', label: 'Profit Generated', date: null, done: false },
          { key: 'completed', label: 'Completed', date: null, done: false }
        ],
        notes: payload.notes || '',
        createdAt: new Date().toISOString()
      };
      investments.push(newItem);
      writeCollection('investments', investments);

      // bump project raisedAmount
      const projects = readCollection('projects');
      const pIdx = projects.findIndex(p => p._id === payload.projectId);
      if (pIdx !== -1) {
        projects[pIdx].raisedAmount = Number(projects[pIdx].raisedAmount || 0) + amount;
        writeCollection('projects', projects);
      }

      return newItem;
    },
    findByIdAndUpdate: async (id, updateData) => {
      const investments = readCollection('investments');
      const index = investments.findIndex(i => i._id === id);
      if (index === -1) return null;
      const next = { ...investments[index], ...updateData };
      if (updateData.amount != null || updateData.roi != null) {
        const amount = Number(next.amount) || 0;
        const roi = Number(next.roi) || 0;
        if (updateData.expectedReturn == null) {
          next.expectedReturn = calcExpectedReturn(amount, roi);
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
      investments[index] = next;
      writeCollection('investments', investments);
      return investments[index];
    },
    findByIdAndDelete: async (id) => {
      let investments = readCollection('investments');
      const item = investments.find(i => i._id === id);
      if (!item) return null;
      investments = investments.filter(i => i._id !== id);
      writeCollection('investments', investments);
      return item;
    },
    populateAll: async (list) => {
      const users = readCollection('users');
      const projects = readCollection('projects');
      return list.map(item => {
        const inv = users.find(u => u._id === item.investorId);
        const proj = projects.find(p => p._id === item.projectId);
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
      const investments = readCollection('investments').filter(i => i.investorId === investorId);
      const withdrawals = readCollection('withdrawals').filter(w => w.investorId === investorId);

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
      let data = readCollection('withdrawals');
      if (query.investorId) data = data.filter(w => w.investorId === query.investorId);
      if (query.status) data = data.filter(w => w.status === query.status);
      return data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
    findById: async (id) => {
      const data = readCollection('withdrawals');
      return data.find(w => w._id === id) || null;
    },
    create: async (payload) => {
      const withdrawals = readCollection('withdrawals');
      const newItem = {
        _id: generateId(),
        investorId: payload.investorId,
        amount: Number(payload.amount) || 0,
        method: payload.method, // bkash | bank
        paymentInfo: payload.paymentInfo || {},
        status: 'pending',
        adminNote: '',
        createdAt: new Date().toISOString()
      };
      withdrawals.push(newItem);
      writeCollection('withdrawals', withdrawals);
      return newItem;
    },
    findByIdAndUpdate: async (id, updateData) => {
      const withdrawals = readCollection('withdrawals');
      const index = withdrawals.findIndex(w => w._id === id);
      if (index === -1) return null;
      withdrawals[index] = {
        ...withdrawals[index],
        ...updateData,
        updatedAt: new Date().toISOString()
      };
      writeCollection('withdrawals', withdrawals);
      return withdrawals[index];
    },
    populateAll: async (list) => {
      const users = readCollection('users');
      return list.map(item => {
        const inv = users.find(u => u._id === item.investorId);
        return {
          ...item,
          investor: inv ? { _id: inv._id, name: inv.name, email: inv.email, phone: inv.phone || '' } : null
        };
      });
    }
  },
  payouts: {
    find: async (query = {}) => {
      let data = readCollection('payouts');
      if (query.investorId) data = data.filter(p => p.investorId === query.investorId);
      if (query.investmentId) data = data.filter(p => p.investmentId === query.investmentId);
      if (query.projectId) data = data.filter(p => p.projectId === query.projectId);
      return data.sort((a, b) => new Date(b.payoutDate || b.createdAt) - new Date(a.payoutDate || a.createdAt));
    },
    findById: async (id) => {
      const data = readCollection('payouts');
      return data.find(p => p._id === id) || null;
    },
    create: async (payload) => {
      const payouts = readCollection('payouts');
      const amount = Number(payload.amount) || 0;
      const newItem = {
        _id: generateId(),
        investorId: payload.investorId,
        investmentId: payload.investmentId || '',
        projectId: payload.projectId || '',
        amount,
        monthYear: payload.monthYear || '',
        paymentMethod: payload.paymentMethod || 'Bank Transfer',
        referenceNo: payload.referenceNo || '',
        screenshotUrl: payload.screenshotUrl || '',
        notes: payload.notes || '',
        payoutDate: payload.payoutDate || new Date().toISOString(),
        createdAt: new Date().toISOString()
      };
      payouts.push(newItem);
      writeCollection('payouts', payouts);

      // Increment investment's returnEarned balance
      if (payload.investmentId) {
        const investments = readCollection('investments');
        const idx = investments.findIndex(i => i._id === payload.investmentId);
        if (idx !== -1) {
          investments[idx].returnEarned = (Number(investments[idx].returnEarned) || 0) + amount;
          investments[idx].paymentHistory = investments[idx].paymentHistory || [];
          investments[idx].paymentHistory.push({
            type: 'profit_payout',
            label: `Profit Payout (${payload.monthYear || 'Monthly'})`,
            amount,
            date: newItem.payoutDate,
            screenshotUrl: newItem.screenshotUrl
          });
          writeCollection('investments', investments);
        }
      }

      return newItem;
    },
    findByIdAndDelete: async (id) => {
      let payouts = readCollection('payouts');
      const item = payouts.find(p => p._id === id);
      if (!item) return null;
      payouts = payouts.filter(p => p._id !== id);
      writeCollection('payouts', payouts);

      // Decrement investment's returnEarned
      if (item.investmentId) {
        const investments = readCollection('investments');
        const idx = investments.findIndex(i => i._id === item.investmentId);
        if (idx !== -1) {
          investments[idx].returnEarned = Math.max(0, (Number(investments[idx].returnEarned) || 0) - Number(item.amount || 0));
          writeCollection('investments', investments);
        }
      }

      return item;
    },
    populateAll: async (list) => {
      const users = readCollection('users');
      const projects = readCollection('projects');
      const investments = readCollection('investments');
      return list.map(item => {
        const inv = users.find(u => u._id === item.investorId);
        const proj = projects.find(p => p._id === item.projectId);
        const investment = investments.find(i => i._id === item.investmentId);
        return {
          ...item,
          investor: inv ? { _id: inv._id, name: inv.name, email: inv.email, phone: inv.phone || '' } : null,
          project: proj ? { _id: proj._id, title: proj.title, category: proj.category, thumbnail: proj.thumbnail } : null,
          investment: investment ? { _id: investment._id, amount: investment.amount, sharesCount: investment.sharesCount } : null
        };
      });
    }
  }
};

module.exports = DB;
