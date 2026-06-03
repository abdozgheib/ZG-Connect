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
  console.log('✅ User connected:', socket.id);

  socket.on('user-online', async (userId) => {
    if (!userId || userId === 'null' || userId === 'undefined') return;
    onlineUsers[userId] = socket.id;
    socket.join(String(userId));
    await User.findByIdAndUpdate(userId, { online: true });
    io.emit('online-users', Object.keys(onlineUsers));
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
      await Message.findByIdAndUpdate(messageId, { delivered: true, deliveredAt: Date.now() });
      const senderSocket = onlineUsers[senderId];
      if (senderSocket) {
        io.to(senderSocket).emit('message-delivered', { messageId });
        console.log('server_message_delivered_relayed', JSON.stringify({
          messageId: String(messageId),
          senderId: String(senderId),
          senderSocket
        }));
      } else {
        console.log('server_message_delivered_relayed', JSON.stringify({
          messageId: String(messageId),
          senderId: String(senderId),
          senderSocket: null,
          skipped: 'sender_offline'
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
    await Message.findByIdAndUpdate(messageId, { read: true, readAt: Date.now() });
    // Only forward read receipt if the reader has read receipts enabled
    const readerId = Object.keys(onlineUsers).find(k => onlineUsers[k] === socket.id);
    if (readerId) {
      const reader = await User.findById(readerId).select('readReceipts');
      if (reader && reader.readReceipts === false) {
        console.log('server_message_read_relayed', JSON.stringify({
          messageId: String(messageId),
          senderId: String(senderId),
          skipped: 'reader_read_receipts_disabled'
        }));
        return;
      }
    }
    const senderSocket = onlineUsers[senderId];
    if (senderSocket) {
      io.to(senderSocket).emit('message-read', { messageId });
      console.log('server_message_read_relayed', JSON.stringify({
        messageId: String(messageId),
        senderId: String(senderId),
        senderSocket
      }));
    } else {
      console.log('server_message_read_relayed', JSON.stringify({
        messageId: String(messageId),
        senderId: String(senderId),
        senderSocket: null,
        skipped: 'sender_offline'
      }));
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
  fetch('https://zg-connect-production.up.railway.app/api/health').catch(() => {});
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
