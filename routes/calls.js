const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const CallLog = require('../models/CallLog');

router.get('/logs', auth, async (req, res) => {
  try {
    const logs = await CallLog.find({
      $or: [{ callerId: req.user.id }, { receiverId: req.user.id }]
    })
    .sort({ createdAt: -1 })
    .limit(50)
    .populate('callerId', 'name avatar')
    .populate('receiverId', 'name avatar');

    const formatted = logs.map(log => {
      const isOutgoing = log.callerId._id.toString() === req.user.id;
      const contact = isOutgoing ? log.receiverId : log.callerId;
      return {
        _id: log._id,
        contactId: contact._id,
        contactName: contact.name,
        contactAvatar: contact.avatar,
        callType: log.callType,
        status: log.status,
        direction: isOutgoing ? 'outgoing' : 'incoming',
        duration: log.duration,
        createdAt: log.createdAt,
      };
    });
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ message: 'Something went wrong!' });
  }
});

module.exports = router;
