const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User');
const axios = require('axios');
const FormData = require('form-data');

let socketIo = null;

function broadcastAvatarUpdate(user, avatarUrl) {
  if (!socketIo || !user) return;
  const userId = String(user._id || '');
  const avatarUpdatedAt = Date.now();
  const contactRooms = Array.isArray(user.contacts) ? user.contacts.map(contactId => String(contactId)) : [];
  const payload = {
    userId,
    avatar: avatarUrl || '',
    avatarUrl: avatarUrl || '',
    avatarUpdatedAt,
    name: user.name || '',
  };
  console.log('backend_avatar_update_broadcasted', JSON.stringify({
    userId,
    rooms: [userId, ...contactRooms],
    contacts: contactRooms.length,
    hasAvatar: !!avatarUrl,
    avatarUpdatedAt,
  }));
  console.log('profile_avatar_socket_emit', JSON.stringify({
    userId,
    contacts: contactRooms.length,
    hasAvatar: !!avatarUrl,
    avatarUpdatedAt,
  }));
  socketIo.to(userId).emit('avatar-updated', payload);
  socketIo.to(userId).emit('user-profile-updated', payload);
  contactRooms.forEach(room => {
    socketIo.to(room).emit('avatar-updated', payload);
    socketIo.to(room).emit('user-profile-updated', payload);
  });
}

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

    console.log('backend_avatar_update_received', JSON.stringify({
      userId: String(req.user.id),
      hasAvatar: !!imageUrl,
      route: 'avatar',
    }));
    broadcastAvatarUpdate(updatedUser, imageUrl);
    res.json({ avatar: imageUrl, message: 'Profile photo updated!' });

  } catch (err) {
    console.log('❌ Upload error:', err.message);
    res.status(500).json({ message: 'Failed to upload image: ' + err.message });
  }
});

// Save avatar URL (uploaded directly from app to ImgBB)
router.post('/avatar-url', auth, async (req, res) => {
  try {
    const { avatarUrl } = req.body;
    const updatedUser = await User.findByIdAndUpdate(req.user.id, { avatar: avatarUrl }, { new: true });
    console.log('backend_avatar_update_received', JSON.stringify({
      userId: String(req.user.id),
      hasAvatar: !!avatarUrl,
      route: 'avatar-url',
    }));
    broadcastAvatarUpdate(updatedUser, avatarUrl);
    res.json({ success: true, avatar: avatarUrl });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
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

// Get contact profile — applies privacy settings
router.get('/contact/:userId', auth, async (req, res) => {
  try {
    const viewer = await User.findById(req.user.id).select('contacts');
    const user = await User.findById(req.params.userId).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found!' });

    const isContact = viewer.contacts.some(c => c.toString() === req.params.userId);
    const result = user.toObject();

    // Apply lastSeen privacy
    const lsv = user.lastSeenVisibility || 'everyone';
    if (lsv === 'nobody' || (lsv === 'contacts' && !isContact)) {
      delete result.lastSeen;
      result.lastSeen = null;
    }
    // Apply online status privacy
    const osv = user.onlineStatusVisibility || 'everyone';
    if (osv === 'nobody' || (osv === 'contacts' && !isContact)) {
      result.online = false;
    }
    // Apply profile photo privacy
    const ppv = user.profilePhotoVisibility || 'everyone';
    if (ppv === 'nobody' || (ppv === 'contacts' && !isContact)) {
      result.avatar = '';
    }
    // Apply about privacy
    const av = user.aboutVisibility || 'everyone';
    if (av === 'nobody' || (av === 'contacts' && !isContact)) {
      result.about = '';
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Get privacy settings
router.get('/privacy', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      'lastSeenVisibility onlineStatusVisibility readReceipts profilePhotoVisibility aboutVisibility messageNotifications callNotifications disappearingMessages mediaAutoDownload'
    );
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Update privacy settings
router.put('/privacy', auth, async (req, res) => {
  try {
    const allowed = ['lastSeenVisibility', 'onlineStatusVisibility', 'readReceipts', 'profilePhotoVisibility', 'aboutVisibility', 'messageNotifications', 'callNotifications', 'disappearingMessages', 'mediaAutoDownload'];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    const user = await User.findByIdAndUpdate(req.user.id, { $set: update }, { new: true }).select(allowed.join(' '));
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

module.exports = (io) => {
  socketIo = io;
  return router;
};
