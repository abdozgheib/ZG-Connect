const mongoose = require('mongoose');

const DEFAULT_TEMP_QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const tempQueueRecipientSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  delivered: { type: Boolean, default: false },
  deliveredAt: { type: Date },
}, { _id: false });

const tempMessageQueueSchema = new mongoose.Schema({
  clientMessageId: { type: String, index: true },
  messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', index: true },
  scope: { type: String, enum: ['private', 'group'], required: true, index: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', index: true },
  content: { type: String, default: '' },
  messageType: { type: String, default: 'text' },
  recipients: { type: [tempQueueRecipientSchema], default: [] },
  delivered: { type: Boolean, default: false, index: true },
  deliveredAt: { type: Date },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + Number(process.env.TEMP_QUEUE_TTL_MS || DEFAULT_TEMP_QUEUE_TTL_MS)),
    index: true,
  },
}, { timestamps: true });

tempMessageQueueSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
tempMessageQueueSchema.index({ scope: 1, clientMessageId: 1 }, { unique: false });
tempMessageQueueSchema.index({ scope: 1, messageId: 1 }, { unique: false });

module.exports = mongoose.model('TempMessageQueue', tempMessageQueueSchema);
