'use strict';

// One game, local to this browser/origin. Networking is kept in sharing.js.
window.PlayLogStore = (() => {
  const DB_NAME = 'sideline-play-logger';
  const STORE = 'plays';
  let connection = null;

  function open() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 4);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, {keyPath: 'id', autoIncrement: true});
        if (!db.objectStoreNames.contains('signMappings')) db.createObjectStore('signMappings', {keyPath: 'id'});
        if (!db.objectStoreNames.contains('appState')) db.createObjectStore('appState', {keyPath: 'id'});
        if (!db.objectStoreNames.contains('sharing')) db.createObjectStore('sharing', {keyPath: 'id'});
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

  async function run(mode, operation, storeName = STORE, state) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const changed = mode === 'readwrite' && storeName === STORE;
      const names = [...new Set([storeName, ...(state ? ['appState'] : []), ...(changed ? ['sharing'] : [])])];
      const transaction = db.transaction(names, mode);
      let request;
      // A successful request can still be followed by an aborted transaction.
      // Only report success after the whole transaction commits.
      transaction.oncomplete = () => { resolve(request.result); if (changed) window.dispatchEvent(new Event('playlogchange')); };
      transaction.onabort = () => reject(transaction.error || new Error('保存処理が中断されました。'));
      try {
        request = operation(transaction.objectStore(storeName));
        if (state) transaction.objectStore('appState').put({...state, id: 'current'});
        if (changed) {
          const sharing = transaction.objectStore('sharing'), current = sharing.get('current');
          current.onsuccess = () => {
            const value = current.result || newSharing();
            sharing.put({...value, revision: value.revision + 1});
          };
        }
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  }

  function newSharing() { return {id:'current', writerId:crypto.randomUUID(), revision:0, syncedRevision:0, enabled:false, gameId:null, ownerId:null}; }
  async function changeSharing(change, notify = false) {
    const db = await open();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction('sharing', 'readwrite'), store = tx.objectStore('sharing'), request = store.get('current');
      let value;
      request.onsuccess = () => { value = change(request.result || newSharing()); store.put(value); };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error || new Error('共有状態を保存できません。'));
    });
    if (notify) window.dispatchEvent(new Event('playlogchange'));
    return result;
  }

  return {
    // Auto-incremented IDs preserve insertion order, including identical timestamps.
    load: () => run('readonly', store => store.getAll()),
    add: async (record, state) => ({...record, id: await run('readwrite', store => store.add(record), STORE, state)}),
    update: (record, state) => run('readwrite', store => store.put(record), STORE, state),
    clear: state => run('readwrite', store => store.clear(), STORE, state),
    loadState: () => run('readonly', store => store.get('current'), 'appState'),
    saveState: state => run('readwrite', store => store.put({...state, id: 'current'}), 'appState'),
    loadMapping: () => run('readonly', store => store.get('current'), 'signMappings'),
    saveMapping: mapping => run('readwrite', store => store.put({...mapping, id: 'current'}), 'signMappings'),
    loadSharing: () => changeSharing(value => value),
    configureSharing: settings => changeSharing(value => ({...value, ...settings, id:'current', revision:value.revision+1,
      syncedRevision:value.gameId===settings.gameId && value.writerId===settings.writerId ? value.syncedRevision : 0}), true),
    ackSharing: (gameId, writerId, revision) => changeSharing(value => value.gameId===gameId && value.writerId===writerId
      ? {...value, syncedRevision:Math.max(value.syncedRevision, Math.min(revision,value.revision))} : value),
    // Read records and their revision in the same transaction, including a pending reset.
    loadShareSnapshot: async () => {
      const db = await open();
      return new Promise((resolve,reject) => {
        const tx=db.transaction([STORE,'sharing'],'readonly'), records=tx.objectStore(STORE).getAll(), sharing=tx.objectStore('sharing').get('current');
        tx.oncomplete=()=>resolve({records:records.result, sharing:sharing.result});
        tx.onabort=()=>reject(tx.error || new Error('共有する記録を読み出せません。'));
      });
    }
  };
})();
