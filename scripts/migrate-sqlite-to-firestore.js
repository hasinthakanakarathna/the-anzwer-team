require('dotenv').config();
const Database = require('better-sqlite3');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const path = require('path');
const crypto = require('crypto');

if (!process.argv.includes('--confirm')) {
  console.error('Refusing to migrate without --confirm.');
  console.error('Usage: node scripts/migrate-sqlite-to-firestore.js --confirm');
  process.exit(1);
}

const required = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(`Missing Firebase configuration: ${missing.join(', ')}`);
}

const app = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });

const firestore = getFirestore(app);
firestore.settings({ ignoreUndefinedProperties: true });

const db = new Database(path.join(__dirname, '..', 'data', 'data.sqlite'), { readonly: true });

const nested = {
  ticket_comments: 'comments',
  ticket_status_history: 'history',
  ticket_work_logs: 'workLogs',
};
const excluded = new Set(['sessions', 'sqlite_sequence']);
const counterNames = {
  users: 'users',
  reports: 'reports',
  tickets: 'tickets',
  audit_logs: 'audit_logs',
  team_invitations: 'team_invitations',
  ticket_comments: 'ticket_comments',
  ticket_status_history: 'ticket_status_history',
  ticket_work_logs: 'ticket_work_logs',
};

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((item) => item.name)
  .filter((name) => !excluded.has(name));

function idFor(table, item) {
  if (item.id != null) return String(item.id);
  if (table === 'ticket_sequences') return `${item.year}_${item.type}`;
  if (table === 'identity_sequences') return `${item.birth_year}_${item.account_type}`;
  return crypto.createHash('sha1').update(JSON.stringify(item)).digest('hex');
}

function sanitize(value) {
  if (value === undefined) return null;
  return value;
}

function rowPayload(item) {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, sanitize(value)]));
}

async function writeBatch(entries) {
  for (let offset = 0; offset < entries.length; offset += 400) {
    const batch = firestore.batch();
    entries.slice(offset, offset + 400).forEach(([ref, value]) => batch.set(ref, value, { merge: true }));
    await batch.commit();
  }
}

async function migrateTable(table) {
  const entries = db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}" ORDER BY rowid`).all();
  if (nested[table]) return migrateNested(table, entries);

  const target = firestore.collection(table);
  await writeBatch(entries.map((item) => {
    const payload = rowPayload(item);
    if (Object.prototype.hasOwnProperty.call(payload, 'id')) delete payload.id;
    return [target.doc(idFor(table, item)), payload];
  }));
  console.log(`Migrated ${table}: ${entries.length}`);

  if (counterNames[table]) {
    const maxId = entries.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
    await firestore.collection('counters').doc(counterNames[table]).set({ next: maxId + 1 }, { merge: true });
    console.log(`Counter ${counterNames[table]} -> ${maxId + 1}`);
  }
}

async function migrateNested(table, entries) {
  const childName = nested[table];
  const grouped = new Map();
  for (const item of entries) {
    const ticketId = String(item.ticket_id);
    if (!grouped.has(ticketId)) grouped.set(ticketId, []);
    grouped.get(ticketId).push(item);
  }

  for (const [ticketId, items] of grouped) {
    const target = firestore.collection('tickets').doc(ticketId).collection(childName);
    await writeBatch(items.map((item) => {
      const payload = rowPayload(item);
      delete payload.id;
      delete payload.ticket_id;
      return [target.doc(String(item.id)), payload];
    }));
  }
  console.log(`Migrated ${table}: ${entries.length}`);

  if (counterNames[table]) {
    const maxId = entries.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
    await firestore.collection('counters').doc(counterNames[table]).set({ next: maxId + 1 }, { merge: true });
    console.log(`Counter ${counterNames[table]} -> ${maxId + 1}`);
  }
}

async function main() {
  for (const table of tables) {
    await migrateTable(table);
  }

  // Normalize foreign keys / ids to strings for the Firestore runtime.
  const users = db.prepare('SELECT id FROM users').all();
  for (const user of users) {
    await firestore.collection('users').doc(String(user.id)).set({
      // no-op merge; ids already string doc keys
    }, { merge: true });
  }

  const tickets = db.prepare('SELECT id, requester_id, assignee_id, created_by, updated_by FROM tickets').all();
  for (const ticket of tickets) {
    await firestore.collection('tickets').doc(String(ticket.id)).set({
      requester_id: ticket.requester_id != null ? String(ticket.requester_id) : null,
      assignee_id: ticket.assignee_id != null ? String(ticket.assignee_id) : null,
      created_by: ticket.created_by != null ? String(ticket.created_by) : null,
      updated_by: ticket.updated_by != null ? String(ticket.updated_by) : null,
    }, { merge: true });
  }

  const reports = db.prepare('SELECT id, user_id FROM reports').all();
  for (const report of reports) {
    await firestore.collection('reports').doc(String(report.id)).set({
      user_id: report.user_id != null ? String(report.user_id) : null,
    }, { merge: true });
  }

  const audits = db.prepare('SELECT id, actor_id FROM audit_logs').all();
  for (const audit of audits) {
    await firestore.collection('audit_logs').doc(String(audit.id)).set({
      actor_id: audit.actor_id != null ? String(audit.actor_id) : null,
    }, { merge: true });
  }

  db.close();
  console.log('Migration complete. Session files were intentionally omitted — users will sign in again.');
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
