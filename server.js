require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const Message = require('./models/Message');
const User = require('./models/User');
const { sendNotification } = require('./notifications');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/profile', require('./routes/profile'));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB!'))
  .catch(err => console.log('❌ MongoDB error:', err));

// Serve frontend
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Track online users
const onlineUsers = {};

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  socket.on('user-online', async (userId) => {
    onlineUsers[userId] = socket.id;
    await User.findByIdAndUpdate(userId, { online: true });
    io.emit('online-users', Object.keys(onlineUsers));
  });

socket.on('private-message', async (data) => {
    const { senderId, receiverId, content, senderName } = data;
    const message = new Message({
      sender: senderId,
      receiver: receiverId,
      content,
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
    await Message.findByIdAndUpdate(messageId, { read: true, readAt: Date.now() });
    const senderSocket = onlineUsers[senderId];
    if (senderSocket) {
      io.to(senderSocket).emit('message-read', { messageId });
    }
  });

  socket.on('group-message', async (data) => {
    const { senderId, groupId, content, senderName, groupName } = data;
    const message = new Message({ sender: senderId, group: groupId, content });
    await message.save();
    socket.to(groupId).emit('group-message', {
      senderId,
      senderName,
      groupId,
      content,
      createdAt: message.createdAt
    });
    socket.to(groupId).emit('notification', {
      type: 'group',
      from: senderName,
      groupName: groupName,
      content: content,
      groupId: groupId
    });
  });

  socket.on('join-group', (groupId) => {
    socket.join(groupId);
  });

  // Relay back to sender so their home screen updates preview instantly
  socket.on('update-chat-preview', (data) => {
    socket.emit('update-chat-preview', data);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));