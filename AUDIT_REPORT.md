# Message Storage and Delivery Architecture Audit

Read-only audit completed on 2026-07-09. No files were modified during the audit.

## 1. Message Schema

`models/Message.js` defines permanent message storage.

Important fields:

```js
sender
receiver
group
content
delivered
read
readAt
deliveredAt
deleted
deletedFor
forwarded
forwardedCount
starredBy
pinnedBy
edited
editedAt
pollVotes
replyTo
reactions
readBy
deliveredTo
playedBy
```

Delivery/read tracking is mixed:

- Private chats use message-level booleans: `delivered`, `read`, `deliveredAt`, `readAt`.
- Group chats use per-user arrays:
  - `deliveredTo: [{ userId, deliveredAt }]`
  - `readBy: [{ userId, readAt }]`
  - `playedBy: [{ userId, playedAt }]`

So group delivery/read is already per-member at the `Message` level, not just group-level.

There is also `models/TempMessageQueue.js`, which looks closer to the desired WhatsApp-style direction. It stores:

```js
scope
sender
receiver
group
content
messageType
recipients: [{ userId, delivered, deliveredAt }]
delivered
deliveredAt
expiresAt
```

It has a Mongo TTL index on `expiresAt`.

## 2. Socket.io Send Flow

Private send starts in `server.js`:

```js
socket.on('private-message', async (data) => {
```

Current sequence:

1. Validate `senderId`, `receiverId`, `content`.
2. Load sender and receiver users.
3. Check block lists.
4. Build `messagePayload`.
5. Choose storage mode:

```js
const message = STOP_PERMANENT_MESSAGE_WRITES
  ? createRelayMessage(...)
  : new Message(messagePayload);
```

6. If `STOP_PERMANENT_MESSAGE_WRITES` is false, it saves to Mongo first with `await message.save()`.
7. Otherwise it creates an in-memory relay message only.
8. It creates a `TempMessageQueue` item.
9. It emits `message-sent` to sender.
10. If receiver is online, it emits `private-message` to receiver.
11. It sends FCM push afterward.

Important config in `server.js`:

```js
const USE_TEMP_QUEUE = process.env.USE_TEMP_QUEUE !== 'false';
const STOP_PERMANENT_MESSAGE_WRITES = USE_TEMP_QUEUE;
```

So by default, new socket-sent messages are not permanently saved to `Message`; they are relayed and stored temporarily in `TempMessageQueue`.

Group send starts in `server.js`:

```js
socket.on('group-message', async (data) => {
```

It follows the same pattern:

- validates sender/group/content
- checks group membership
- builds `groupMessagePayload`
- saves only if permanent writes are enabled
- creates temp queue
- emits `group-message-sent` to sender
- emits `group-message` to other group members

## 3. Delivery / Read Receipts

There is already a mechanism for "user X received message Y."

Private delivery receipt:

- Event: `message-delivered`
- Handler: `socket.on('message-delivered', async (data) => { ... })`
- It identifies the receiving socket user via `getSocketUserId()`.
- It uses `privateReceiptRoutes`, an in-memory map.
- It calls `ackTempQueueDelivery({ scope: 'private', ... })`.
- It emits `message-delivered` back to sender.

Group delivery receipt:

- Event: `group-message-delivered`
- Handler: `socket.on('group-message-delivered', async (data) => { ... })`
- Verifies user is a group member.
- Loads `Message.deliveredTo`, or falls back to `TempMessageQueue.recipients`.
- Calls `ackTempQueueDelivery({ scope: 'group', ... })`.
- Emits `group-message-delivered` back to sender.
- If permanent writes are enabled, pushes into `deliveredTo`.

Read receipts:

- Private read handler: `socket.on('message-read', async (data) => { ... })`
- Group read handler: `socket.on('group-message-read', async (data) => { ... })`
- Group read pushes into `readBy` and also `deliveredTo` if needed.

There is also `flushPendingDeliveryReceipts(userId)`, called when a user comes online. It scans existing `Message` documents and marks undelivered private/group messages as delivered.

## 4. Message History Fetch

REST history is in `routes/chat.js`.

Private chat history:

```js
router.get('/messages/:userId', auth, async (req, res) => {
  const messages = await Message.find({
    $or: [
      { sender: req.user.id, receiver: req.params.userId },
      { sender: req.params.userId, receiver: req.user.id }
    ]
  }).sort({ createdAt: 1 });
});
```

Group history:

```js
router.get('/groups/:groupId/messages', auth, async (req, res) => {
  const messages = await Message.find({ group: req.params.groupId })
    .populate('sender', 'name')
    .sort({ createdAt: 1 });
});
```

Mobile app call sites were also observed in the `ZG` workspace during the audit:

- Private history: `app/chat.tsx`
- Group history: `app/groupchat.tsx`
- Chat previews: `app/home.tsx`

## 5. Groups / Per-Member Delivery

Group membership is in `models/Group.js`:

```js
members: [{
  userId,
  role,
  joinedAt
}]
```

Former members are tracked separately:

```js
formerMembers: [{
  userId,
  removedBy,
  removedAt,
  reason
}]
```

Per-member delivery is not stored on the group membership record. It is stored per message:

- `Message.deliveredTo[]`
- `Message.readBy[]`
- `Message.playedBy[]`

For temp queue mode, per-recipient delivery is stored on `TempMessageQueue.recipients[]`.

## 6. Cleanup / Expiry

Existing cleanup exists for `TempMessageQueue`, not for permanent `Message` history.

- TTL index exists on `TempMessageQueue.expiresAt`.
- Manual hourly cleanup exists via `cleanupExpiredTempQueue()`.
- `ackTempQueueDelivery()` deletes the temp queue item after all recipients are delivered.

I did not find an automatic cleanup job that deletes permanent `Message` documents after delivery or after a retention window.

Existing permanent deletion is user/admin action, such as:

- deleting a chat
- deleting a group's messages when the last owner leaves
- soft-deleting a message

## 7. Blast Radius

Backend direct Mongo message usage is concentrated in two files:

- `server.js`: socket send, delivery/read receipts, reactions, edits, polls, played receipts, temp queue cleanup.
- `routes/chat.js`: history, previews, media, message info, stats, delete routes.

Direct history/list-style reads from `Message` in REST routes:

- `/api/chat/previews`
- `/api/chat/messages/:userId`
- `/api/chat/groups/:groupId/messages`
- `/api/chat/media-all/:userId`
- `/api/chat/groups/:groupId/media`
- `/api/chat/groups/:groupId/all-media`
- `/api/chat/messages/:messageId/info`
- `/api/chat/messages/:messageId/private-info`
- `/api/chat/stats`

Overall: the backend blast radius is moderate and mostly centralized. The bigger migration risk is client behavior: the mobile app still fetches Mongo-backed history from REST endpoints and assumes message info/media/history can be loaded later.
