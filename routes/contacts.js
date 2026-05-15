const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User');

// Add a contact by email
router.post('/add', auth, async (req, res) => {
  try {
    const { email } = req.body;
    if (email === req.user.email) {
      return res.status(400).json({ message: "You can't add yourself!" });
    }
    const contact = await User.findOne({ email }).select('-password');
    if (!contact) {
      return res.status(404).json({ message: 'No user found with this email!' });
    }
    const me = await User.findById(req.user.id);
    if (me.contacts.includes(contact._id)) {
      return res.status(400).json({ message: 'Already in your contacts!' });
    }
    me.contacts.push(contact._id);
    await me.save();
    res.json({ message: 'Contact added!', contact: { id: contact._id, name: contact.name, email: contact.email, online: contact.online } });
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

// Remove a contact
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

module.exports = router;