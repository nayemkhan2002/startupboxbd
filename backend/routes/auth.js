const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const DB = require('../db');

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'supersecretjwtkey123', { expiresIn: '30d' });
};

// Register user
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Please provide all fields' });
    }
    const userExists = await DB.users.findOne({ email });
    if (userExists) return res.status(400).json({ message: 'User already exists' });
    
    const user = await DB.users.create({ name, email, password });
    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      token: generateToken(user._id)
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Login user
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await DB.users.findOne({ email });
    if (user && (await DB.users.matchPassword(password, user.password))) {
      res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        token: generateToken(user._id)
      });
    } else {
      res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

const crypto = require('crypto');
const nodemailer = require('nodemailer');

const sendResetEmail = async (email, resetUrl) => {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: Number(process.env.EMAIL_PORT) || 587,
      secure: Number(process.env.EMAIL_PORT) === 465,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    const mailOptions = {
      from: process.env.EMAIL_FROM || `"Startup Box Bangladesh" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Password Reset Request — Startup Box BD',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #1e293b;">Password Reset Request</h2>
          <p>You requested to reset your password for your Startup Box BD account. Please click the button below to reset it:</p>
          <div style="margin: 24px 0; text-align: center;">
            <a href="${resetUrl}" style="background-color: #15803d; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Reset Password</a>
          </div>
          <p style="color: #64748b; font-size: 0.875rem;">This link is valid for 1 hour. If you did not request this, you can safely ignore this email.</p>
          <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 20px 0;">
          <p style="font-size: 0.75rem; color: #94a3b8;">If the button doesn't work, copy and paste this URL into your browser:</p>
          <p style="font-size: 0.75rem; color: #94a3b8; word-break: break-all;">${resetUrl}</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log(`Password reset email sent to ${email}`);
  } else {
    console.log('\n==================================================');
    console.log(`🔑 PASSWORD RESET LINK FOR ${email}:`);
    console.log(resetUrl);
    console.log('==================================================\n');
  }
};

// Forgot Password Endpoint
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Please provide email' });
    }

    const user = await DB.users.findOne({ email: email.toLowerCase() });
    if (user) {
      const token = crypto.randomBytes(20).toString('hex');
      const expireTime = Date.now() + 3600000; // 1 hour

      await DB.users.findByIdAndUpdate(user._id, {
        resetPasswordToken: token,
        resetPasswordExpires: expireTime
      });

      const resetUrl = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
      await sendResetEmail(user.email, resetUrl);
    }

    res.json({ message: 'If an account matches that email, a password reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ message: 'Server error processing forgot password request' });
  }
});

// Reset Password Endpoint
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ message: 'Token and new password are required' });
    }

    const user = await DB.users.findOne({ resetPasswordToken: token });
    if (!user || !user.resetPasswordExpires || user.resetPasswordExpires < Date.now()) {
      return res.status(400).json({ message: 'Password reset token is invalid or has expired.' });
    }

    await DB.users.resetPassword(user._id, password);
    res.json({ message: 'Password reset successful. You can now login.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ message: 'Server error resetting password' });
  }
});

// --- Admin: list all investor accounts ---
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');

router.get('/investors', protect, adminOnly, async (req, res) => {
  try {
    const allUsers = await DB.users.find({ role: 'investor' });
    // Strip password from each user
    const investors = allUsers.map(({ password, ...rest }) => rest);
    res.json(investors);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
