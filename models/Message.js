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
  replyTo: {
    _id: String,
    content: String,
    senderName: String,
  },
  reactions: [{
    userId: String,
    emoji: String,
  }]
}, { timestamps: true });

module.exports = mongoose.model('Message', messageSchema);