/**
 * Reset admin password in the database.
 * Usage: node resetAdminPassword.js
 *
 * This will find the admin user and set the password to the value of
 * ADMIN_PASSWORD env var (or 'password123' by default).
 */
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const dotenv = require('dotenv');

dotenv.config();

const { User } = require('./db/models');

const resetAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@startupboxbd.com';
    const newPassword = process.env.ADMIN_PASSWORD || 'password123';

    const admin = await User.findOne({ email: adminEmail });

    if (!admin) {
      // Admin doesn't exist — create one
      const hashed = await bcrypt.hash(newPassword, 10);
      await User.create({
        _id: 'admin_id_default',
        name: 'Admin',
        email: adminEmail,
        password: hashed,
        role: 'admin',
        phone: '',
        address: '',
        profileImage: '',
        bankInfo: { method: 'bkash', bkashAccountType: 'Personal' },
        createdAt: new Date().toISOString()
      });
      console.log(`✅ Admin user CREATED`);
      console.log(`   Email:    ${adminEmail}`);
      console.log(`   Password: ${newPassword}`);
    } else {
      // Admin exists — reset password
      const hashed = await bcrypt.hash(newPassword, 10);
      await User.updateOne({ email: adminEmail }, { $set: { password: hashed } });
      console.log(`✅ Admin password RESET`);
      console.log(`   Email:    ${adminEmail}`);
      console.log(`   Password: ${newPassword}`);
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
};

resetAdmin();
