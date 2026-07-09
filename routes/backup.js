const crypto = require('crypto');
const express = require('express');
const auth = require('../middleware/auth');

const router = express.Router();

router.get('/key', auth, (req, res) => {
  const backupKeySecret = process.env.BACKUP_KEY_SECRET;

  if (!backupKeySecret) {
    return res.status(500).json({ message: 'BACKUP_KEY_SECRET is not configured.' });
  }

  const userId = String(req.user.id);
  const key = crypto
    .createHmac('sha256', backupKeySecret)
    .update(userId)
    .digest('hex');

  res.json({ key });
});

module.exports = router;
