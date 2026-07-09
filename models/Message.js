const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
  content: { type: String, required: true },
  delivered: { type: Boolean, default: false },
  read: { type: Boolean, default: false },
  readAt: { type: Date },
  deleted: { type: Boolean, default: false },
  deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  forwarded: { type: Boolean, default: false },
  forwardedCount: { type: Number, default: 0 },
  starredBy: [{ type: String }],
  pinnedBy: [{ type: String }],
  edited: { type: Boolean, default: false },
  editedAt: { type: Date },
  pollVotes: { type: Map, of: [String], default: {} },
  replyTo: {
    _id: String,
    content: String,
    senderName: String,
  },
  reactions: [{
    userId: String,
    emoji: String,
  }],
  deliveredAt: { type: Date },
  readBy: [{
    userId: { type: String, required: true },
    readAt: { type: Date, default: Date.now },
  }],
  deliveredTo: [{
    userId: { type: String, required: true },
    deliveredAt: { type: Date, default: Date.now },
  }],
  playedBy: [{
    userId: { type: String, required: true },
    playedAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

module.exports = mongoose.model('Message', messageSchema);
