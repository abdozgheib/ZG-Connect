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

    // Upload to ImgBB
    const formData = new FormData();
    formData.append('key', process.env.IMGBB_API_KEY);
    formData.append('image', imageBase64);

    const response = await axios.post('https://api.imgbb.com/1/upload', formData, {
      headers: formData.getHeaders()
    });

    const imageUrl = response.data.data.url;

    // Save to user profile
    await User.findByIdAndUpdate(req.user.id, { avatar: imageUrl });

    res.json({ avatar: imageUrl, message: 'Profile photo updated!' });

  } catch (err) {
    console.log('Upload error:', err);
    res.status(500).json({ message: 'Failed to upload image!' });
  }
});

// Update profile info
router.put('/update', auth, async (req, res) => {
  try {
    const { name, about } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { name, about },
      { new: true }
    ).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Get my profile
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

module.exports = router;