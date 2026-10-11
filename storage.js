'use strict';

// One game, local to this browser/origin. No network requests or app-setting deletion.
window.PlayLogStore = (() => {
  const DB_NAME = 'sideline-play-logger';
  const STORE = 'plays';
  let connection = null;

  function open() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, {keyPath: 'id', autoIncrement: true});
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error('別のタブを閉じて再試行してください。'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); connection = null; };
        db.onclose = () => { connection = null; };
        resolve(db);
      };
    }).catch(error => { connection = null; throw error; });
    return connection;
  }

  async function run(mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      let request;
      // A successful request can still be followed by an aborted transaction.
      // Only report success after the whole transaction commits.
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error || new Error('保存処理が中断されました。'));
      try {
        request = operation(transaction.objectStore(STORE));
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  }

  return {
    // Auto-incremented IDs preserve insertion order, including identical timestamps.
    load: () => run('readonly', store => store.getAll()),
    add: async record => ({...record, id: await run('readwrite', store => store.add(record))}),
    update: record => run('readwrite', store => store.put(record)),
    clear: () => run('readwrite', store => store.clear())
  };
})();
