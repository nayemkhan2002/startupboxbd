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
  } else {
    // Verify existing admin password is correct; reset if it doesn't match.
    const adminPassword = process.env.ADMIN_PASSWORD || 'password123';
    const passwordOk = await bcrypt.compare(adminPassword, adminExists.password);
    if (!passwordOk) {
      adminExists.password = await bcrypt.hash(adminPassword, 10);
      updated = true;
      console.log('Admin password was out of sync — reset to match ADMIN_PASSWORD / default.');
    }
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

  // Ensure investment / withdrawal / payout / distribution collections exist
  readCollection('investments');
  readCollection('withdrawals');
  readCollection('payouts');
  readCollection('distributions');
  readCollection('profitLedger');
  readCollection('profitSchedules');
  readCollection('wallets');
  readCollection('auditLog');
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
      return data.find(u => {
        for (const [k, v] of Object.entries(query)) {
          if (u[k] !== v) return false;
        }
        return true;
      }) || null;
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
    resetPassword: async (id, newPassword) => {
      const users = readCollection('users');
      const index = users.findIndex(u => u._id === id);
      if (index === -1) return { ok: false, message: 'User not found' };
      users[index].password = await bcrypt.hash(newPassword, 10);
      delete users[index].resetPasswordToken;
      delete users[index].resetPasswordExpires;
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
    },
    listInvestorsWithStats: async () => {
      const investors = readCollection('users').filter(u => u.role === 'investor');
      const investments = readCollection('investments');

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
      const user = readCollection('users').find(u => u._id === id && u.role === 'investor');
      if (!user) return null;
      const investments = readCollection('investments').filter(i => i.investorId === id);
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
      const users = readCollection('users');
      const index = users.findIndex(u => u._id === id);
      if (index === -1) return null;
      if (users[index].role === 'admin') return null;
      const current = users[index].accountStatus || 'active';
      users[index].accountStatus = current === 'suspended' ? 'active' : 'suspended';
      writeCollection('users', users);
      return stripPassword(users[index]);
    },
    deleteUser: async (id) => {
      const users = readCollection('users');
      const index = users.findIndex(u => u._id === id);
      if (index === -1) return null;
      if (users[index].role === 'admin') return null;
      const removed = users.splice(index, 1)[0];
      writeCollection('users', users);
      return stripPassword(removed);
    },
    deleteAdmin: async (id, requesterId) => {
      if (id === requesterId) return null;
      const users = readCollection('users');
      const index = users.findIndex(u => u._id === id && u.role === 'admin');
      if (index === -1) return null;
      const removed = users.splice(index, 1)[0];
      writeCollection('users', users);
      return stripPassword(removed);
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
      if (!interestsList || !interestsList.length) return [];
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

      const newItem = {
        _id: generateId(),
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
          {
            type: 'investment',
            label: 'Initial Investment Allocated',
            amount,
            date: startDate || new Date().toISOString()
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
      const ledger = readCollection('profitLedger').filter(e => e.investorId === investorId);

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

      const prev = withdrawals[index];
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

        const wallets = readCollection('wallets');
        let wIdx = wallets.findIndex(w => w.investorId === prev.investorId);
        if (wIdx === -1) {
          wallets.push({
            _id: generateId(),
            investorId: prev.investorId,
            availableBalance: 0,
            pendingBalance: 0,
            withdrawnBalance: 0,
            createdAt: now,
            updatedAt: now
          });
          wIdx = wallets.length - 1;
        }
        const avail = Number(wallets[wIdx].availableBalance) || 0;
        wallets[wIdx].availableBalance = Math.max(0, avail - amt);
        wallets[wIdx].withdrawnBalance = (Number(wallets[wIdx].withdrawnBalance) || 0) + amt;
        wallets[wIdx].updatedAt = now;
        writeCollection('wallets', wallets);

        const payoutList = readCollection('payouts');
        if (!payoutList.some(p => p.withdrawalId === id)) {
          payoutList.push({
            _id: generateId(),
            investorId: prev.investorId,
            investmentId: '',
            projectId: '',
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
          writeCollection('payouts', payoutList);
        }
        updateData.completedAt = now;
      }

      withdrawals[index] = {
        ...prev,
        ...updateData,
        updatedAt: now
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
        withdrawalId: payload.withdrawalId || '',
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
      return newItem;
    },
    findByIdAndDelete: async (id) => {
      let payouts = readCollection('payouts');
      const item = payouts.find(p => p._id === id);
      if (!item) return null;
      payouts = payouts.filter(p => p._id !== id);
      writeCollection('payouts', payouts);
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
  },

  profitImages: {
    find: async () => {
      return readCollection('profitImages')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
    create: async (data) => {
      const items = readCollection('profitImages');
      const newItem = {
        _id: generateId(),
        imageUrl: data.imageUrl,
        caption: data.caption || '',
        createdAt: new Date().toISOString()
      };
      items.push(newItem);
      writeCollection('profitImages', items);
      return newItem;
    },
    findByIdAndDelete: async (id) => {
      let items = readCollection('profitImages');
      const item = items.find(i => i._id === id);
      if (!item) return null;
      items = items.filter(i => i._id !== id);
      writeCollection('profitImages', items);
      return item;
    }
  },

  // ─── Profit Distribution System ─────────────────────────────
  distributions: {
    preview: async (projectId, profitPerShare) => {
      const allInvestments = readCollection('investments');
      const investments = allInvestments.filter(i =>
        i.projectId === projectId && ['active', 'completed'].includes(i.status)
      );

      if (!investments.length) return { investors: [], totalShares: 0, totalInvestors: 0, grandTotal: 0 };

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

      const users = readCollection('users');
      const investors = [];
      let totalShares = 0;
      let grandTotal = 0;
      for (const [id, data] of investorMap) {
        const user = users.find(u => u._id === id);
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

      return { investors, totalShares, totalInvestors: investors.length, grandTotal };
    },

    confirm: async (projectId, profitPerShare, month, year, adminId, distributionDate) => {
      const distributions = readCollection('distributions');
      const existing = distributions.find(d =>
        d.projectId === projectId && d.month === month && d.year === year && !d.scheduleId
      );
      if (existing) {
        throw new Error(`Profit already distributed for this project for ${month}/${year}`);
      }

      const preview = await DB.distributions.preview(projectId, profitPerShare);
      if (!preview.investors.length) {
        throw new Error('No investors with shares found for this project');
      }

      const now = distributionDate ? new Date(distributionDate).toISOString() : new Date().toISOString();

      // 1. Create distribution record
      const distribution = {
        _id: generateId(),
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
      };
      distributions.push(distribution);
      writeCollection('distributions', distributions);

      // 2. Create ledger entries
      const ledger = readCollection('profitLedger');
      for (const inv of preview.investors) {
        for (const invDetail of inv.investments) {
          const profit = invDetail.shares * profitPerShare;
          ledger.push({
            _id: generateId(),
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
      writeCollection('profitLedger', ledger);

      // 3. Update wallets and investments
      const wallets = readCollection('wallets');
      const investments = readCollection('investments');

      for (const inv of preview.investors) {
        // Wallet
        let walletIdx = wallets.findIndex(w => w.investorId === inv.investorId);
        if (walletIdx === -1) {
          wallets.push({
            _id: generateId(),
            investorId: inv.investorId,
            availableBalance: 0,
            pendingBalance: 0,
            withdrawnBalance: 0,
            createdAt: now,
            updatedAt: now
          });
          walletIdx = wallets.length - 1;
        }
        wallets[walletIdx].availableBalance = (Number(wallets[walletIdx].availableBalance) || 0) + inv.calculatedProfit;
        wallets[walletIdx].updatedAt = now;

        // Investment returnEarned
        for (const invDetail of inv.investments) {
          const profit = invDetail.shares * profitPerShare;
          const invIdx = investments.findIndex(i => i._id === invDetail.investmentId);
          if (invIdx !== -1) {
            investments[invIdx].returnEarned = (Number(investments[invIdx].returnEarned) || 0) + profit;
            investments[invIdx].profitNotAssigned = false;
            investments[invIdx].paymentHistory = investments[invIdx].paymentHistory || [];
            investments[invIdx].paymentHistory.push({
              type: 'profit_distribution',
              label: `Profit Distribution (${month}/${year})`,
              amount: profit,
              date: now
            });
          }
        }
      }
      writeCollection('wallets', wallets);
      writeCollection('investments', investments);

      // 4. Audit log
      const auditLogs = readCollection('auditLog');
      auditLogs.push({
        _id: generateId(),
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
      });
      writeCollection('auditLog', auditLogs);

      return distribution;
    },

    confirmScheduledCycle: async (payload) => {
      const {
        scheduleId, projectId, profitPerShare, cycleNumber, cycleType,
        periodStart, periodEnd, month, year, adminId, distributionDate
      } = payload;

      const distributions = readCollection('distributions');
      const existing = distributions.find(d =>
        d.scheduleId === scheduleId && d.cycleNumber === cycleNumber
      );
      if (existing) return existing;

      const preview = await DB.distributions.preview(projectId, profitPerShare);
      // A project with no share-holding investors is a valid no-op: the cycle is
      // still consumed so the schedule keeps advancing instead of retrying forever.
      if (!preview.investors.length) return null;

      const now = distributionDate ? new Date(distributionDate).toISOString() : new Date().toISOString();
      const cycleLabel = cycleType === 'monthly' ? 'Monthly' : 'Weekly';

      const distribution = {
        _id: generateId(),
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
      };
      distributions.push(distribution);
      writeCollection('distributions', distributions);

      const ledger = readCollection('profitLedger');
      for (const inv of preview.investors) {
        for (const invDetail of inv.investments) {
          const profit = invDetail.shares * profitPerShare;
          ledger.push({
            _id: generateId(),
            distributionId: distribution._id,
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
      writeCollection('profitLedger', ledger);

      const wallets = readCollection('wallets');
      const investments = readCollection('investments');

      for (const inv of preview.investors) {
        let walletIdx = wallets.findIndex(w => w.investorId === inv.investorId);
        if (walletIdx === -1) {
          wallets.push({
            _id: generateId(),
            investorId: inv.investorId,
            availableBalance: 0,
            pendingBalance: 0,
            withdrawnBalance: 0,
            createdAt: now,
            updatedAt: now
          });
          walletIdx = wallets.length - 1;
        }
        wallets[walletIdx].availableBalance = (Number(wallets[walletIdx].availableBalance) || 0) + inv.calculatedProfit;
        wallets[walletIdx].updatedAt = now;

        for (const invDetail of inv.investments) {
          const profit = invDetail.shares * profitPerShare;
          const invIdx = investments.findIndex(i => i._id === invDetail.investmentId);
          if (invIdx !== -1) {
            investments[invIdx].returnEarned = (Number(investments[invIdx].returnEarned) || 0) + profit;
            investments[invIdx].profitNotAssigned = false;
            investments[invIdx].paymentHistory = investments[invIdx].paymentHistory || [];
            investments[invIdx].paymentHistory.push({
              type: 'profit_distribution',
              label: `${cycleLabel} Profit — Cycle ${cycleNumber} (${periodStart} → ${periodEnd})`,
              amount: profit,
              date: now
            });
          }
        }
      }
      writeCollection('wallets', wallets);
      writeCollection('investments', investments);

      const auditLogs = readCollection('auditLog');
      auditLogs.push({
        _id: generateId(),
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
      });
      writeCollection('auditLog', auditLogs);

      return distribution;
    },

    find: async (query = {}) => {
      let data = readCollection('distributions');
      if (query.projectId) data = data.filter(d => d.projectId === query.projectId);
      if (query.month) data = data.filter(d => d.month === Number(query.month));
      if (query.year) data = data.filter(d => d.year === Number(query.year));
      return data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },

    findById: async (id) => {
      const data = readCollection('distributions');
      return data.find(d => d._id === id) || null;
    },

    deleteDistribution: async (id) => {
      const auditLogs = readCollection('auditLog');
      let log = auditLogs.find(l => l._id === id);
      let distId = id;
      if (log) {
        distId = log.metadata?.distributionId || id;
      } else {
        log = auditLogs.find(l => l.metadata?.distributionId === id);
      }

      if (distId) {
        const ledger = readCollection('profitLedger');
        const affectedEntries = ledger.filter(e => e.distributionId === distId);

        // Revert Wallets and Investments
        const wallets = readCollection('wallets');
        const investments = readCollection('investments');

        for (const entry of affectedEntries) {
          if (entry.investorId && entry.calculatedProfit) {
            const wIdx = wallets.findIndex(w => w.investorId === entry.investorId);
            if (wIdx !== -1) {
              wallets[wIdx].availableBalance = Math.max(0, (Number(wallets[wIdx].availableBalance) || 0) - entry.calculatedProfit);
            }
          }
          if (entry.investmentId && entry.calculatedProfit) {
            const iIdx = investments.findIndex(i => i._id === entry.investmentId);
            if (iIdx !== -1) {
              investments[iIdx].returnEarned = Math.max(0, (Number(investments[iIdx].returnEarned) || 0) - entry.calculatedProfit);
              investments[iIdx].paymentHistory = (investments[iIdx].paymentHistory || []).filter(h => h.type !== 'profit_distribution' || h.amount !== entry.calculatedProfit);
            }
          }
        }

        writeCollection('wallets', wallets);
        writeCollection('investments', investments);

        // Delete from profitLedger and distributions
        const filteredLedger = ledger.filter(e => e.distributionId !== distId);
        writeCollection('profitLedger', filteredLedger);

        const distributions = readCollection('distributions').filter(d => d._id !== distId);
        writeCollection('distributions', distributions);
      }

      // Delete from auditLog
      const filteredAuditLogs = auditLogs.filter(l => l._id !== id && l.metadata?.distributionId !== distId);
      writeCollection('auditLog', filteredAuditLogs);

      return { success: true };
    },

    getLedgerByDistribution: async (distributionId) => {
      const entries = readCollection('profitLedger').filter(e => e.distributionId === distributionId);
      if (!entries.length) return [];
      const users = readCollection('users');
      return entries.map(e => {
        const user = users.find(u => u._id === e.investorId);
        return {
          ...e,
          investor: user ? { _id: user._id, name: user.name, email: user.email } : null
        };
      });
    },

    getInvestorLedger: async (investorId) => {
      const entries = readCollection('profitLedger')
        .filter(e => e.investorId === investorId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      if (!entries.length) return [];
      const projects = readCollection('projects');
      return entries.map(e => {
        const proj = projects.find(p => p._id === e.projectId);
        return {
          ...e,
          project: proj ? { _id: proj._id, title: proj.title, category: proj.category } : null
        };
      });
    },

    getInvestorSummary: async (investorId) => {
      const entries = readCollection('profitLedger').filter(e => e.investorId === investorId);
      const wallets = readCollection('wallets');
      const wallet = wallets.find(w => w.investorId === investorId);

      const totalEarned = entries.reduce((s, e) => s + (Number(e.calculatedProfit) || 0), 0);

      const projectMap = new Map();
      for (const e of entries) {
        const existing = projectMap.get(e.projectId);
        if (existing) {
          existing.totalProfit += Number(e.calculatedProfit) || 0;
          existing.totalShares += Number(e.shares) || 0;
          existing.distributions += 1;
        } else {
          projectMap.set(e.projectId, {
            projectId: e.projectId,
            totalProfit: Number(e.calculatedProfit) || 0,
            totalShares: Number(e.shares) || 0,
            distributions: 1
          });
        }
      }

      const projects = readCollection('projects');
      for (const p of projects) {
        const entry = projectMap.get(p._id);
        if (entry) {
          entry.projectTitle = p.title;
          entry.projectCategory = p.category;
        }
      }

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

    populateAll: async (list) => {
      if (!list.length) return [];
      const projects = readCollection('projects');
      const users = readCollection('users');
      return list.map(d => {
        const proj = projects.find(p => p._id === d.projectId);
        const admin = users.find(u => u._id === d.createdBy);
        return {
          ...d,
          project: proj ? { _id: proj._id, title: proj.title, category: proj.category } : null,
          admin: admin ? { _id: admin._id, name: admin.name, email: admin.email } : null
        };
      });
    }
  },

  profitSchedules: {
    find: async (query = {}) => {
      let data = readCollection('profitSchedules');
      if (query.status) data = data.filter(s => s.status === query.status);
      if (query.projectId) data = data.filter(s => s.projectId === query.projectId);
      return data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
    findById: async (id) => {
      const data = readCollection('profitSchedules');
      return data.find(s => s._id === id) || null;
    },
    findActiveByProject: async (projectId) => {
      const data = readCollection('profitSchedules');
      return data.find(s => s.projectId === projectId && s.status === 'active') || null;
    },
    create: async (payload) => {
      const schedules = readCollection('profitSchedules');
      const active = schedules.find(s => s.projectId === payload.projectId && s.status === 'active');
      if (active) {
        throw new Error('This project already has an active profit schedule. Pause it before creating a new one.');
      }
      const now = new Date().toISOString();
      const schedule = {
        _id: generateId(),
        projectId: payload.projectId,
        cycleType: payload.cycleType === 'monthly' ? 'monthly' : 'weekly',
        profitPerShare: Number(payload.profitPerShare) || 0,
        startDate: payload.startDate,
        status: 'active',
        cyclesProcessed: 0,
        createdBy: payload.createdBy,
        createdAt: now,
        updatedAt: now
      };
      schedules.push(schedule);
      writeCollection('profitSchedules', schedules);
      return schedule;
    },
    updateStatus: async (id, status) => {
      const schedules = readCollection('profitSchedules');
      const idx = schedules.findIndex(s => s._id === id);
      if (idx === -1) return null;
      schedules[idx].status = status;
      schedules[idx].updatedAt = new Date().toISOString();
      writeCollection('profitSchedules', schedules);
      return schedules[idx];
    },
    incrementCyclesProcessed: async (id) => {
      const schedules = readCollection('profitSchedules');
      const idx = schedules.findIndex(s => s._id === id);
      if (idx === -1) return null;
      schedules[idx].cyclesProcessed = (schedules[idx].cyclesProcessed || 0) + 1;
      schedules[idx].updatedAt = new Date().toISOString();
      writeCollection('profitSchedules', schedules);
      return schedules[idx];
    }
  },

  wallets: {
    getOrCreate: async (investorId) => {
      const wallets = readCollection('wallets');
      let wallet = wallets.find(w => w.investorId === investorId);
      if (!wallet) {
        const now = new Date().toISOString();
        wallet = {
          _id: generateId(),
          investorId,
          availableBalance: 0,
          pendingBalance: 0,
          withdrawnBalance: 0,
          createdAt: now,
          updatedAt: now
        };
        wallets.push(wallet);
        writeCollection('wallets', wallets);
      }
      return wallet;
    },
    getByInvestorId: async (investorId) => {
      const wallets = readCollection('wallets');
      return wallets.find(w => w.investorId === investorId) || null;
    },
    credit: async (investorId, amount) => {
      const wallets = readCollection('wallets');
      const now = new Date().toISOString();
      let idx = wallets.findIndex(w => w.investorId === investorId);
      if (idx === -1) {
        wallets.push({
          _id: generateId(),
          investorId,
          availableBalance: 0,
          pendingBalance: 0,
          withdrawnBalance: 0,
          createdAt: now,
          updatedAt: now
        });
        idx = wallets.length - 1;
      }
      wallets[idx].availableBalance = (Number(wallets[idx].availableBalance) || 0) + amount;
      wallets[idx].updatedAt = now;
      writeCollection('wallets', wallets);
      return wallets[idx];
    }
  },

  auditLog: {
    create: async (entry) => {
      const logs = readCollection('auditLog');
      const newItem = {
        _id: generateId(),
        action: entry.action,
        performedBy: entry.performedBy,
        targetUserId: entry.targetUserId || '',
        metadata: entry.metadata || {},
        createdAt: new Date().toISOString()
      };
      logs.push(newItem);
      writeCollection('auditLog', logs);
      return newItem;
    },
    find: async (query = {}) => {
      let data = readCollection('auditLog');
      if (query.action) data = data.filter(l => l.action === query.action);
      if (query.performedBy) data = data.filter(l => l.performedBy === query.performedBy);
      return data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
  },

  adminStats: {
    getDashboard: async () => {
      const projects = readCollection('projects');
      const interests = readCollection('interests');
      const investors = readCollection('users').filter(u => u.role === 'investor');
      const investments = readCollection('investments');
      const withdrawals = readCollection('withdrawals');
      const distributions = readCollection('distributions');
      const schedules = readCollection('profitSchedules');

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
        .filter(d => d.status === 'completed')
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
        activeProfitSchedules: schedules.filter(s => s.status === 'active').length,
        categoryBreakdown: Object.entries(categoryMap).map(([label, count]) => ({ label, count })),
        interestStatusBreakdown: Object.entries(interestStatus).map(([label, count]) => ({ label, count }))
      };
    }
  }
};

module.exports = DB;
