const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Message = require('../models/Message');
const Group = require('../models/Group');

function getMyRole(group, userId) {
  const m = group.members.find(m => m.userId.toString() === userId);
  return m ? m.role : null;
}

module.exports = (io, onlineUsers) => {
  const router = express.Router();

  const populatedGroupQuery = (groupId) => Group.findById(groupId)
    .populate('members.userId', 'name avatar')
    .populate('formerMembers.userId', 'name avatar')
    .populate('formerMembers.removedBy', 'name avatar');

  const getGroupMemberIds = (group) => {
    if (!group || !Array.isArray(group.members)) return [];
    return group.members
      .map((member) => member?.userId?._id || member?.userId)
      .filter(Boolean)
      .map((id) => id.toString());
  };

  const emitToUserRooms = (userIds, eventName, payload) => {
    const uniqueIds = [...new Set((userIds || []).filter(Boolean).map((id) => id.toString()))];
    uniqueIds.forEach((userId) => {
      const socketId = onlineUsers[userId];
      const target = socketId ? io.to(userId).to(socketId) : io.to(userId);
      target.emit(eventName, payload);
    });
  };

  const emitGroupAdded = (group, userIds, includeCreatedEvent = false) => {
    const payload = { groupId: group._id.toString(), group };
    emitToUserRooms(userIds, 'group-added', payload);
    if (includeCreatedEvent) emitToUserRooms(userIds, 'group-created', payload);
  };

  const emitGroupUpdated = (group, userIds) => {
    const payload = { groupId: group._id.toString(), group };
    emitToUserRooms(userIds, 'group-updated', payload);
    io.to(group._id.toString()).emit('group-updated', payload);
  };


  // Get last message preview for all contacts in ONE query
  router.get('/previews', auth, async (req, res) => {
    try {
      const myId = new mongoose.Types.ObjectId(req.user.id);
      const me = await User.findById(req.user.id).select('contacts');
      if (!me || !me.contacts.length) return res.json({});

      const results = await Message.aggregate([
        {
          $match: {
            group: { $exists: false },
            $or: [{ sender: myId }, { receiver: myId }]
          }
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: {
              $cond: {
                if: { $eq: ['$sender', myId] },
                then: '$receiver',
                else: '$sender'
              }
            },
            content: { $first: '$content' },
            createdAt: { $first: '$createdAt' },
            deleted: { $first: '$deleted' }
          }
        },
        { $match: { _id: { $in: me.contacts } } }
      ]);

      const map = {};
      results.forEach(r => {
        map[r._id.toString()] = {
          content: r.deleted ? 'This message was deleted' : r.content,
          createdAt: r.createdAt
        };
      });
      res.json(map);
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Get all contacts
  router.get('/users', auth, async (req, res) => {
    try {
      const me = await User.findById(req.user.id).populate('contacts', '-password');
      res.json(me.contacts);
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Get private messages
  router.get('/messages/:userId', auth, async (req, res) => {
    try {
      const messages = await Message.find({
        $or: [
          { sender: req.user.id, receiver: req.params.userId },
          { sender: req.params.userId, receiver: req.user.id }
        ]
      }).sort({ createdAt: 1 });
      res.json(messages);
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Create group (new UI) — creator becomes owner, notifies members
  router.post('/groups/create', auth, async (req, res) => {
    try {
      console.log('Create group request body:', req.body);
      console.log('Create group user:', req.user);

      const { name, avatar, memberIds, description } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({ message: 'Group name is required' });
      }
      if (!memberIds || memberIds.length === 0) {
        return res.status(400).json({ message: 'Add at least one member' });
      }

      const memberDocs = memberIds.map(id => ({ userId: id, role: 'member', joinedAt: new Date() }));
      const group = new Group({
        name: name.trim(),
        description: description || '',
        avatar: avatar || '',
        owner: req.user.id,
        members: [{ userId: req.user.id, role: 'owner', joinedAt: new Date() }, ...memberDocs]
      });
      await group.save();
      console.log('Group created:', group._id);

      const populated = await populatedGroupQuery(group._id);
      emitGroupAdded(populated, getGroupMemberIds(populated), true);

      res.json(populated);
    } catch (err) {
      console.log('Create group error:', err);
      res.status(500).json({ message: 'Could not create group: ' + err.message });
    }
  });

  // Create group — creator becomes owner
  router.post('/groups', auth, async (req, res) => {
    try {
      const { name, members } = req.body;
      const memberDocs = (members || []).map(id => ({ userId: id, role: 'member' }));
      const group = new Group({
        name,
        members: [{ userId: req.user.id, role: 'owner' }, ...memberDocs]
      });
      await group.save();
      const populated = await populatedGroupQuery(group._id);
      emitGroupAdded(populated, getGroupMemberIds(populated), true);
      res.json(populated);
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Get my groups
  router.get('/groups', auth, async (req, res) => {
    try {
      const groups = await Group.find({
        isDeleted: { $ne: true },
        $or: [{ 'members.userId': req.user.id }, { 'formerMembers.userId': req.user.id }]
      })
        .populate('members.userId', 'name avatar')
        .populate('formerMembers.userId', 'name avatar')
        .populate('formerMembers.removedBy', 'name avatar');

      const result = [];
      for (const group of groups) {
        try {
          const obj = group.toObject();
          const members = Array.isArray(obj.members) ? obj.members : [];
          const formerMembers = Array.isArray(obj.formerMembers) ? obj.formerMembers : [];
          // After populate, userId may be a User doc (has ._id) or null (deleted user).
          // Use String(m.userId?._id || m.userId || '') to safely handle both cases.
          const resolveId = (ref) => String(ref?._id || ref || '');
          obj.isParticipant = members.some(m => m.userId && resolveId(m.userId) === req.user.id);
          obj.isFormerMember = !obj.isParticipant && formerMembers.some(m => m.userId && resolveId(m.userId) === req.user.id);
          result.push(obj);
        } catch (groupErr) {
          console.error('[GET /groups] failed to map group', group?._id, groupErr);
        }
      }
      res.json(result);
    } catch (err) {
      console.error('[GET /groups] fatal error:', err);
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Get group messages
  router.get('/groups/:groupId/messages', auth, async (req, res) => {
    try {
      const group = await Group.findById(req.params.groupId);
      if (!group || group.isDeleted) {
        return res.status(404).json({ message: 'Group not found!' });
      }
      const isMember = group.members.some(m => m.userId.toString() === req.user.id);
      const isFormerMember = (group.formerMembers || []).some(m => m.userId.toString() === req.user.id);
      if (!isMember && !isFormerMember) {
        return res.status(403).json({ message: 'Not a group participant!' });
      }

      const messages = await Message.find({ group: req.params.groupId })
        .populate('sender', 'name')
        .sort({ createdAt: 1 });
      res.json(messages);
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Private chat all media (images, audio, links)
  router.get('/media-all/:userId', auth, async (req, res) => {
    try {
      const messages = await Message.find({
        $and: [
          {
            $or: [
              { sender: req.user.id, receiver: req.params.userId },
              { sender: req.params.userId, receiver: req.user.id }
            ]
          },
          {
            $or: [
              { content: { $regex: '^📷' } },
              { content: { $regex: '^🎤' } },
              { content: { $regex: 'https?://' } }
            ]
          }
        ],
        deleted: { $ne: true }
      }).sort({ createdAt: -1 });
      res.json(messages);
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Get group media (images)
  router.get('/groups/:groupId/media', auth, async (req, res) => {
    try {
      const group = await Group.findById(req.params.groupId);
      if (!group) return res.status(404).json({ message: 'Group not found!' });
      const isMember = group.members.some(m => m.userId.toString() === req.user.id);
      if (!isMember) return res.status(403).json({ message: 'Not a member!' });
      const messages = await Message.find({
        group: req.params.groupId,
        content: { $regex: '^📷\\[image\\]' },
        deleted: { $ne: true }
      }).sort({ createdAt: -1 }).limit(50);
      const media = messages.map(m => {
        const parts = m.content.replace('📷[image]', '').split('[caption]');
        return { _id: m._id, url: parts[0], caption: parts[1] || '', createdAt: m.createdAt };
      });
      res.json(media);
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Group all media (images, audio, links)
  router.get('/groups/:groupId/all-media', auth, async (req, res) => {
    try {
      const group = await Group.findById(req.params.groupId);
      if (!group) return res.status(404).json({ message: 'Group not found!' });
      const isMember = group.members.some(m => m.userId.toString() === req.user.id);
      if (!isMember) return res.status(403).json({ message: 'Not a member!' });
      const messages = await Message.find({
        group: req.params.groupId,
        $or: [
          { content: { $regex: '^📷' } },
          { content: { $regex: '^🎤' } },
          { content: { $regex: 'https?://' } }
        ],
        deleted: { $ne: true }
      }).sort({ createdAt: -1 });
      res.json(messages);
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Get group details (members + roles)
  router.get('/groups/:groupId', auth, async (req, res) => {
    try {
      const group = await Group.findById(req.params.groupId)
        .populate('members.userId', 'name avatar')
        .populate('formerMembers.userId', 'name avatar')
        .populate('formerMembers.removedBy', 'name avatar');
      if (!group) return res.status(404).json({ message: 'Group not found!' });
      const isMember = group.members.some(
        m => m.userId && m.userId._id.toString() === req.user.id
      );
      const isFormerMember = (group.formerMembers || []).some(
        m => m.userId && m.userId._id.toString() === req.user.id
      );
      if (!isMember && !isFormerMember) return res.status(403).json({ message: 'Not a member!' });
      const obj = group.toObject();
      obj.isParticipant = isMember;
      obj.isFormerMember = !isMember && isFormerMember;
      res.json(obj);
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Add member — owner or admin only
  router.post('/groups/:groupId/add-member', auth, async (req, res) => {
    try {
      const group = await Group.findById(req.params.groupId);
      if (!group) return res.status(404).json({ message: 'Group not found!' });
      const myRole = getMyRole(group, req.user.id);
      if (!['owner', 'admin'].includes(myRole)) {
        return res.status(403).json({ message: 'Only owner or admin can add members!' });
      }
      const { userId } = req.body;
      if (group.members.some(m => m.userId.toString() === userId)) {
        return res.status(400).json({ message: 'Already a member!' });
      }
      const existingMemberIds = getGroupMemberIds(group);
      group.formerMembers = (group.formerMembers || []).filter(m => m.userId.toString() !== userId);
      group.members.push({ userId, role: 'member' });
      await group.save();
      const updated = await populatedGroupQuery(group._id);
      const [addedUser, adder] = await Promise.all([
        User.findById(userId).select('name'),
        User.findById(req.user.id).select('name'),
      ]);
      const memberAddedPayload = {
        groupId: group._id.toString(),
        userId: userId.toString(),
        userName: addedUser?.name || 'Someone',
        addedByName: adder?.name || 'Admin',
        group: updated,
      };
      emitGroupAdded(updated, [userId]);
      emitGroupUpdated(updated, existingMemberIds);
      emitToUserRooms([userId, ...existingMemberIds], 'group-member-added', memberAddedPayload);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Remove member — owner or admin only
  router.post('/groups/:groupId/remove-member', auth, async (req, res) => {
    try {
      const group = await Group.findById(req.params.groupId);
      if (!group) return res.status(404).json({ message: 'Group not found!' });
      const myRole = getMyRole(group, req.user.id);
      if (!['owner', 'admin'].includes(myRole)) {
        return res.status(403).json({ message: 'Only owner or admin can remove members!' });
      }
      const { userId } = req.body;
      const target = group.members.find(m => m.userId.toString() === userId);
      if (!target) return res.status(404).json({ message: 'Member not found!' });
      if (myRole === 'admin' && ['owner', 'admin'].includes(target.role)) {
        return res.status(403).json({ message: 'Admins can only remove regular members!' });
      }
      group.members = group.members.filter(m => m.userId.toString() !== userId);
      group.formerMembers = (group.formerMembers || []).filter(m => m.userId.toString() !== userId);
      group.formerMembers.push({ userId, removedBy: req.user.id, removedAt: new Date(), reason: 'removed' });
      await group.save();
      const updated = await populatedGroupQuery(group._id);
      const remover = await User.findById(req.user.id).select('name');
      const remainingMemberIds = getGroupMemberIds(updated);
      emitGroupUpdated(updated, remainingMemberIds);
      emitToUserRooms([userId], 'group-member-removed', {
        groupId: group._id.toString(),
        userId: userId.toString(),
        removedBy: req.user.id,
        removedByName: remover?.name || 'Admin',
        group: updated
      });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Promote member to admin — owner only
  router.post('/groups/:groupId/promote', auth, async (req, res) => {
    try {
      const group = await Group.findById(req.params.groupId);
      if (!group) return res.status(404).json({ message: 'Group not found!' });
      if (getMyRole(group, req.user.id) !== 'owner') {
        return res.status(403).json({ message: 'Only owner can promote members!' });
      }
      const { userId } = req.body;
      const member = group.members.find(m => m.userId.toString() === userId);
      if (!member) return res.status(404).json({ message: 'Member not found!' });
      if (member.role !== 'member') {
        return res.status(400).json({ message: 'Can only promote regular members!' });
      }
      member.role = 'admin';
      await group.save();
      const updated = await populatedGroupQuery(group._id);
      emitGroupUpdated(updated, getGroupMemberIds(updated));
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Demote admin to member — owner only
  router.post('/groups/:groupId/demote', auth, async (req, res) => {
    try {
      const group = await Group.findById(req.params.groupId);
      if (!group) return res.status(404).json({ message: 'Group not found!' });
      if (getMyRole(group, req.user.id) !== 'owner') {
        return res.status(403).json({ message: 'Only owner can demote admins!' });
      }
      const { userId } = req.body;
      const member = group.members.find(m => m.userId.toString() === userId);
      if (!member) return res.status(404).json({ message: 'Member not found!' });
      if (member.role !== 'admin') {
        return res.status(400).json({ message: 'Can only demote admins!' });
      }
      member.role = 'member';
      await group.save();
      const updated = await populatedGroupQuery(group._id);
      emitGroupUpdated(updated, getGroupMemberIds(updated));
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Edit group name/avatar — owner or admin only
  router.put('/groups/:groupId/edit', auth, async (req, res) => {
    try {
      const group = await Group.findById(req.params.groupId);
      if (!group) return res.status(404).json({ message: 'Group not found!' });
      const myRole = getMyRole(group, req.user.id);
      if (!['owner', 'admin'].includes(myRole)) {
        return res.status(403).json({ message: 'Only owner or admin can edit group info!' });
      }
      const { name, avatar } = req.body;
      if (name) group.name = name.trim();
      if (avatar !== undefined) group.avatar = avatar;
      await group.save();
      const updated = await populatedGroupQuery(group._id);
      emitGroupUpdated(updated, getGroupMemberIds(updated));
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Leave group — any member; owner transfers ownership first
  router.post('/groups/:groupId/leave', auth, async (req, res) => {
    try {
      const group = await Group.findById(req.params.groupId);
      if (!group) return res.status(404).json({ message: 'Group not found!' });
      const myRole = getMyRole(group, req.user.id);
      if (!myRole) return res.status(400).json({ message: 'Not a member!' });

      if (myRole === 'owner') {
        const others = group.members.filter(m => m.userId.toString() !== req.user.id);
        if (others.length === 0) {
          await Group.findByIdAndDelete(req.params.groupId);
          await Message.deleteMany({ group: req.params.groupId });
          emitToUserRooms([req.user.id], 'group-left', {
            groupId: req.params.groupId,
            userId: req.user.id,
            deleted: true
          });
          return res.json({ message: 'Group deleted!' });
        }
        // Transfer to oldest admin, fallback to first member
        const newOwner = others.find(m => m.role === 'admin') || others[0];
        newOwner.role = 'owner';
      }

      const leavingUser = await User.findById(req.user.id).select('name');
      group.members = group.members.filter(m => m.userId.toString() !== req.user.id);
      group.formerMembers = (group.formerMembers || []).filter(m => m.userId.toString() !== req.user.id);
      group.formerMembers.push({ userId: req.user.id, removedBy: req.user.id, removedAt: new Date(), reason: 'left' });
      await group.save();
      const updated = await populatedGroupQuery(group._id);
      const remainingMemberIds = getGroupMemberIds(updated);
      emitToUserRooms(remainingMemberIds, 'group-member-left', {
        groupId: req.params.groupId,
        userId: req.user.id,
        userName: leavingUser?.name || 'Someone',
        group: updated
      });
      emitGroupUpdated(updated, remainingMemberIds);
      emitToUserRooms([req.user.id], 'group-left', {
        groupId: req.params.groupId,
        userId: req.user.id,
        removedBy: req.user.id,
        removedByName: leavingUser?.name || 'You',
        group: updated
      });
      res.json({ message: 'Left group!' });
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Delete group — owner only (soft delete)
  router.delete('/groups/:groupId', auth, async (req, res) => {
    try {
      const group = await Group.findById(req.params.groupId);
      if (!group) return res.status(404).json({ message: 'Group not found!' });
      if (getMyRole(group, req.user.id) !== 'owner') {
        return res.status(403).json({ message: 'Only owner can delete the group!' });
      }
      const memberIds = getGroupMemberIds(group);
      await Group.findByIdAndUpdate(req.params.groupId, { isDeleted: true });
      emitToUserRooms(memberIds, 'group-updated', { groupId: req.params.groupId, deleted: true });
      io.to(req.params.groupId).emit('group-updated', { groupId: req.params.groupId, deleted: true });
      res.json({ message: 'Group deleted!' });
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Delete message
  router.delete('/messages/:messageId', auth, async (req, res) => {
    try {
      const message = await Message.findById(req.params.messageId);
      if (!message) return res.status(404).json({ message: 'Message not found!' });
      if (message.sender.toString() !== req.user.id) {
        return res.status(403).json({ message: 'You can only delete your own messages!' });
      }
      await Message.findByIdAndUpdate(req.params.messageId, {
        deleted: true,
        content: 'This message was deleted'
      });
      if (message.group) {
        io.to(String(message.group)).emit('group-message-deleted', {
          messageId: String(message._id),
          groupId: String(message.group),
        });
      }
      res.json({ message: 'Message deleted!' });
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Delete chat (all messages between two users)
  router.delete('/chat/:userId', auth, async (req, res) => {
    try {
      await Message.deleteMany({
        $or: [
          { sender: req.user.id, receiver: req.params.userId },
          { sender: req.params.userId, receiver: req.user.id }
        ]
      });
      res.json({ message: 'Chat deleted!' });
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  // Storage stats for the current user
  router.get('/stats', auth, async (req, res) => {
    try {
      const myId = new mongoose.Types.ObjectId(req.user.id);
      const messages = await Message.countDocuments({
        $or: [{ sender: myId }, { receiver: myId }]
      });
      const me = await User.findById(req.user.id).select('contacts');
      const groups = await Group.countDocuments({ 'members.userId': myId });
      res.json({ messages, contacts: me.contacts.length, groups });
    } catch (err) {
      res.status(500).json({ message: 'Something went wrong!' });
    }
  });

  return router;
};
