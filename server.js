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
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 8000,
});

// Track online users — declared here so routes can reference it at registration time
const onlineUsers = {};
// Hot-path routing for private receipts. Mongo remains the durable source of truth,
// but live ticks should not wait for a database round trip.
const privateReceiptRoutes = new Map();
const readReceiptPreferences = new Map();

function rememberPrivateReceiptRoute(messageId, senderId, receiverId) {
  const key = String(messageId);
  privateReceiptRoutes.set(key, {
    senderId: String(senderId),
    receiverId: String(receiverId),
  });
  if (privateReceiptRoutes.size > 5000) {
    const oldestKey = privateReceiptRoutes.keys().next().value;
    if (oldestKey) privateReceiptRoutes.delete(oldestKey);
  }
}

function tokenDebugParts(value) {
  const token = String(value || '');
  return {
    tokenLength: token.length,
    tokenPrefix: token.slice(0, 20),
    tokenSuffix: token.slice(-20),
  };
}

app.use(express.json());
// Serve static files; `extensions: ['html']` lets /home serve home.html, etc.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Routes
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/chat', require('./routes/chat')(io, onlineUsers));
app.use('/api/contacts', require('./routes/contacts')(io, onlineUsers));
app.use('/api/profile', require('./routes/profile')(io, onlineUsers));
app.use('/api/calls', require('./routes/calls'));

app.post('/api/calls/decline', async (req, res) => {
  const { callerId } = req.body;
  const callerSocket = onlineUsers[callerId];
  if (callerSocket) {
    io.to(callerSocket).emit('call-rejected');
  }
  res.json({ ok: true });
});

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB!'))
  .catch(err => console.log('❌ MongoDB error:', err));

// SPA fallback — any unknown route serves index.html so the client-side router takes over
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  const getSocketUserId = () => String(socket.data.userId || (
    Object.keys(onlineUsers).find(userId => onlineUsers[userId] === socket.id) || ''
  ));

  async function flushPendingDeliveryReceipts(userId) {
    const deliveredAt = new Date();
    const privateMessages = await Message.find({
      receiver: userId,
      $or: [{ group: null }, { group: { $exists: false } }],
      delivered: { $ne: true },
    }).select('_id sender').sort({ createdAt: -1 }).limit(500);

    for (const message of privateMessages) {
      const updated = await Message.updateOne(
        { _id: message._id, delivered: { $ne: true } },
        { $set: { delivered: true, deliveredAt } }
      );
      if (updated.modifiedCount > 0) {
        io.to(String(message.sender)).emit('message-delivered', {
          messageId: String(message._id),
          deliveredAt,
        });
      }
    }

    const groupIds = await Group.find({
      'members.userId': userId,
      isDeleted: { $ne: true },
    }).distinct('_id');
    if (groupIds.length === 0) return;

    const groupMessages = await Message.find({
      group: { $in: groupIds },
      sender: { $ne: userId },
      deliveredTo: { $not: { $elemMatch: { userId: String(userId) } } },
    }).select('_id sender group').sort({ createdAt: -1 }).limit(500);

    for (const message of groupMessages) {
      const updated = await Message.updateOne(
        { _id: message._id, 'deliveredTo.userId': { $ne: String(userId) } },
        { $push: { deliveredTo: { userId: String(userId), deliveredAt } } }
      );
      if (updated.modifiedCount > 0) {
        io.to(String(message.sender)).emit('group-message-delivered', {
          messageId: String(message._id),
          groupId: String(message.group),
          userId: String(userId),
          deliveredAt,
        });
      }
    }
  }
  console.log('✅ User connected:', socket.id);

  socket.on('user-online', async (userId) => {
    if (!userId || userId === 'null' || userId === 'undefined') return;
    socket.data.userId = String(userId);
    onlineUsers[userId] = socket.id;
    socket.join(String(userId));
    const onlineUser = await User.findByIdAndUpdate(userId, { online: true }, { new: true })
      .select('readReceipts');
    readReceiptPreferences.set(String(userId), onlineUser?.readReceipts !== false);
    io.emit('online-users', Object.keys(onlineUsers));
    try {
      await flushPendingDeliveryReceipts(String(userId));
    } catch (err) {
      console.log('pending_delivery_receipt_flush_error', String(err));
    }
  });

  async function relayAvatarUpdateFromSocket(data, source) {
    const userId = String(data?.userId || data?._id || '').trim();
    const avatarUrl = String(data?.avatarUrl || data?.avatar || '').trim();
    const avatarUpdatedAt = Number(data?.avatarUpdatedAt || Date.now());
    console.log('backend_avatar_update_received', JSON.stringify({
      source,
      userId: userId || null,
      hasAvatar: !!avatarUrl,
      avatarUpdatedAt,
      socketId: socket.id,
    }));
    if (!userId || !avatarUrl) return;
    try {
      const user = await User.findById(userId).select('name contacts');
      const contactRooms = Array.isArray(user?.contacts) ? user.contacts.map(contactId => String(contactId)) : [];
      const rooms = [userId, ...contactRooms];
      const payload = {
        userId,
        avatar: avatarUrl,
        avatarUrl,
        avatarUpdatedAt,
        name: user?.name || data?.name || '',
      };
      rooms.forEach(room => {
        io.to(room).emit('avatar-updated', payload);
        io.to(room).emit('user-profile-updated', payload);
      });
      console.log('backend_avatar_update_broadcasted', JSON.stringify({
        source,
        userId,
        rooms,
        contacts: contactRooms.length,
        hasAvatar: true,
        avatarUpdatedAt,
      }));
    } catch (err) {
      console.log('backend_avatar_update_error', JSON.stringify({
        source,
        userId,
        error: err?.message || String(err),
      }));
    }
  }

  socket.on('avatar-updated', data => {
    relayAvatarUpdateFromSocket(data, 'socket_avatar_updated');
  });

  socket.on('user-profile-updated', data => {
    relayAvatarUpdateFromSocket(data, 'socket_user_profile_updated');
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
    rememberPrivateReceiptRoute(message._id, senderId, receiverId);

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
      // Receiver is online → mark delivered in DB immediately before notifying sender
      // The receiver device confirms delivery with message-delivered. Presence alone is
      // not proof because an onlineUsers entry can briefly outlive a lost network.
    }

    // Send FCM notification (respects messageNotifications setting)
    try {
      const receiver = await User.findById(receiverId);
      if (receiver && receiver.fcmToken && receiver.messageNotifications !== false) {
        const preview = content.startsWith('📷[image]') ? '📷 Photo'
          : content.startsWith('🎤[audio]') || content.includes('[audio]') ? '🎤 Voice message'
          : content;
        // Data-only so native onMessageReceived fires in all app states.
        // Native IncomingCallFirebaseMessagingService shows the notification,
        // queues the message, and queues the delivery receipt.
        const rawContent = String(content || '');
        let fcmPreview = rawContent.includes('[video]') ? 'Video'
          : rawContent.includes('[image]') ? 'Photo'
          : rawContent.includes('[audio]') ? 'Voice message'
          : rawContent.replace(/\s+/g, ' ').trim();
        let contentTruncated = false;
        if (fcmPreview.length > 160) {
          fcmPreview = fcmPreview.slice(0, 160) + '...';
          contentTruncated = true;
        }
        const fcmData = {
          type: 'private_message',
          senderId: senderId.toString(),
          senderName: String(senderName || ''),
          receiverId: receiverId.toString(),
          messageId: message._id.toString(),
          chatId: senderId.toString(),
          content: fcmPreview,
          contentPreview: fcmPreview,
          contentIsPreview: 'true',
          createdAt: message.createdAt.toISOString(),
          notif_title: `💬 ${senderName}`,
          notif_body: fcmPreview,
        };
        console.log('backend_private_message_fcm_content_truncated', JSON.stringify({
          messageId: message._id.toString(),
          originalLength: rawContent.length,
          previewLength: fcmPreview.length,
          truncated: contentTruncated
        }));
        console.log('backend_private_message_fcm_payload_size', JSON.stringify({
          messageId: message._id.toString(),
          bytes: Buffer.byteLength(JSON.stringify(fcmData), 'utf8')
        }));
        console.log('backend_private_message_fcm_payload', JSON.stringify(fcmData));
        console.log('backend_private_message_fcm_token_used', JSON.stringify({
          receiverId: receiverId.toString(),
          messageId: message._id.toString(),
          ...tokenDebugParts(receiver.fcmToken),
        }));
        const { getMessaging } = require('firebase-admin/messaging');
        const fcmResult = await getMessaging().send({
          token: receiver.fcmToken,
          android: { priority: 'high', ttl: 60000 },
          data: fcmData,
        });
        console.log('backend_private_message_fcm_sent', JSON.stringify({ messageId: message._id.toString(), receiverId: receiverId.toString(), ok: !!fcmResult }));
      }
    } catch (err) {
      console.log('FCM error:', err);
    }
  });

  socket.on('message-delivered', async (data) => {
    const { messageId, senderId } = data || {};
    console.log('server_message_delivered_received', JSON.stringify({
      messageId: messageId ? String(messageId) : null,
      senderId: senderId ? String(senderId) : null,
      receiverSocketId: socket.id
    }));
    if (!messageId || !senderId) return;
    try {
      const receiverId = getSocketUserId();
      const route = privateReceiptRoutes.get(String(messageId));
      if (route && receiverId && route.receiverId === String(receiverId) && route.senderId === String(senderId)) {
        const deliveredAt = new Date();
        const serverRelayedAt = Date.now();
        io.to(route.senderId).emit('message-delivered', { messageId, deliveredAt, serverRelayedAt });
        console.log('PRIVATE_DELIVERED_SERVER_RELAY', JSON.stringify({
          messageId: String(messageId),
          senderId: route.senderId,
          receiverId: route.receiverId,
          deliveredAt,
          serverRelayedAt,
          path: 'memory_route',
        }));
        setImmediate(async () => {
          try {
            await Message.updateOne(
              { _id: messageId, receiver: receiverId, delivered: { $ne: true } },
              { $set: { delivered: true, deliveredAt } }
            );
          } catch (error) {
            console.log('server_message_delivered_error', error);
          }
        });
        return;
      }
      const existing = await Message.findById(messageId).select('sender receiver delivered deliveredAt');
      if (!existing || !receiverId || String(existing.receiver) !== String(receiverId)) return;
      if (String(existing.sender) !== String(senderId)) return;
      const targetSenderId = String(existing.sender);
      const deliveredAt = existing.deliveredAt || new Date();
      const senderSocket = onlineUsers[targetSenderId];
      if (senderSocket) {
        const serverRelayedAt = Date.now();
        io.to(targetSenderId).emit('message-delivered', { messageId, deliveredAt, serverRelayedAt });
        console.log('PRIVATE_DELIVERED_SERVER_RELAY', JSON.stringify({
          messageId: String(messageId),
          senderId: targetSenderId,
          receiverId: String(receiverId),
          deliveredAt,
          serverRelayedAt,
          path: 'database_fallback',
        }));
        console.log('server_message_delivered_relayed', JSON.stringify({
          messageId: String(messageId), senderId: targetSenderId, senderSocket,
          persistencePending: !existing.deliveredAt,
        }));
      } else {
        console.log('server_message_delivered_relayed', JSON.stringify({
          messageId: String(messageId), senderId: targetSenderId, senderSocket: null,
          skipped: 'sender_offline'
        }));
      }
      if (existing?.deliveredAt) {
        // deliveredAt already set — preserve original timestamp, do not overwrite
        console.log('message_delivered_db_after', JSON.stringify({
          messageId: String(messageId),
          delivered: existing.delivered,
          deliveredAt: existing.deliveredAt,
          skipped: 'already_set',
        }));
      } else {
        // First delivery — write to DB
        console.log('message_delivered_db_before', JSON.stringify({ messageId: String(messageId) }));
        const updatedDelivered = await Message.findByIdAndUpdate(
          messageId,
          { $set: { delivered: true, deliveredAt } },
          { new: true }
        ).select('delivered deliveredAt');
        console.log('message_delivered_db_after', JSON.stringify({
          messageId: String(messageId),
          delivered: updatedDelivered?.delivered,
          deliveredAt: updatedDelivered?.deliveredAt || null,
        }));
      }
    } catch (err) {
      console.log('server_message_delivered_error', err);
    }
  });

  // Message read
  socket.on('message-read', async (data) => {
    const { messageId, senderId } = data || {};
    console.log('server_message_read_received', JSON.stringify({
      messageId: messageId ? String(messageId) : null,
      senderId: senderId ? String(senderId) : null,
      readerSocketId: socket.id
    }));
    if (!messageId || !senderId) return;
    const readerId = getSocketUserId();
    const route = privateReceiptRoutes.get(String(messageId));
    if (route && readerId && route.receiverId === String(readerId) && route.senderId === String(senderId)) {
      const deliveredAt = new Date();
      const readAt = deliveredAt;
      const shouldRelayRead = readReceiptPreferences.get(String(readerId)) !== false;
      const serverRelayedAt = Date.now();
      if (shouldRelayRead) {
        io.to(route.senderId).emit('message-read', { messageId, readAt, deliveredAt, serverRelayedAt });
        console.log('PRIVATE_READ_SERVER_RELAY', JSON.stringify({
          messageId: String(messageId),
          senderId: route.senderId,
          readerId: route.receiverId,
          readAt,
          deliveredAt,
          serverRelayedAt,
          path: 'memory_route',
        }));
      }
      setImmediate(async () => {
        try {
          await Message.updateOne(
            { _id: messageId, receiver: readerId },
            { $set: { delivered: true, deliveredAt, read: true, readAt } }
          );
        } catch (error) {
          console.log('server_message_read_error', error);
        }
      });
      return;
    }
    const existingMessage = await Message.findById(messageId)
      .select('sender receiver delivered deliveredAt read readAt');
    if (!existingMessage || !readerId || String(existingMessage.receiver) !== String(readerId)) return;
    if (String(existingMessage.sender) !== String(senderId)) return;
    const targetSenderId = String(existingMessage.sender);
    const deliveredAt = existingMessage.deliveredAt || new Date();
    const readAt = existingMessage.readAt || new Date();
    const reader = await User.findById(readerId).select('readReceipts');
    const shouldRelayRead = !reader || reader.readReceipts !== false;

    // Relay after identity/message validation, before persistence. The sender UI should not
    // wait on a Mongo write; the write below remains the durable source of truth.
    const senderSocket = onlineUsers[targetSenderId];
    if (shouldRelayRead && senderSocket) {
      const serverRelayedAt = Date.now();
      io.to(targetSenderId).emit('message-read', { messageId, readAt, deliveredAt, serverRelayedAt });
      console.log('PRIVATE_READ_SERVER_RELAY', JSON.stringify({
        messageId: String(messageId),
        senderId: targetSenderId,
        readerId: String(readerId),
        readAt,
        deliveredAt,
        serverRelayedAt,
        path: 'database_fallback',
      }));
      console.log('server_message_read_relayed', JSON.stringify({
        messageId: String(messageId),
        senderId: targetSenderId,
        senderSocket,
        persistencePending: true,
      }));
    } else if (!shouldRelayRead) {
      console.log('server_message_read_relayed', JSON.stringify({
        messageId: String(messageId),
        senderId: targetSenderId,
        skipped: 'reader_read_receipts_disabled'
      }));
    } else {
      console.log('server_message_read_relayed', JSON.stringify({
        messageId: String(messageId),
        senderId: targetSenderId,
        senderSocket: null,
        skipped: 'sender_offline'
      }));
    }

    console.log('message_read_db_before', JSON.stringify({ messageId: String(messageId) }));
    const updatedRead = await Message.findByIdAndUpdate(
      messageId,
      { $set: { delivered: true, deliveredAt, read: true, readAt } },
      { new: true }
    ).select('read readAt delivered deliveredAt');
    console.log('message_read_db_after', JSON.stringify({
      messageId: String(messageId),
      read: updatedRead?.read,
      readAt: updatedRead?.readAt || null,
      delivered: updatedRead?.delivered,
      deliveredAt: updatedRead?.deliveredAt || null,
    }));
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
    const group = await Group.findById(groupId).select('members isDeleted');
    if (!group || group.isDeleted) {
      console.log('Rejected group-message for missing/deleted group:', groupId);
      socket.emit('group-message-rejected', { groupId, reason: 'group_not_found' });
      return;
    }
    const isMember = group.members.some(member => member.userId.toString() === senderId.toString());
    if (!isMember) {
      console.log('Rejected group-message from non-member:', { senderId, groupId });
      socket.emit('group-message-rejected', { groupId, reason: 'not_member' });
      return;
    }
    const activeOtherCount = group.members.filter(m => m.userId.toString() !== senderId.toString()).length;
    const message = new Message({ sender: senderId, group: groupId, content, replyTo: replyTo || null });
    await message.save();
    // Echo real _id + activeOtherCount back to sender for tick tracking
    socket.emit('group-message-sent', {
      messageId: message._id,
      groupId,
      createdAt: message.createdAt,
      activeOtherCount,
    });
    socket.to(groupId).emit('group-message', {
      senderId,
      senderName,
      groupId,
      content,
      messageId: message._id,
      replyTo: replyTo || null,
      createdAt: message.createdAt,
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
            { type: 'group_message', groupId: groupId.toString(), groupName, senderName, senderId: senderId.toString(), messageId: message._id.toString() }
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

  socket.on('message-deleted', (data) => {
    const { messageId, senderId, receiverId } = data || {};
    if (!messageId || messageId === 'null' || messageId === 'undefined') {
      console.log('Invalid messageId in message-deleted:', messageId);
      return;
    }
    if (!receiverId || receiverId === 'null' || receiverId === 'undefined') {
      console.log('Invalid receiverId in message-deleted:', receiverId);
      return;
    }

    const payload = {
      messageId: String(messageId),
      senderId: senderId ? String(senderId) : '',
      receiverId: String(receiverId),
    };

    io.to(String(receiverId)).emit('message-deleted', payload);
    if (payload.senderId) {
      socket.to(payload.senderId).emit('message-deleted', payload);
    }
    console.log('server_message_deleted_relayed', JSON.stringify(payload));
  });

  socket.on('group-message-reaction', async (data) => {
    const { messageId, emoji, userId, groupId } = data;
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
    if (!emoji || typeof emoji !== 'string') {
      console.log('Invalid emoji in group-message-reaction:', emoji);
      return;
    }
    try {
      const msg = await Message.findById(messageId, { reactions: 1 });
      if (!msg) return;
      const existing = (msg.reactions || []).find(r => String(r.userId) === String(userId));
      const isToggleOff = existing && existing.emoji === emoji;
      await Message.findByIdAndUpdate(messageId, { $pull: { reactions: { userId: String(userId) } } });
      if (!isToggleOff) {
        await Message.findByIdAndUpdate(messageId, { $push: { reactions: { userId: String(userId), emoji } } });
      }
      io.to(String(groupId)).emit('group-message-reaction', {
        messageId,
        userId,
        emoji,
        action: isToggleOff ? 'remove' : 'set',
      });
    } catch (err) {
      console.log('group-message-reaction error:', err);
    }
  });

  socket.on('group-message-delivered', async (data) => {
    const { messageId, groupId, userId } = data || {};
    console.log('SERVER_GROUP_DELIVERED_RECEIVED', JSON.stringify({ messageId, groupId, userId, validMessageId: !!(messageId && messageId !== 'null' && messageId !== 'undefined') }));
    if (!messageId || messageId === 'null' || messageId === 'undefined') return;
    if (!groupId || groupId === 'null' || groupId === 'undefined') return;
    if (!userId || userId === 'null' || userId === 'undefined') return;
    try {
      const receiptUserId = getSocketUserId();
      if (!receiptUserId || String(receiptUserId) !== String(userId)) return;
      const group = await Group.findById(groupId).select('members');
      if (!group) { console.log('SERVER_GROUP_DELIVERED_NO_GROUP', JSON.stringify({ groupId })); return; }
      const isMember = group.members.some(m => m.userId.toString() === userId.toString());
      if (!isMember) { console.log('SERVER_GROUP_DELIVERED_NOT_MEMBER', JSON.stringify({ groupId, userId })); return; }
      const msg = await Message.findById(messageId).select('sender group deliveredTo');
      if (!msg) { console.log('SERVER_GROUP_DELIVERED_NO_MSG', JSON.stringify({ messageId })); return; }
      if (String(msg.group) !== String(groupId) || String(msg.sender) === String(userId)) return;
      const senderId = msg.sender.toString();
      const alreadyDelivered = (msg.deliveredTo || []).some(d => String(d.userId) === String(userId));
      console.log('SERVER_GROUP_DELIVERED_STATE', JSON.stringify({ messageId, groupId, userId, senderId, alreadyDelivered, deliveredToCount: (msg.deliveredTo || []).length }));
      if (!alreadyDelivered) {
        const deliveredAt = new Date();
        const senderSocket = onlineUsers[senderId];
        console.log('SERVER_GROUP_DELIVERED_SENDER_LOOKUP', JSON.stringify({ senderId, senderSocketId: senderSocket || null, senderOnline: !!senderSocket, onlineUserCount: Object.keys(onlineUsers).length }));
        if (senderSocket) {
          io.to(senderId).emit('group-message-delivered', {
            messageId: String(messageId),
            groupId: String(groupId),
            userId: String(userId),
            deliveredAt,
          });
          console.log('SERVER_GROUP_DELIVERED_EMIT_TO_SENDER', JSON.stringify({ messageId, userId, senderId, senderSocket, persistencePending: true }));
        } else {
          console.log('SERVER_GROUP_DELIVERED_SENDER_OFFLINE', JSON.stringify({ senderId, messageId }));
        }
        await Message.findByIdAndUpdate(messageId, {
          $push: { deliveredTo: { userId: String(userId), deliveredAt } }
        });
        console.log('SERVER_GROUP_DELIVERED_SAVED', JSON.stringify({ messageId, userId, senderId }));
      } else {
        console.log('SERVER_GROUP_DELIVERED_ALREADY_SAVED', JSON.stringify({ messageId, userId }));
      }
    } catch (err) {
      console.log('SERVER_GROUP_DELIVERED_ERROR', String(err));
    }
  });

  socket.on('group-message-read', async (data) => {
    const { messageId, groupId, userId } = data || {};
    console.log('group_message_read_received', JSON.stringify({
      messageId: messageId ? String(messageId) : null,
      groupId: groupId ? String(groupId) : null,
      userId: userId ? String(userId) : null,
    }));
    if (!messageId || messageId === 'null' || messageId === 'undefined') {
      console.log('group_message_read_skip', JSON.stringify({ reason: 'missing_messageId' }));
      return;
    }
    if (!groupId || groupId === 'null' || groupId === 'undefined') {
      console.log('group_message_read_skip', JSON.stringify({ reason: 'missing_groupId' }));
      return;
    }
    if (!userId || userId === 'null' || userId === 'undefined') {
      console.log('group_message_read_skip', JSON.stringify({ reason: 'missing_userId' }));
      return;
    }
    try {
      const readerId = getSocketUserId();
      if (!readerId || String(readerId) !== String(userId)) return;
      const group = await Group.findById(groupId).select('members');
      const isMember = group?.members?.some(member => String(member.userId) === String(userId));
      if (!isMember) return;
      const msg = await Message.findById(messageId).select('sender readBy deliveredTo group');
      if (!msg) {
        console.log('group_message_read_skip', JSON.stringify({ reason: 'message_not_found', messageId: String(messageId) }));
        return;
      }
      if (String(msg.group) !== String(groupId)) {
        console.log('group_message_read_skip', JSON.stringify({ reason: 'group_mismatch', msgGroup: String(msg.group), groupId: String(groupId) }));
        return;
      }
      if (!msg.sender) {
        console.log('group_message_read_skip', JSON.stringify({ reason: 'sender_missing', messageId: String(messageId) }));
        return;
      }
      if (String(msg.sender) === String(userId)) {
        console.log('group_message_read_skip', JSON.stringify({ reason: 'sender_self_read', userId: String(userId) }));
        return;
      }
      const alreadyRead = (msg.readBy || []).some(r => String(r.userId) === String(userId));
      const alreadyDelivered = (msg.deliveredTo || []).some(d => String(d.userId) === String(userId));
      if (!alreadyRead || !alreadyDelivered) {
        const readAt = new Date();
        const deliveredAt = alreadyDelivered
          ? (msg.deliveredTo || []).find(d => String(d.userId) === String(userId))?.deliveredAt
          : readAt;
        const push = {};
        if (!alreadyRead) push.readBy = { userId: String(userId), readAt };
        if (!alreadyDelivered) push.deliveredTo = { userId: String(userId), deliveredAt };
        const senderId = msg.sender.toString();
        const senderSocket = onlineUsers[senderId];
        if (senderSocket) {
          io.to(senderId).emit('group-message-read', {
            messageId: String(messageId),
            groupId: String(groupId),
            userId: String(userId),
            readAt,
            deliveredAt,
          });
        } else {
          console.log('group_message_read_skip', JSON.stringify({ reason: 'sender_offline', senderId }));
        }
        const updatedMsg = await Message.findByIdAndUpdate(messageId, {
          $push: push,
        }, { new: true }).select('readBy deliveredTo');
        console.log('group_message_read_db_saved', JSON.stringify({
          messageId: String(messageId),
          userId: String(userId),
          readByLength: (updatedMsg?.readBy || []).length,
        }));
      } else {
        console.log('group_message_read_skipped', JSON.stringify({
          messageId: String(messageId),
          userId: String(userId),
          reason: 'already_read',
          readByLength: (msg.readBy || []).length,
        }));
      }
    } catch (err) {
      console.log('group_message_read_error', String(err));
    }
  });

  socket.on('message-played', async (data) => {
    const { messageId, senderId } = data || {};
    console.log('message_played_received', JSON.stringify({
      messageId: messageId ? String(messageId) : null,
      senderId: senderId ? String(senderId) : null,
      receiverSocketId: socket.id,
    }));
    if (!messageId || !senderId) return;
    try {
      const playerId = getSocketUserId();
      const msg = await Message.findById(messageId).select('sender receiver playedBy');
      if (!msg) return;
      if (!playerId || String(msg.receiver) !== String(playerId)) return;
      if (String(msg.sender) !== String(senderId)) return;
      const alreadyPlayed = (msg.playedBy || []).some(p => String(p.userId) === String(playerId));
      if (!alreadyPlayed && playerId) {
        const playedAt = new Date();
        const targetSenderId = String(msg.sender);
        const senderSocket = onlineUsers[targetSenderId];
        if (senderSocket) {
          io.to(targetSenderId).emit('message-played', { messageId: String(messageId), playedAt });
          console.log('message_played_relayed', JSON.stringify({
            messageId: String(messageId),
            senderSocket,
            persistencePending: true,
          }));
        } else {
          console.log('message_played_relayed', JSON.stringify({
            messageId: String(messageId),
            senderSocket: null,
            skipped: 'sender_offline',
          }));
        }
        await Message.findByIdAndUpdate(messageId, {
          $push: { playedBy: { userId: String(playerId), playedAt } }
        });
        console.log('message_played_db_saved', JSON.stringify({
          messageId: String(messageId),
          playerId: String(playerId),
          playedAt,
        }));
      } else {
        console.log('message_played_skipped', JSON.stringify({
          messageId: String(messageId),
          playerId: String(playerId),
          reason: alreadyPlayed ? 'already_played' : 'no_player_id',
        }));
      }
    } catch (err) {
      console.log('message_played_error', String(err));
    }
  });

  socket.on('group-message-played', async (data) => {
    const { messageId, groupId, userId } = data || {};
    console.log('group_message_played_received', JSON.stringify({
      messageId: messageId ? String(messageId) : null,
      groupId: groupId ? String(groupId) : null,
      userId: userId ? String(userId) : null,
    }));
    if (!messageId || messageId === 'null' || messageId === 'undefined') {
      console.log('group_message_played_skip', JSON.stringify({ reason: 'missing_messageId' }));
      return;
    }
    if (!groupId || groupId === 'null' || groupId === 'undefined') {
      console.log('group_message_played_skip', JSON.stringify({ reason: 'missing_groupId' }));
      return;
    }
    if (!userId || userId === 'null' || userId === 'undefined') {
      console.log('group_message_played_skip', JSON.stringify({ reason: 'missing_userId' }));
      return;
    }
    try {
      const playerId = getSocketUserId();
      if (!playerId || String(playerId) !== String(userId)) return;
      const group = await Group.findById(groupId).select('members');
      const isMember = group?.members?.some(member => String(member.userId) === String(userId));
      if (!isMember) return;
      const msg = await Message.findById(messageId).select('sender playedBy group');
      if (!msg) {
        console.log('group_message_played_skip', JSON.stringify({ reason: 'message_not_found', messageId: String(messageId) }));
        return;
      }
      if (String(msg.group) !== String(groupId)) {
        console.log('group_message_played_skip', JSON.stringify({ reason: 'group_mismatch', msgGroup: String(msg.group), groupId: String(groupId) }));
        return;
      }
      if (!msg.sender) {
        console.log('group_message_played_skip', JSON.stringify({ reason: 'sender_missing', messageId: String(messageId) }));
        return;
      }
      if (String(msg.sender) === String(userId)) {
        console.log('group_message_played_skip', JSON.stringify({ reason: 'sender_self_played', userId: String(userId) }));
        return;
      }
      const alreadyPlayed = (msg.playedBy || []).some(p => String(p.userId) === String(userId));
      if (!alreadyPlayed) {
        const playedAt = new Date();
        const senderId = msg.sender.toString();
        const senderSocket = onlineUsers[senderId];
        if (senderSocket) {
          io.to(senderId).emit('group-message-played', {
            messageId: String(messageId),
            groupId: String(groupId),
            userId: String(userId),
            playedAt,
          });
        } else {
          console.log('group_message_played_skip', JSON.stringify({ reason: 'sender_offline', senderId }));
        }
        const updatedMsg = await Message.findByIdAndUpdate(messageId, {
          $push: { playedBy: { userId: String(userId), playedAt } }
        }, { new: true }).select('playedBy');
        console.log('group_message_played_db_saved', JSON.stringify({
          messageId: String(messageId),
          userId: String(userId),
          playedByLength: (updatedMsg?.playedBy || []).length,
        }));
      } else {
        console.log('group_message_played_skipped', JSON.stringify({
          messageId: String(messageId),
          userId: String(userId),
          reason: 'already_played',
          playedByLength: (msg.playedBy || []).length,
        }));
      }
    } catch (err) {
      console.log('group_message_played_error', String(err));
    }
  });

  socket.on('group-typing', (data) => {
    const { groupId, userId, userName, avatar } = data || {};
    if (!groupId || !userId) return;
    socket.to(String(groupId)).emit('group-typing', { groupId, userId, userName, avatar });
  });

  socket.on('group-stop-typing', (data) => {
    const { groupId, userId } = data || {};
    if (!groupId || !userId) return;
    socket.to(String(groupId)).emit('group-stop-typing', { groupId, userId });
  });

  socket.on('group-recording', (data) => {
    const { groupId, userId, userName, avatar } = data || {};
    if (!groupId || !userId) return;
    socket.to(String(groupId)).emit('group-recording', { groupId, userId, userName, avatar });
  });

  socket.on('group-stop-recording', (data) => {
    const { groupId, userId } = data || {};
    if (!groupId || !userId) return;
    socket.to(String(groupId)).emit('group-stop-recording', { groupId, userId });
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

  socket.on('recording', (data) => {
    const receiverSocket = onlineUsers[data.receiverId];
    console.log('[recording] senderId:', data.senderId, 'receiverId:', data.receiverId, 'receiverSocket:', receiverSocket || 'NOT FOUND');
    if (receiverSocket) {
      io.to(receiverSocket).emit('recording', {
        senderId: data.senderId,
        senderName: data.senderName
      });
    }
  });

  socket.on('stop-recording', (data) => {
    const receiverSocket = onlineUsers[data.receiverId];
    console.log('[stop-recording] senderId:', data.senderId, 'receiverId:', data.receiverId, 'receiverSocket:', receiverSocket || 'NOT FOUND');
    if (receiverSocket) {
      io.to(receiverSocket).emit('stop-recording', {
        senderId: data.senderId
      });
    }
  });

  // Call offer - caller sends to receiver
  socket.on('call-offer', async (data) => {
    const { callerId, callerName, callerAvatar, targetUserId, offer, callType, callId } = data;
    const targetSocket = onlineUsers[targetUserId];
    const clientCallerAvatar = typeof callerAvatar === 'string' ? callerAvatar.trim() : '';
    let resolvedCallerName = callerName;
    let resolvedCallerAvatar = clientCallerAvatar;
    console.log('backend_call_offer_received_avatar', {
      callId,
      callerId,
      targetUserId,
      hasMobileCallerAvatar: !!clientCallerAvatar,
      mobileCallerAvatarLength: clientCallerAvatar.length,
    });
    try {
      const caller = callerId ? await User.findById(callerId).select('name avatar profileImage profilePhoto image photo') : null;
      if (caller) {
        resolvedCallerName = resolvedCallerName || caller.name;
        const dbAvatar = String(
          caller.avatar ||
          caller.profileImage ||
          caller.profilePhoto ||
          caller.image ||
          caller.photo ||
          ''
        ).trim();
        resolvedCallerAvatar = resolvedCallerAvatar || dbAvatar;
      }
      console.log('backend_call_offer_avatar_resolved', {
        callId,
        callerId,
        source: clientCallerAvatar ? 'mobile_payload' : 'mongodb_user',
        hasResolvedAvatar: !!resolvedCallerAvatar,
        resolvedAvatarLength: String(resolvedCallerAvatar || '').length,
      });
    } catch (e) {
      console.log('native_incoming_avatar_backend_resolve_failed', e.message);
    }

    // If receiver is online, deliver via socket immediately
    if (targetSocket) {
      const socketPayload = {
        callId,
        callerId,
        callerName: resolvedCallerName,
        callerAvatar: resolvedCallerAvatar || '',
        offer: typeof offer === 'string' ? offer : JSON.stringify(offer),
        callType: callType || 'voice',
      };
      console.log('backend_incoming_call_socket_avatar_sent', {
        callId,
        callerId,
        targetUserId,
        hasCallerAvatar: !!socketPayload.callerAvatar,
        callerAvatarLength: String(socketPayload.callerAvatar || '').length,
      });
      io.to(targetSocket).emit('incoming-call', socketPayload);
    }

    // Always tell the caller that the ring was sent (even if receiver is offline — FCM covers it)
    socket.emit('call-ringing', {});

    // Send FCM for background/killed receiver (respects callNotifications setting)
    try {
      const receiver = await User.findById(targetUserId);
      if (receiver && receiver.fcmToken && receiver.callNotifications !== false) {
        const { getMessaging } = require('firebase-admin/messaging');
        const fcmData = {
          type: 'incoming_call',
          callId: String(callId || ''),
          callerId: String(callerId),
          callerName: String(resolvedCallerName || 'Unknown'),
          callerAvatar: String(resolvedCallerAvatar || ''),
          offer: typeof offer === 'string' ? offer : JSON.stringify(offer),
          callType: String(callType || 'voice'),
        };
        console.log('backend_incoming_call_fcm_avatar_sent', {
          callId,
          callerId,
          targetUserId,
          hasCallerAvatar: !!fcmData.callerAvatar,
          callerAvatarLength: fcmData.callerAvatar.length,
        });
        console.log('backend_incoming_call_fcm_token_used', {
          callId,
          callerId,
          targetUserId,
          ...tokenDebugParts(receiver.fcmToken),
        });
        await getMessaging().send({
          token: receiver.fcmToken,
          android: {
            priority: 'high',
            ttl: 30000,
          },
          data: fcmData,
        });
        console.log('Call FCM sent to:', receiver.name);
      }
    } catch (e) {
      console.log('Call FCM error:', e.message);
    }

    // Save call log
    try {
      const callLog = new CallLog({
        callerId,
        receiverId: targetUserId,
        callType: callType || 'voice',
        status: 'missed',
      });
      await callLog.save();
      global.pendingCallLogs = global.pendingCallLogs || {};
      global.pendingCallLogs[`${callerId}-${targetUserId}`] = callLog._id;
    } catch (e) {
      console.log('CallLog error:', e);
    }
  });

  // Receiver accepted — relay to caller so they join Stream
  async function relayCallCancel(eventName, data) {
    console.log('server_call_cancel_received', {
      eventName,
      callId: data && data.callId ? data.callId : null,
      callerId: data && data.callerId ? data.callerId : null,
      targetUserId: data && data.targetUserId ? data.targetUserId : null,
      receiverId: data && data.receiverId ? data.receiverId : null,
      to: data && data.to ? data.to : null,
      socketId: socket.id,
    });

    const targetUserId = data && (data.targetUserId || data.receiverId || data.to);
    const targetSocket = targetUserId ? onlineUsers[targetUserId] : null;

    console.log('server_call_cancel_target_user', {
      eventName,
      callId: data && data.callId ? data.callId : null,
      targetUserId: targetUserId || null,
      targetSocket: targetSocket || null,
    });

    if (!targetUserId) return;

    const payload = {
      ...data,
      callId: data && data.callId ? data.callId : '',
      callerId: data && data.callerId ? data.callerId : '',
      targetUserId,
      reason: data && data.reason ? data.reason : 'caller_cancel_before_answer',
    };

    if (targetSocket) {
      io.to(targetSocket).emit('call-cancel', payload);
      io.to(targetSocket).emit('call-end-before-answer', payload);
    }
    io.to(String(targetUserId)).emit('call-cancel', payload);
    io.to(String(targetUserId)).emit('call-end-before-answer', payload);

    console.log('server_call_cancel_emit_success', {
      eventName,
      callId: payload.callId || null,
      targetUserId,
      targetSocket: targetSocket || null,
    });

    try {
      const receiver = await User.findById(targetUserId);
      if (receiver && receiver.fcmToken && receiver.callNotifications !== false) {
        const { getMessaging } = require('firebase-admin/messaging');
        await getMessaging().send({
          token: receiver.fcmToken,
          android: {
            priority: 'high',
            ttl: 30000,
          },
          data: {
            type: 'call_cancel',
            callId: String(payload.callId || ''),
            callerId: String(payload.callerId || ''),
            reason: String(payload.reason || 'caller_cancel_before_answer'),
          },
        });
        console.log('backend_call_cancel_fcm_sent', {
          eventName,
          callId: payload.callId || null,
          callerId: payload.callerId || null,
          targetUserId,
        });
      }
    } catch (e) {
      console.log('backend_call_cancel_fcm_error', {
        eventName,
        callId: payload.callId || null,
        targetUserId,
        error: e.message,
      });
    }
  }

  socket.on('call-cancel', (data) => {
    relayCallCancel('call-cancel', data);
  });

  socket.on('call-end-before-answer', (data) => {
    relayCallCancel('call-end-before-answer', data);
  });

  socket.on('call-answered-stream', (data) => {
    const { callerId } = data;
    const callerSocket = onlineUsers[callerId];
    if (callerSocket) {
      io.to(callerSocket).emit('call-answered-stream');
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
  socket.on('call-end', async (data) => {
    const { targetUserId } = data;
    const targetSocket = onlineUsers[targetUserId];
    if (targetSocket) {
      io.to(targetSocket).emit('call-ended');
    }

    // If the call log is still 'missed' (never answered), notify receiver
    try {
      const key = Object.keys(global.pendingCallLogs || {}).find(k => k.endsWith(`-${targetUserId}`));
      if (key && global.pendingCallLogs[key]) {
        const log = await CallLog.findById(global.pendingCallLogs[key]);
        if (log && log.status === 'missed') {
          const receiver = await User.findById(targetUserId);
          const caller = await User.findById(log.callerId);
          const callerName = caller ? caller.name : 'Someone';

          // Socket event for online receivers — instant in-app notification
          if (targetSocket) {
            io.to(targetSocket).emit('missed-call', {
              callerId: String(log.callerId),
              callerName,
              callType: log.callType,
            });
          }

          // FCM for background/killed receivers (respects callNotifications)
          if (receiver && receiver.fcmToken && receiver.callNotifications !== false) {
            const { getMessaging } = require('firebase-admin/messaging');
            await getMessaging().send({
              token: receiver.fcmToken,
              notification: {
                title: '📵 Missed call',
                body: `You missed a ${log.callType} call from ${callerName}`,
              },
              data: {
                type: 'missed_call',
                callerId: String(log.callerId),
                callerName: String(callerName),
                callType: String(log.callType),
              },
              android: { priority: 'high' },
            });
          }
        }
        delete global.pendingCallLogs[key];
      }
    } catch (e) {
      console.log('Missed call notification error:', e.message);
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

  // Camera on/off — relay to the other peer so they can show a placeholder
  socket.on('camera-toggle', (data) => {
    const { targetUserId, cameraOff } = data;
    const targetSocket = onlineUsers[targetUserId];
    if (targetSocket) {
      io.to(targetSocket).emit('camera-toggle', { cameraOff });
    }
  });

  socket.on('disconnect', async () => {
    const userId = String(socket.data.userId || Object.keys(onlineUsers).find(k => onlineUsers[k] === socket.id) || '');
    if (userId && onlineUsers[userId] === socket.id) {
      delete onlineUsers[userId];
      const lastSeen = Date.now();
      await User.findByIdAndUpdate(userId, { online: false, lastSeen });
      io.emit('user-last-seen', { userId, lastSeen });
      io.emit('online-users', Object.keys(onlineUsers));
    }
  });
});

setInterval(() => {
  fetch('https://zg-connect-production.up.railway.app/api/health').catch(() => {});
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
