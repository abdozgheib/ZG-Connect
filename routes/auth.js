const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const User = require('../models/User');
const auth = require('../middleware/auth');

const resend = new Resend(process.env.RESEND_API_KEY);

router.post('/register', async (req, res) => {
  try {
    console.log('Register request:', req.body);
    console.log('EMAIL_USER:', process.env.EMAIL_USER);
    console.log('EMAIL_PASS exists:', !!process.env.EMAIL_PASS);

    const { name, email, password } = req.body;
    const existing = await User.findOne({ email });

    if (existing && existing.isVerified) {
      return res.status(400).json({ message: 'Email already registered!' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    let user;
    if (existing && !existing.isVerified) {
      // Allow re-registration for unverified accounts (update name, password, code)
      existing.name = name;
      existing.password = await bcrypt.hash(password, 10);
      existing.verificationCode = code;
      existing.verificationExpiry = expiry;
      user = existing;
    } else {
      const hashed = await bcrypt.hash(password, 10);
      user = new User({ name, email, password: hashed });
      user.verificationCode = code;
      user.verificationExpiry = expiry;
      user.isVerified = false;
    }
    await user.save();

    const result = await resend.emails.send({
      from: 'ZG Connect <noreply@zgconnect.app>',
      to: email,
      subject: 'ZG Connect - Email Verification',
      html: `
        <div style="font-family: Arial, sans-serif;
                    max-width: 400px; margin: 0 auto;
                    padding: 20px;">
          <div style="background: #075e54; padding: 20px;
                      border-radius: 10px; text-align: center;">
            <h1 style="color: white; margin: 0;">ZG Connect</h1>
          </div>
          <div style="padding: 30px; text-align: center;">
            <h2>Verify your email</h2>
            <p>Your verification code is:</p>
            <div style="background: #f0f0f0; padding: 20px;
                        border-radius: 10px; margin: 20px 0;">
              <h1 style="color: #075e54; letter-spacing: 10px;
                         font-size: 36px; margin: 0;">
                ${code}
              </h1>
            </div>
            <p style="color: #999;">
              This code expires in 10 minutes.
            </p>
          </div>
        </div>
      `
    });
    console.log('Resend result:', JSON.stringify(result));

    res.json({
      message: 'Registration successful! Check your email for verification code.',
      email,
      requiresVerification: true
    });
  } catch (err) {
    console.log('Register error:', err);
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

router.post('/verify', async (req, res) => {
  try {
    const { email, code } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: 'Email already verified' });
    }

    if (user.verificationCode !== code) {
      return res.status(400).json({ message: 'Invalid verification code' });
    }

    if (new Date() > user.verificationExpiry) {
      return res.status(400).json({ message: 'Code expired. Please request a new one.' });
    }

    user.isVerified = true;
    user.verificationCode = null;
    user.verificationExpiry = null;
    await user.save();

    const token = jwt.sign(
      { id: user._id, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
      }
    });
  } catch (err) {
    console.log('Verify error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/resend-code', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    user.verificationCode = code;
    user.verificationExpiry = expiry;
    await user.save();

    const result = await resend.emails.send({
      from: 'ZG Connect <noreply@zgconnect.app>',
      to: email,
      subject: 'ZG Connect - New Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif;
                    max-width: 400px; margin: 0 auto;
                    padding: 20px;">
          <div style="background: #075e54; padding: 20px;
                      border-radius: 10px;
                      text-align: center;">
            <h1 style="color: white; margin: 0;">
              ZG Connect
            </h1>
          </div>
          <div style="padding: 30px; text-align: center;">
            <h2>New Verification Code</h2>
            <div style="background: #f0f0f0; padding: 20px;
                        border-radius: 10px; margin: 20px 0;">
              <h1 style="color: #075e54;
                         letter-spacing: 10px;
                         font-size: 36px; margin: 0;">
                ${code}
              </h1>
            </div>
            <p style="color: #999;">
              This code expires in 10 minutes.
            </p>
          </div>
        </div>
      `
    });
    console.log('Resend result:', JSON.stringify(result));

    res.json({ message: 'New code sent to your email!' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Email not found!' });
    if (!user.isVerified) {
      return res.status(403).json({
        message: 'Please verify your email first',
        requiresVerification: true,
        email: user.email
      });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: 'Wrong password!' });
    const token = jwt.sign({ id: user._id, name: user.name }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Delete account
router.delete('/delete-account', auth, async (req, res) => {
  try {
    const { password } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: 'Wrong password!' });
    await User.findByIdAndDelete(req.user.id);
    res.json({ message: 'Account deleted successfully.' });
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

module.exports = router;
