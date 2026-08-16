import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Force the in-memory fallback DB and a throwaway data dir so tests never touch
// a real Postgres instance or the developer's durable memory-db.json file.
process.env.DATABASE_URL = 'postgres://nouser:nopass@127.0.0.1:59999/nodb';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseroom-db-test-'));
process.chdir(tmpDir);

const { db, initDb } = await import('../src/db.js');

let userA, userB, roomId;

before(async () => {
  await initDb();
  userA = await db.createUser({ username: `alice_${Date.now()}`, email: `alice_${Date.now()}@test.dev`, passwordHash: 'x' });
  userB = await db.createUser({ username: `bob_${Date.now()}`, email: `bob_${Date.now()}@test.dev`, passwordHash: 'x' });
  const room = await db.getOrCreatePrivateRoom(userA.id, userB.id);
  roomId = room.id;
});

test('editMessage: only the sender can edit, increments edit_count and stamps edited_at', async () => {
  const msg = await db.createMessage({ roomId, senderId: userA.id, text: 'hello world', type: 'text' });

  const denied = await db.editMessage(msg.id, userB.id, 'hacked', 'text');
  assert.equal(denied, null, 'non-sender must be rejected');

  const edited = await db.editMessage(msg.id, userA.id, 'hello edited', 'text');
  assert.ok(edited, 'sender edit should succeed');
  assert.equal(edited.text, 'hello edited');
  assert.equal(edited.edit_count, 1);
  assert.ok(edited.edited_at, 'edited_at should be set');

  const editedTwice = await db.editMessage(msg.id, userA.id, 'hello edited again', 'text');
  assert.equal(editedTwice.edit_count, 2);
});

test('getRoomMessages reflects the edited text', async () => {
  const msg = await db.createMessage({ roomId, senderId: userB.id, text: 'original', type: 'text' });
  await db.editMessage(msg.id, userB.id, 'revised', 'text');
  const msgs = await db.getRoomMessages(roomId, userA.id);
  const found = msgs.find(m => m.id === msg.id);
  assert.ok(found);
  assert.equal(found.text, 'revised');
  assert.equal(found.edit_count, 1);
});

test('deleteMessageForEveryone: sender-only tombstone with wiped content', async () => {
  const msg = await db.createMessage({ roomId, senderId: userA.id, text: 'secret', type: 'text' });

  const denied = await db.deleteMessageForEveryone(msg.id, userB.id);
  assert.equal(denied, null);

  const deleted = await db.deleteMessageForEveryone(msg.id, userA.id);
  assert.ok(deleted);
  assert.equal(deleted.room_id, roomId);

  const row = await db.getMessageById(msg.id);
  assert.equal(row.type, 'deleted');
  assert.equal(row.text, '');
  assert.equal(row.media_url, '');
  assert.equal(row.deleted_for_everyone, true);
});

test('searchRoomMessages matches plaintext and excludes deleted-for-everyone', async () => {
  const matchMsg = await db.createMessage({ roomId, senderId: userB.id, text: 'the pink rabbit jumped', type: 'text' });
  await db.createMessage({ roomId, senderId: userB.id, text: 'unrelated note', type: 'text' });

  const results = await db.searchRoomMessages(roomId, userA.id, 'rabbit');
  assert.ok(results.some(m => m.id === matchMsg.id), 'matching message should be found');
  assert.ok(!results.some(m => m.text === 'unrelated note'), 'non-matching message should not appear');

  const doomed = await db.createMessage({ roomId, senderId: userA.id, text: 'deleted content searchable', type: 'text' });
  await db.deleteMessageForEveryone(doomed.id, userA.id);
  const afterDelete = await db.searchRoomMessages(roomId, userB.id, 'deleted content');
  assert.ok(!afterDelete.some(m => m.id === doomed.id), 'deleted-for-everyone must be excluded from search');
});

test('forwardMessage sets forwarded flag and forwards content', async () => {
  const original = await db.createMessage({ roomId, senderId: userA.id, text: 'forward me', type: 'text' });
  const forwarded = await db.forwardMessage({
    roomId,
    senderId: userA.id,
    text: 'forward me',
    type: 'text',
    mediaUrl: '',
    originalMessageId: original.id,
    e2ee: false
  });
  assert.equal(forwarded.forwarded, true);
  assert.equal(forwarded.forwarded_from, original.id);
  assert.equal(forwarded.text, 'forward me');
});

test('toggleArchiveRoom persists per-user and surfaces is_archived on getUserRooms', async () => {
  assert.equal(await db.isRoomArchived(userA.id, roomId), false);

  const archived = await db.toggleArchiveRoom(userA.id, roomId);
  assert.equal(archived, true);
  assert.equal(await db.isRoomArchived(userA.id, roomId), true);

  const roomsA = await db.getUserRooms(userA.id);
  const roomA = roomsA.find(r => r.id === roomId);
  assert.equal(roomA.is_archived, true, 'archived flag must appear on the user room payload');

  // Archiving is per-user: the other participant must not see it archived.
  const roomsB = await db.getUserRooms(userB.id);
  const roomB = roomsB.find(r => r.id === roomId);
  assert.equal(roomB.is_archived, false);

  const unarchived = await db.toggleArchiveRoom(userA.id, roomId);
  assert.equal(unarchived, false);
  assert.equal(await db.isRoomArchived(userA.id, roomId), false);
});

test('toggleUnreadRoom marks per-user and surfaces is_unread on getUserRooms', async () => {
  const marked = await db.toggleUnreadRoom(userA.id, roomId);
  assert.equal(marked, true);

  const roomsA = await db.getUserRooms(userA.id);
  const roomA = roomsA.find(r => r.id === roomId);
  assert.equal(roomA.is_unread, true, 'unread flag must appear on the user room payload');

  const roomsB = await db.getUserRooms(userB.id);
  const roomB = roomsB.find(r => r.id === roomId);
  assert.equal(roomB.is_unread, false, 'mark-as-unread is per-user');

  const cleared = await db.toggleUnreadRoom(userA.id, roomId);
  assert.equal(cleared, false);
});

test('reportMessage: creates a pending report with message context', async () => {
  const msg = await db.createMessage({ roomId, senderId: userB.id, text: 'inappropriate content', type: 'text' });
  const report = await db.reportMessage({ messageId: msg.id, reporterId: userA.id, roomId, reason: 'spam' });

  assert.ok(report.id);

  const pending = await db.getReports({ status: 'pending' });
  const found = pending.find(r => r.id === report.id);
  assert.ok(found, 'new report must appear in the pending inbox');
  assert.equal(found.message_text, 'inappropriate content');
  assert.equal(found.sender_username, userB.username, 'sender identity must be joined in');
  assert.equal(found.reporter_username, userA.username, 'reporter identity must be joined in');
  assert.equal(found.reason, 'spam');
  assert.equal(found.status, 'pending');
});

test('updateReportStatus: resolves and dismisses a report', async () => {
  const msg = await db.createMessage({ roomId, senderId: userA.id, text: 'needs review', type: 'text' });
  const report = await db.reportMessage({ messageId: msg.id, reporterId: userB.id, roomId, reason: 'abuse' });

  const resolved = await db.updateReportStatus(report.id, userA.id, 'resolved');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolved_by, userA.id);
  assert.ok(resolved.resolved_at);

  const resolvedList = await db.getReports({ status: 'resolved' });
  assert.ok(resolvedList.some(r => r.id === report.id), 'resolved report must move to the resolved inbox');
  const pendingList = await db.getReports({ status: 'pending' });
  assert.ok(!pendingList.some(r => r.id === report.id), 'resolved report must leave the pending inbox');

  const dismissed = await db.updateReportStatus(report.id, userA.id, 'dismissed');
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(await db.updateReportStatus(report.id, userA.id, 'bogus'), null, 'invalid status must be rejected');
  assert.equal(await db.updateReportStatus('does-not-exist', userA.id, 'resolved'), null, 'missing report must return null');
});

