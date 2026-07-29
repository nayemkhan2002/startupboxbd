const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');

dotenv.config();

const seedAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const adminExists = await User.findOne({ email: 'admin@startupboxbd.com' });

    if (adminExists) {
      console.log('Admin user already exists');
      process.exit();
    }

    const adminUser = await User.create({
      name: 'Admin',
      email: 'admin@startupboxbd.com',
      password: 'password123', // Will be hashed by pre-save hook
      role: 'admin',
    });

    console.log('Admin user created successfully:');
    console.log('Email: admin@startupboxbd.com');
    console.log('Password: password123');
    process.exit();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

seedAdmin();
