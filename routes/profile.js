const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User');
const axios = require('axios');
const FormData = require('form-data');

// Upload profile photo
router.post('/avatar', auth, async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ message: 'No image provided!' });
    }

    console.log('📸 Uploading image for user:', req.user.id);

    // Upload to ImgBB
    const formData = new FormData();
    formData.append('key', process.env.IMGBB_API_KEY);
    formData.append('image', imageBase64);

    const response = await axios.post('https://api.imgbb.com/1/upload', formData, {
      headers: formData.getHeaders()
    });

    const imageUrl = response.data.data.url;
    console.log('✅ Image uploaded to ImgBB:', imageUrl);

    // Save to user profile
    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      { avatar: imageUrl },
      { new: true }
    );

    console.log('✅ Avatar saved to MongoDB:', updatedUser.avatar);

    res.json({ avatar: imageUrl, message: 'Profile photo updated!' });

  } catch (err) {
    console.log('❌ Upload error:', err.message);
    res.status(500).json({ message: 'Failed to upload image: ' + err.message });
  }
});

// Update profile info
router.put('/update', auth, async (req, res) => {
  try {
    const { name, about, phone } = req.body;
    console.log('📝 Updating profile:', { name, about, phone });
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: { name, about, phone } },
      { new: true, strict: false }
    ).select('-password');
    console.log('✅ Profile updated:', user);
    res.json(user);
  } catch (err) {
    console.log('❌ Update error:', err);
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Get my profile
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    console.log('👤 Profile loaded for user:', req.user.id, 'avatar:', user.avatar);
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Get contact profile
router.get('/contact/:userId', auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found!' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});
// Save FCM token
router.post('/fcm-token', auth, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    console.log('📱 Saving FCM token for user:', req.user.id, 'token:', fcmToken?.substring(0, 20));
    await User.findByIdAndUpdate(req.user.id, { fcmToken });
    console.log('✅ FCM token saved!');
    res.json({ message: 'FCM token saved!' });
  } catch (err) {
    console.log('❌ FCM token error:', err);
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

module.exports = router;