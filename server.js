require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const Message = require('./models/Message');
const User = require('./models/User');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/chat', require('./routes/chat'));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB!'))
  .catch(err => console.log('❌ MongoDB error:', err));

// Serve frontend
app.get('*', (req, res) => {
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
    const message = new Message({ sender: senderId, receiver: receiverId, content });
    await message.save();
    const receiverSocket = onlineUsers[receiverId];
    if (receiverSocket) {
      io.to(receiverSocket).emit('private-message', {
        senderId,
        senderName,
        receiverId,
        content,
        createdAt: message.createdAt
      });
      io.to(receiverSocket).emit('notification', {
        type: 'private',
        from: senderName,
        content: content,
        senderId: senderId
      });
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
      await User.findByIdAndUpdate(userId, { online: false, lastSeen: Date.now() });
      io.emit('online-users', Object.keys(onlineUsers));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));