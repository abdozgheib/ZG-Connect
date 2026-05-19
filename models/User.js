const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  phone: { type: String, default: '' },
  avatar: { type: String, default: '' },
  about: { type: String, default: 'Hey there! I am using ZG Connect.' },
  contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  pendingRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  sentRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  fcmToken: { type: String, default: '' },
  online: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now }
}, { timestamps: true, strict: false });

module.exports = mongoose.model('User', userSchema);