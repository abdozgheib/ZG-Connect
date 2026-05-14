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

  // User comes online
  socket.on('user-online', async (userId) => {
    onlineUsers[userId] = socket.id;
    await User.findByIdAndUpdate(userId, { online: true });
    io.emit('online-users', Object.keys(onlineUsers));
  });

  // Private message
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
      // Send notification
      io.to(receiverSocket).emit('notification', {
        type: 'private',
        from: senderName,
        content: content,
        senderId: senderId
      });
    }
  });

  // Group message
  socket.on('group-message', async (data) => {
    const { se