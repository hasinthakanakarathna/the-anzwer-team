require('dotenv').config();
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const required = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`FATAL: Missing Firebase configuration: ${missing.join(', ')}`);
  process.exit(1);
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

async function nextCounter(name) {
  const ref = firestore.collection('counters').doc(name);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? Number(snap.data().next || 1) : 1;
    tx.set(ref, { next: current + 1 }, { merge: true });
    return String(current);
  });
}

function withId(doc) {
  if (!doc || !doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function getDoc(collection, id) {
  if (id == null || id === '') return null;
  return withId(await firestore.collection(collection).doc(String(id)).get());
}

async function queryOne(collection, field, value) {
  const snap = await firestore.collection(collection).where(field, '==', value).limit(1).get();
  if (snap.empty) return null;
  return withId(snap.docs[0]);
}

async function listCollection(collection, orderBy, direction = 'desc', limit = 200) {
  let query = firestore.collection(collection);
  if (orderBy) query = query.orderBy(orderBy, direction);
  if (limit) query = query.limit(limit);
  const snap = await query.get();
  return snap.docs.map((doc) => withId(doc));
}

module.exports = {
  app,
  firestore,
  FieldValue,
  Timestamp,
  nextCounter,
  withId,
  getDoc,
  queryOne,
  listCollection,
};
