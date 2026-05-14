const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User');
const Message = require('../models/Message');
const Group = require('../models/Group');

// Get all users
router.get('/users', auth, async (req, res) => {
  try {
    const users = await User.find({ _id: { $ne: req.user.id } }).select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Get private messages
router.get('/messages/:userId', auth, async (req, res) => {
  try {
    const messages = await Message.find({
      $or: [
        { sender: req.user.id, receiver: req.params.userId },
        { sender: req.params.userId, receiver: req.user.id }
      ]
    }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Create group
router.post('/groups', auth, async (req, res) => {
  try {
    const { name, members } = req.body;
    const group = new Group({ name, admin: req.user.id, members: [...members, req.user.id] });
    await group.save();
    res.json(group);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Get my groups
router.get('/groups', auth, async (req, res) => {
  try {
    const groups = await Group.find({ members: req.user.id }).populate('members', 'name');
    res.json(groups);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Get group messages
router.get('/groups/:groupId/messages', auth, async (req, res) => {
  try {
    const messages = await Message.find({ group: req.params.groupId })
      .populate('sender', 'name')
      .sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

module.exports = router;