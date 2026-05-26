require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const Message = require('./models/Message');
const User = require('./models/User');
const Group = require('./models/Group');
const CallLog = require('./models/CallLog');
const { sendNotification } = require('./notifications');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Track online users — declared here so routes can reference it at registration time
const onlineUsers = {};

app.use(express.json());
// Serve static files; `extensions: ['html']` lets /home serve home.html, etc.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Routes
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/chat', require('./routes/chat')(io, onlineUsers));
app.use('/api/contacts', require('./routes/contacts')(io, onlineUsers));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/calls', require('./routes/calls'));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB!'))
  .catch(err => console.log('❌ MongoDB error:', err));

// SPA fallback — any unknown route serves index.html so the client-side router takes over
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  socket.on('user-online', async (userId) => {
    if (!userId || userId === 'null' || userId === 'undefined') return;
    onlineUsers[userId] = socket.id;
    await User.findByIdAndUpdate(userId, { online: true });
    io.emit('online-users', Object.keys(onlineUsers));
  });

socket.on('private-message', async (data) => {
    const { senderId, receiverId, content, senderName, replyTo } = data;

    if (!senderId || !receiverId || !content) {
      console.log('Invalid message data:', data);
      return;
    }

    const senderUser = await User.findById(senderId);
    const receiverUser = await User.findById(receiverId);

    if (!receiverUser || !senderUser) return;

    // Check if sender is blocked by receiver
    if (receiverUser.blockedUsers && receiverUser.blockedUsers.map(id => id.toString()).includes(senderId.toString())) {
      return; // silently drop message
    }

    // Check if receiver is blocked by sender (optional - sender blocked receiver)
    if (senderUser.blockedUsers && senderUser.blockedUsers.map(id => id.toString()).includes(receiverId.toString())) {
      return; // silently drop message
    }

    const message = new Message({
      sender: senderId,
      receiver: receiverId,
      content,
      replyTo: replyTo || null,
      delivered: false
    });
    await message.save();

    // Single tick: server saved the message
    io.to(socket.id).emit('message-sent', { messageId: message._id });

  const receiverSocket = onlineUsers[receiverId];
    if (receiverSocket) {
      io.to(receiverSocket).emit('private-message', {
        senderId,
        senderName,
        receiverId,
        content,
        replyTo: replyTo || null,
        messageId: message._id,
        createdAt: message.createdAt
      });
      io.to(receiverSocket).emit('notification', {
        type: 'private',
        from: senderName,
        content: content,
        senderId: senderId,
        messageId: message._id,
        createdAt: message.createdAt
      });
      io.to(socket.id).emit('message-delivered', { messageId: message._id });
    }

    // Always send FCM notification regardless of online status
    try {
      const receiver = await User.findById(receiverId);
      if (receiver && receiver.fcmToken) {
        const preview = content.startsWith('📷[image]') ? '📷 Photo' : content;
        await sendNotification(
          receiver.fcmToken,
          `💬 ${senderName}`,
          preview,
          {
            type: 'private_message',
            senderId: senderId.toString(),
            senderName,
            receiverId: receiverId.toString()
          }
        );
      }
    } catch (err) {
      console.log('FCM error:', err);
    }
  });

  // Message read
  socket.on('message-read', async (data) => {
    const { messageId, senderId } = data;
    if (!messageId || !senderId) return;
    await Message.findByIdAndUpdate(messageId, { read: true, readAt: Date.now() });
    const senderSocket = onlineUsers[senderId];
    if (senderSocket) {
      io.to(senderSocket).emit('message-read', { messageId });
    }
  });

  socket.on('group-message', async (data) => {
    const { senderId, groupId, content, senderName, groupName, replyTo } = data;
    if (!senderId || senderId === 'null' || senderId === 'undefined') {
      console.log('Invalid senderId in group-message:', senderId);
      return;
    }
    if (!groupId || groupId === 'null' || groupId === 'undefined') {
      console.log('Invalid groupId in group-message:', groupId);
      return;
    }
    if (!content) {
      console.log('Empty content in group-message');
      return;
    }
    const message = new Message({ sender: senderId, group: groupId, content, replyTo: replyTo || null });
    await message.save();
    socket.to(groupId).emit('group-message', {
      senderId,
      senderName,
      groupId,
      content,
      replyTo: replyTo || null,
      createdAt: message.createdAt
    });
    socket.to(groupId).emit('notification', {
      type: 'group',
      from: senderName,
      groupName: groupName,
      content: content,
      groupId: groupId
    });
    // Send FCM push to all group members who are not the sender
    try {
      const group = await Group.findById(groupId).populate('members.userId', 'fcmToken');
      if (group) {
        const preview = content.startsWith('📷[image]') ? '📷 Photo' : content;
        const notifPromises = group.members
          .filter(m => m.userId && m.userId.fcmToken && m.userId._id.toString() !== senderId.toString())
          .map(m => sendNotification(
            m.userId.fcmToken,
            `${senderName} in ${groupName}`,
            preview,
            { type: 'group_message', groupId: groupId.toString(), groupName, senderName }
          ));
        await Promise.allSettled(notifPromises);
      }
    } catch (err) {
      console.log('Group FCM error:', err);
    }
  });

  socket.on('join-group', (groupId) => {
    socket.join(groupId);
  });

  // Relay back to sender so their home screen updates preview instantly
  socket.on('update-chat-preview', (data) => {
    socket.emit('update-chat-preview', data);
  });

  socket.on('message-reaction', (data) => {
    const { messageId, reaction, userId, receiverId } = data;
    if (!messageId || messageId === 'null' || messageId === 'undefined') {
      console.log('Invalid messageId in message-reaction:', messageId);
      return;
    }
    if (!userId || userId === 'null' || userId === 'undefined') {
      console.log('Invalid userId in message-reaction:', userId);
      return;
    }

    Message.findByIdAndUpdate(
      messageId,
      { $push: { reactions: { userId, emoji: reaction } } },
      { new: true }
    ).catch(err => console.log(err));

    const receiverSocket = onlineUsers[receiverId];
    if (receiverSocket) {
      io.to(receiverSocket).emit('message-reaction', {
        messageId,
        reaction,
        userId,
      });
    }
  });

  socket.on('group-message-reaction', (data) => {
    const { messageId, reaction, userId, groupId } = data;
    if (!messageId || messageId === 'null' || messageId === 'undefined') {
      console.log('Invalid messageId in group-message-reaction:', messageId);
      return;
    }
    if (!userId || userId === 'null' || userId === 'undefined') {
      console.log('Invalid userId in group-message-reaction:', userId);
      return;
    }
    if (!groupId || groupId === 'null' || groupId === 'undefined') {
      console.log('Invalid groupId in group-message-reaction:', groupId);
      return;
    }

    Message.findByIdAndUpdate(
      messageId,
      { $push: { reactions: { userId, emoji: reaction } } }
    ).catch(err => console.log(err));

    socket.to(groupId).emit('group-message-reaction', {
      messageId,
      reaction,
      userId,
    });
  });

  socket.on('typing', (data) => {
    const receiverSocket = onlineUsers[data.receiverId];
    if (receiverSocket) {
      io.to(receiverSocket).emit('typing', {
        senderId: data.senderId,
        senderName: data.senderName
      });
    }
  });

  socket.on('stop-typing', (data) => {
    const receiverSocket = onlineUsers[data.receiverId];
    if (receiverSocket) {
      io.to(receiverSocket).emit('stop-typing', {
        senderId: data.senderId
      });
    }
  });

  // Call offer - caller sends to receiver
  socket.on('call-offer', async (data) => {
    const { callerId, callerName, callerAvatar,
            targetUserId, offer, callType, callId } = data;
    const targetSocket = onlineUsers[targetUserId];
    if (targetSocket) {
      io.to(targetSocket).emit('incoming-call', {
        callerId,
        callerName,
        callerAvatar,
        offer: JSON.stringify(offer),
        callType: callType || 'voice',
        callId: offer?.callId || callId,
      });
      const targetSocketId = onlineUsers[targetUserId];
      if (targetSocketId) {
        socket.emit('call-ringing', {});
      }
      try {
        const CallLog = require('./models/CallLog');
        const callLog = new CallLog({
          callerId: callerId,
          receiverId: targetUserId,
          callType: callType || 'voice',
          status: 'missed',
        });
        await callLog.save();
        console.log('CallLog saved:', callLog._id);
        global.pendingCallLogs = global.pendingCallLogs || {};
        global.pendingCallLogs[`${callerId}-${targetUserId}`] = callLog._id;
      } catch (e) {
        console.log('CallLog save error:', e);
      }
    }
  });

  // Call answer - receiver sends answer to caller
  socket.on('call-answer', async (data) => {
    const { callerId, answer } = data;
    const callerSocket = onlineUsers[callerId];
    if (callerSocket) {
      io.to(callerSocket).emit('call-answered', { answer });
    }
    try {
      const key = Object.keys(global.pendingCallLogs || {}).find(k => k.includes(callerId));
      if (key && global.pendingCallLogs[key]) {
        await CallLog.findByIdAndUpdate(global.pendingCallLogs[key], { status: 'completed' });
        delete global.pendingCallLogs[key];
      }
    } catch (e) {}
  });

  // Call reject
  socket.on('call-reject', async (data) => {
    const { callerId } = data;
    const callerSocket = onlineUsers[callerId];
    if (callerSocket) {
      io.to(callerSocket).emit('call-rejected');
    }
    try {
      const key = Object.keys(global.pendingCallLogs || {}).find(k => k.includes(callerId));
      if (key && global.pendingCallLogs[key]) {
        await CallLog.findByIdAndUpdate(global.pendingCallLogs[key], { status: 'declined' });
        delete global.pendingCallLogs[key];
      }
    } catch (e) {}
  });

  // Call end
  socket.on('call-end', (data) => {
    const { targetUserId } = data;
    const targetSocket = onlineUsers[targetUserId];
    if (targetSocket) {
      io.to(targetSocket).emit('call-ended');
    }
  });

  // ICE candidate exchange
  socket.on('call-ice-candidate', (data) => {
    const { candidate, targetUserId } = data;
    const targetSocket = onlineUsers[targetUserId];
    if (targetSocket) {
      io.to(targetSocket).emit('call-ice-candidate', { candidate });
    }
  });

  socket.on('disconnect', async () => {
    const userId = Object.keys(onlineUsers).find(k => onlineUsers[k] === socket.id);
    if (userId) {
      delete onlineUsers[userId];
      const lastSeen = Date.now();
      await User.findByIdAndUpdate(userId, { online: false, lastSeen });
      io.emit('user-last-seen', { userId, lastSeen });
      io.emit('online-users', Object.keys(onlineUsers));
    }
  });
});

setInterval(() => {
  fetch('https://zg-connect.onrender.com/api/health').catch(() => {});
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));