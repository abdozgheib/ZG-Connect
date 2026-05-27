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
  blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  fcmToken: { type: String, default: '' },
  online: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now },
  isVerified: { type: Boolean, default: false },
  verificationCode: { type: String, default: null },
  verificationExpiry: { type: Date, default: null },
  // Privacy settings
  lastSeenVisibility: { type: String, enum: ['everyone', 'contacts', 'nobody'], default: 'everyone' },
  onlineStatusVisibility: { type: String, enum: ['everyone', 'contacts', 'nobody'], default: 'everyone' },
  readReceipts: { type: Boolean, default: true },
  profilePhotoVisibility: { type: String, enum: ['everyone', 'contacts', 'nobody'], default: 'everyone' },
  aboutVisibility: { type: String, enum: ['everyone', 'contacts', 'nobody'], default: 'everyone' },
  // Notification preferences
  messageNotifications: { type: Boolean, default: true },
  callNotifications: { type: Boolean, default: true },
  // Chat settings
  disappearingMessages: { type: String, default: 'off' },
  mediaAutoDownload: { type: String, default: 'wifi' }
}, { timestamps: true, strict: false });

module.exports = mongoose.model('User', userSchema);