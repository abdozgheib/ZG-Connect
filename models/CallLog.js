const mongoose = require('mongoose');
const CallLogSchema = new mongoose.Schema({
  callerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  callType: { type: String, enum: ['voice', 'video'], default: 'voice' },
  status: { type: String, enum: ['completed', 'missed', 'declined'], default: 'completed' },
  duration: { type: Number, default: 0 },
}, { timestamps: true });
module.exports = mongoose.model('CallLog', CallLogSchema);
