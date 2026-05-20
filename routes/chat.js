const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Message = require('../models/Message');
const Group = require('../models/Group');

// Get last message preview for all contacts in ONE query
router.get('/previews', auth, async (req, res) => {
  try {
    const myId = new mongoose.Types.ObjectId(req.user.id);
    const me = await User.findById(req.user.id).select('contacts');
    if (!me || !me.contacts.length) return res.json({});

    const results = await Message.aggregate([
      {
        $match: {
          group: { $exists: false },
          $or: [{ sender: myId }, { receiver: myId }]
        }
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: {
            $cond: {
              if: { $eq: ['$sender', myId] },
              then: '$receiver',
              else: '$sender'
            }
          },
          content: { $first: '$content' },
          createdAt: { $first: '$createdAt' },
          deleted: { $first: '$deleted' }
        }
      },
      { $match: { _id: { $in: me.contacts } } }
    ]);

    const map = {};
    results.forEach(r => {
      map[r._id.toString()] = {
        content: r.deleted ? 'This message was deleted' : r.content,
        createdAt: r.createdAt
      };
    });
    res.json(map);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Get all users
router.get('/users', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id).populate('contacts', '-password');
    res.json(me.contacts);
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
// Delete message
router.delete('/messages/:messageId', auth, async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ message: 'Message not found!' });

    // Only sender can delete
    if (message.sender.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only delete your own messages!' });
    }

    // Delete for everyone
    await Message.findByIdAndUpdate(req.params.messageId, {
      deleted: true,
      content: 'This message was deleted'
    });

    res.json({ message: 'Message deleted!' });
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});
// Delete chat (all messages between two users)
router.delete('/chat/:userId', auth, async (req, res) => {
  try {
    await Message.deleteMany({
      $or: [
        { sender: req.user.id, receiver: req.params.userId },
        { sender: req.params.userId, receiver: req.user.id }
      ]
    });
    res.json({ message: 'Chat deleted!' });
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

module.exports = router;