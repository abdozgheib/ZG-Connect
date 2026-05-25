const express = require('express');
const auth = require('../middleware/auth');
const User = require('../models/User');

module.exports = (io, onlineUsers) => {
const router = express.Router();

// Search users by name or phone
router.get('/search', auth, async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) return res.json([]);

    const users = await User.find({
      _id: { $ne: req.user.id },
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { phone: { $regex: query, $options: 'i' } }
      ]
    }).select('-password').limit(10);

    res.json(users);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Send contact request
router.post('/request', auth, async (req, res) => {
  try {
    const { userId } = req.body;
    const me = await User.findById(req.user.id);
    const other = await User.findById(userId);

    if (!other) return res.status(404).json({ message: 'User not found!' });
    if (me.contacts.includes(userId)) return res.status(400).json({ message: 'Already in contacts!' });
    if (me.sentRequests.includes(userId)) return res.status(400).json({ message: 'Request already sent!' });

    // Add to sent requests
    me.sentRequests.push(userId);
    await me.save();

    // Add to pending requests of other user
    other.pendingRequests.push(req.user.id);
    await other.save();

    const receiverSocket = onlineUsers[userId];
    if (receiverSocket) {
      io.to(receiverSocket).emit('contact-request', {
        from: req.user.id,
        fromName: me.name
      });
    }

    res.json({ message: 'Contact request sent!' });
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Accept contact request
router.post('/accept', auth, async (req, res) => {
  try {
    const { userId } = req.body;
    const me = await User.findById(req.user.id);
    const other = await User.findById(userId);

    // Add to contacts
    me.contacts.push(userId);
    me.pendingRequests = me.pendingRequests.filter(id => id.toString() !== userId);
    await me.save();

    other.contacts.push(req.user.id);
    other.sentRequests = other.sentRequests.filter(id => id.toString() !== req.user.id);
    await other.save();

    const accepterSocket = onlineUsers[req.user.id];
    if (accepterSocket) {
      io.to(accepterSocket).emit('contact-accepted', { userId });
    }
    const requesterSocket = onlineUsers[userId];
    if (requesterSocket) {
      io.to(requesterSocket).emit('contact-accepted', { userId: req.user.id });
    }

    res.json({ message: 'Contact accepted!' });
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Decline contact request
router.post('/decline', auth, async (req, res) => {
  try {
    const { userId } = req.body;
    const me = await User.findById(req.user.id);
    const other = await User.findById(userId);

    me.pendingRequests = me.pendingRequests.filter(id => id.toString() !== userId);
    await me.save();

    other.sentRequests = other.sentRequests.filter(id => id.toString() !== req.user.id);
    await other.save();

    res.json({ message: 'Contact declined!' });
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Get my contacts
router.get('/', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id).populate('contacts', '-password');
    res.json(me.contacts);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Get sent request IDs
router.get('/sent', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    res.json(me.sentRequests.map(id => id.toString()));
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Get pending requests count
router.get('/requests/count', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    res.json({ count: me.pendingRequests.length });
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Get pending requests
router.get('/pending', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id).populate('pendingRequests', '-password');
    res.json(me.pendingRequests);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

// Remove contact
router.delete('/:contactId', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    me.contacts = me.contacts.filter(c => c.toString() !== req.params.contactId);
    await me.save();
    res.json({ message: 'Contact removed!' });
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

router.post('/block', auth, async (req, res) => {
  try {
    const { userId } = req.body;
    const me = await User.findById(req.user.id);
    const other = await User.findById(userId);
    if (!other) return res.status(404).json({ message: 'User not found' });
    me.contacts = me.contacts.filter(id => id.toString() !== userId);
    me.sentRequests = me.sentRequests.filter(id => id.toString() !== userId);
    me.pendingRequests = me.pendingRequests.filter(id => id.toString() !== userId);
    if (!me.blockedUsers) me.blockedUsers = [];
    me.blockedUsers.push(userId);
    await me.save();
    other.contacts = other.contacts.filter(id => id.toString() !== req.user.id);
    other.sentRequests = other.sentRequests.filter(id => id.toString() !== req.user.id);
    other.pendingRequests = other.pendingRequests.filter(id => id.toString() !== req.user.id);
    await other.save();
    res.json({ message: 'User blocked!' });
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

router.get('/blocked', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id).populate('blockedUsers', '-password');
    res.json(me.blockedUsers || []);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

router.post('/unblock', auth, async (req, res) => {
  try {
    const { userId } = req.body;
    const me = await User.findById(req.user.id);
    me.blockedUsers = (me.blockedUsers || []).filter(id => id.toString() !== userId);
    await me.save();
    res.json({ message: 'User unblocked!' });
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

router.post('/report', auth, async (req, res) => {
  try {
    const { userId } = req.body;
    console.log(`User ${req.user.id} reported user ${userId}`);
    res.json({ message: 'Report received!' });
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

return router;
};
