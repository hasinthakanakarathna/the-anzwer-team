const fs = require('fs');
const os = require('os');
const path = require('path');
const PDFDocument = require('pdfkit');
const { google } = require('googleapis');

const RETENTION_DAYS = Number(process.env.CHAT_RETENTION_DAYS || 7);
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '';
const DRIVE_SHARE_EMAIL = process.env.GOOGLE_DRIVE_SHARE_EMAIL || 'xapple200100@gmail.com';

function driveConfigured() {
  return Boolean(
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY &&
    DRIVE_FOLDER_ID
  );
}

function getDriveClient() {
  const auth = new google.auth.JWT({
    email: process.env.FIREBASE_CLIENT_EMAIL,
    key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  return google.drive({ version: 'v3', auth });
}

function buildTranscript(chat, messages, participants) {
  const lines = [
    'ANZWER Private Chat Archive',
    `Chat ID: ${chat.id}`,
    `Client: ${participants.client?.full_name || participants.client?.username || chat.client_id}`,
    `Employee: ${participants.employee?.full_name || participants.employee?.username || chat.employee_id}`,
    `Created: ${chat.created_at || ''}`,
    `Last message: ${chat.last_message_at || ''}`,
    `Archived: ${new Date().toISOString()}`,
    ''.padEnd(48, '-'),
    '',
  ];
  for (const message of messages) {
    const author = message.sender_id === chat.client_id
      ? (participants.client?.full_name || 'Client')
      : (participants.employee?.full_name || 'Employee');
    lines.push(`[${message.created_at}] ${author}:`);
    lines.push(message.body);
    lines.push('');
  }
  return lines.join('\n');
}

function writeTxt(filePath, text) {
  fs.writeFileSync(filePath, text, 'utf8');
}

function writePdf(filePath, text) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    doc.font('Courier').fontSize(9).text(text, { width: 500 });
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function uploadAndShare(drive, filePath, mimeType, name) {
  const created = await drive.files.create({
    requestBody: {
      name,
      parents: DRIVE_FOLDER_ID ? [DRIVE_FOLDER_ID] : undefined,
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath),
    },
    fields: 'id,name,webViewLink',
    supportsAllDrives: true,
  });

  if (DRIVE_SHARE_EMAIL) {
    try {
      await drive.permissions.create({
        fileId: created.data.id,
        requestBody: {
          type: 'user',
          role: 'writer',
          emailAddress: DRIVE_SHARE_EMAIL,
        },
        sendNotificationEmail: false,
        supportsAllDrives: true,
      });
    } catch (error) {
      // Folder ACL may already grant access; keep archive even if share fails.
      console.warn('Drive share warning:', error.message);
    }
  }

  return created.data;
}

async function archiveChatToDrive(chat, messages, participants) {
  if (!driveConfigured()) {
    throw new Error('Google Drive is not configured (need GOOGLE_DRIVE_FOLDER_ID + Firebase service account)');
  }

  const drive = getDriveClient();
  const transcript = buildTranscript(chat, messages, participants);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `anzwer-chat-${chat.id}-${stamp}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anzwer-chat-'));
  const txtPath = path.join(tmp, `${base}.txt`);
  const pdfPath = path.join(tmp, `${base}.pdf`);

  try {
    writeTxt(txtPath, transcript);
    await writePdf(pdfPath, transcript);
    const txtFile = await uploadAndShare(drive, txtPath, 'text/plain', `${base}.txt`);
    const pdfFile = await uploadAndShare(drive, pdfPath, 'application/pdf', `${base}.pdf`);
    return {
      txt: { id: txtFile.id, name: txtFile.name, link: txtFile.webViewLink || null },
      pdf: { id: pdfFile.id, name: pdfFile.name, link: pdfFile.webViewLink || null },
      archived_at: new Date().toISOString(),
      share_email: DRIVE_SHARE_EMAIL,
    };
  } finally {
    for (const file of [txtPath, pdfPath]) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
    try { fs.rmdirSync(tmp); } catch { /* ignore */ }
  }
}

async function deleteCollection(firestore, collectionRef, batchSize = 200) {
  while (true) {
    const snap = await collectionRef.limit(batchSize).get();
    if (snap.empty) break;
    const batch = firestore.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (snap.size < batchSize) break;
  }
}

/**
 * Archive chats idle for RETENTION_DAYS, upload to Drive, then wipe messages + chat.
 * Never deletes unless Drive archive succeeds.
 */
async function runChatRetention(firestore) {
  if (!driveConfigured()) {
    console.warn('Chat retention skipped: Google Drive folder not configured.');
    return { skipped: true, archived: 0 };
  }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const snap = await firestore.collection('chats').where('last_message_at', '<', cutoff).get();
  let archived = 0;
  const errors = [];

  for (const doc of snap.docs) {
    const chat = { id: doc.id, ...doc.data() };
    if (chat.archived_at) continue;
    try {
      const messagesSnap = await doc.ref.collection('messages').orderBy('created_at').get();
      const messages = messagesSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
      const [client, employee] = await Promise.all([
        firestore.collection('users').doc(String(chat.client_id)).get(),
        firestore.collection('users').doc(String(chat.employee_id)).get(),
      ]);
      const participants = {
        client: client.exists ? { id: client.id, ...client.data() } : null,
        employee: employee.exists ? { id: employee.id, ...employee.data() } : null,
      };

      const archive = await archiveChatToDrive(chat, messages, participants);
      await firestore.collection('chat_archives').doc(chat.id).set({
        chat_id: chat.id,
        client_id: chat.client_id,
        employee_id: chat.employee_id,
        message_count: messages.length,
        last_message_at: chat.last_message_at || null,
        drive: archive,
        created_at: new Date().toISOString(),
      });

      await deleteCollection(firestore, doc.ref.collection('messages'));
      await doc.ref.delete();
      archived += 1;
      console.log(`Archived and wiped chat ${chat.id} (${messages.length} messages)`);
    } catch (error) {
      errors.push({ chatId: chat.id, error: error.message });
      console.error(`Chat archive failed for ${chat.id}:`, error.message);
    }
  }

  return { skipped: false, archived, checked: snap.size, errors, cutoff };
}

module.exports = {
  RETENTION_DAYS,
  DRIVE_SHARE_EMAIL,
  driveConfigured,
  runChatRetention,
  archiveChatToDrive,
};
