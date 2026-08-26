class FirestoreSessionStore {
  constructor(sessionModule, options = {}) {
    if (!sessionModule?.Store) throw new TypeError('FirestoreSessionStore requires express-session');
    if (!options.firestore) throw new TypeError('FirestoreSessionStore requires a Firestore client');

    const BaseStore = sessionModule.Store;
    class StoreImpl extends BaseStore {
      constructor(opts) {
        super(opts);
        this.collection = opts.firestore.collection(opts.collection || 'sessions');
      }

      _revive(data) {
        if (!data) return null;
        const sessionData = { ...data };
        delete sessionData.updatedAt;
        if (sessionData.cookie?.expires) {
          const expires = sessionData.cookie.expires;
          sessionData.cookie.expires = typeof expires.toDate === 'function'
            ? expires.toDate()
            : new Date(expires);
        }
        return sessionData;
      }

      get(sid, callback) {
        this.collection.doc(sid).get()
          .then((snapshot) => {
            if (!snapshot.exists) return callback(null, null);
            const sessionData = this._revive(snapshot.data());
            if (sessionData?.cookie?.expires && sessionData.cookie.expires <= new Date()) {
              return this.destroy(sid, () => callback(null, null));
            }
            callback(null, sessionData);
          })
          .catch(callback);
      }

      set(sid, sessionData, callback) {
        this.collection.doc(sid).set({ ...sessionData, updatedAt: new Date() })
          .then(() => callback && callback())
          .catch((error) => callback && callback(error));
      }

      destroy(sid, callback) {
        this.collection.doc(sid).delete()
          .then(() => callback && callback())
          .catch((error) => callback && callback(error));
      }

      touch(sid, sessionData, callback) {
        const update = { updatedAt: new Date() };
        if (sessionData?.cookie) update.cookie = sessionData.cookie;
        this.collection.doc(sid).set(update, { merge: true })
          .then(() => callback && callback())
          .catch((error) => callback && callback(error));
      }
    }

    return new StoreImpl(options);
  }
}

module.exports = FirestoreSessionStore;
