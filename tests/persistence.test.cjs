'use strict';
const {test: nodeTest, before, after} = require('node:test');
const test=(name,fn)=>nodeTest(name,{timeout:30000},fn);
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const playwright = require('playwright');
const {csv: signCSV, records: fixtureRecords} = require('./fixtures.cjs');

const engine = process.env.BROWSER_ENGINE || 'chromium';
const browserType = playwright[engine];
const launchOptions = {headless: true};
if (process.env.BROWSER_CHANNEL) launchOptions.channel = process.env.BROWSER_CHANNEL;
const root = path.resolve(__dirname, '..');
let server, browser, origin;

before(async () => {
  server = http.createServer(async (req, res) => {
    if(req.url==='/blank'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Test setup</title>');return;}
    const requested = req.url.split('?')[0].slice(1);
    const filename = ['storage.js','sign-lookup.js'].includes(requested) ? requested : 'index.html';
    try {
      res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(await fs.readFile(path.join(root, filename)));
    } catch { res.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await browserType.launch(launchOptions);
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function ready(page) {
  await page.waitForFunction(() => !document.getElementById('enter').disabled);
}
async function fixture(t, {withMapping=true}={}) {
  const context = await browser.newContext({viewport: {width: 1180, height: 820}, hasTouch: true});
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [], unexpectedRequests=[];
  page.on('request',r=>{if(r.method()!=='GET'||!r.url().startsWith(origin+'/'))unexpectedRequests.push(r.method()+' '+r.url());});
  t.after(()=>assert.deepEqual(unexpectedRequests,[],'No CSV or logs sent to a server'));
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'No uncaught browser errors'));
  await page.goto(origin);
  await ready(page);
  if(withMapping)await importCSV(page);
  return {page, context};
}
async function importCSV(page,text=signCSV()){await page.locator('#signCsvInput').setInputFiles({name:'fictional-signs.csv',mimeType:'text/csv',buffer:Buffer.from(text)});await ready(page);}
async function rows(page) { return page.evaluate(() => PlayLogStore.load()); }
async function save(page) { await page.locator('#enter').click(); await ready(page); }
async function fillPlay(page) {
  await page.locator('[data-key="1"]').click();
  await page.locator('#tab').click();
  await page.locator('[data-key="1"]').click();
  await page.locator('[data-key="0"]').click();
  await page.locator('[data-key="R"]').click();
  await page.locator('[data-field="sign"]').click();
  for (const digit of '12345') await page.locator(`[data-key="${digit}"]`).click();
  await page.locator('#remark').fill('日本語, "確認"\n次の行');
}
async function abortNext(page, method) {
  await page.evaluate(method => {
    const original = IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method] = function (...args) {
      IDBObjectStore.prototype[method] = original;
      const request = original.apply(this, args);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    };
  }, method);
}
async function confirmReset(page, decisions) {
  const messages = [];
  const handler = async dialog => {
    messages.push(dialog.message());
    if (decisions[messages.length - 1]) await dialog.accept(); else await dialog.dismiss();
  };
  page.on('dialog', handler);
  await page.locator('#resetBtn').click();
  await ready(page);
  page.off('dialog', handler);
  return messages;
}

test('empty database starts empty; normal save persists every field and clears the form', async t => {
  const {page} = await fixture(t);
  assert.deepEqual(await rows(page), []);
  assert.equal(await page.locator('#count').textContent(), '0 plays');
  await fillPlay(page);
  await save(page);
  const [record] = await rows(page);
  assert.equal(typeof record.id, 'number');
  assert.match(record.time, /^\d{2}:\d{2}:\d{2}$/);
  assert.ok(Number.isFinite(Date.parse(record.recordedAt)));
  assert.deepEqual({down:record.down,distance:record.distance,strSide:record.strSide,sign:record.sign,formation:record.formation,play:record.play,remark:record.remark},
    {down:'1',distance:'10',strSide:'R',sign:'12345',formation:'TRIPS RIGHT',play:'INSIDE ZONE',remark:'日本語, "確認"\n次の行'});
  assert.equal(await page.locator('#remark').inputValue(), '');
  for (const field of ['down','distance','strSide','sign']) assert.equal(await page.locator(`#value-${field}`).textContent(), '—');
  await page.reload(); await ready(page);
  assert.deepEqual(await rows(page), [record]);
  assert.equal(await page.locator('#logBody tr[tabindex]').count(), 1);
  assert.match(await page.locator('#logBody').textContent(), /TRIPS RIGHT/);
});

test('blank and consecutive records keep unique IDs, order and original times after reload', async t => {
  const {page} = await fixture(t);
  for (let i=0; i<8; i++) await save(page);
  const beforeReload = await rows(page);
  assert.equal(beforeReload.length, 8);
  assert.equal(new Set(beforeReload.map(r => r.id)).size, 8);
  assert.deepEqual(beforeReload.map(r => r.id), beforeReload.map(r => r.id).sort((a,b)=>a-b));
  for (const r of beforeReload) for (const field of ['down','distance','strSide','sign','formation','play','remark']) assert.equal(r[field], '');
  await page.reload(); await ready(page);
  assert.deepEqual(await rows(page), beforeReload);
  assert.equal(await page.locator('#logBody tr[tabindex]').count(), 8);
});

test('editing a blank row and changing Sign updates in place; timestamps and order stay fixed', async t => {
  const {page} = await fixture(t);
  await save(page); await save(page);
  const original = await rows(page);
  await page.locator('#logBody tr[tabindex]').first().click();
  await fillPlay(page); await save(page);
  let updated = await rows(page);
  assert.equal(updated.length, 2);
  assert.equal(updated[0].id, original[0].id);
  assert.equal(updated[0].time, original[0].time);
  assert.equal(updated[0].recordedAt, original[0].recordedAt);
  assert.equal(updated[0].sign, '12345');
  assert.deepEqual(updated[1], original[1]);
  await page.locator('#logBody tr[tabindex]').first().click();
  await page.locator('[data-field="sign"]').click();
  for (let i=0;i<5;i++) await page.locator('#backspace').click();
  for (const digit of '23456') await page.locator(`[data-key="${digit}"]`).click();
  await save(page); updated = await rows(page);
  assert.equal(updated[0].formation, 'DOUBLES LEFT');
  assert.equal(updated[0].play, 'MESH');
  assert.equal(updated[0].time, original[0].time);
  await page.reload(); await ready(page);
  assert.deepEqual(await rows(page), updated);
});

test('stored Formation/Play survive lookup changes and a Remark-only edit', async t => {
  const {page} = await fixture(t);
  await fillPlay(page); await save(page);
  const original = await rows(page);
  await importCSV(page,signCSV().replace('TRIPS RIGHT','CHANGED').replace('INSIDE ZONE','CHANGED'));
  await page.locator('#logBody tr[tabindex]').click();
  await page.locator('#remark').fill('追記'); await save(page);
  const [record] = await rows(page);
  assert.equal(record.formation, original[0].formation);
  assert.equal(record.play, original[0].play);
  assert.equal(record.remark, '追記');
});

test('CSV download includes blank rows, hidden Sign, latest edits, Japanese BOM and escaping; export never deletes', async t => {
  const {page} = await fixture(t);
  await fillPlay(page); await save(page); await save(page);
  await page.locator('#logBody tr[tabindex]').first().click();
  await page.locator('#remark').fill('更新,日本語 "注記"\n二行目'); await save(page);
  const records = await rows(page);
  await page.locator('#toggleTable').click();
  await page.locator('#search').fill('存在しない検索');
  const downloading = page.waitForEvent('download');
  await page.locator('#exportBtn').click();
  const download = await downloading;
  assert.match(download.suggestedFilename(), /^sideline_log_\d{4}-\d{2}-\d{2}\.csv$/);
  const bytes = await fs.readFile(await download.path());
  assert.deepEqual([...bytes.subarray(0,3)], [0xef,0xbb,0xbf]);
  assert.equal(bytes.toString('utf8'), '\uFEFFTime,Down,Distance,Str Side,Sign,Formation,Play,Remark,Lookup Status,Resolved Sign,Parent Sign,CWM Branch\r\n'+
    `${records[0].time},1,10,R,12345,TRIPS RIGHT,INSIDE ZONE,"更新,日本語 ""注記""\n二行目",matched,12345,,\r\n${records[1].time},,,,,,,,empty,,,`);
  assert.deepEqual(await rows(page), records);
});

test('reset cancellation at either confirmation changes nothing, including the edit draft', async t => {
  const {page} = await fixture(t);
  await save(page);
  const original = await rows(page);
  await page.locator('#logBody tr[tabindex]').click();
  await page.locator('#remark').fill('編集中');
  let messages = await confirmReset(page, [false]);
  assert.equal(messages.length, 1); assert.match(messages[0], /CSV.*保存.*確認/);
  messages = await confirmReset(page, [true,false]);
  assert.equal(messages.length, 2); assert.match(messages[1], /すべての記録を削除/);
  assert.deepEqual(await rows(page), original);
  assert.equal(await page.locator('#remark').inputValue(), '編集中');
  await page.reload(); await ready(page); assert.deepEqual(await rows(page), original);
});

test('confirmed reset survives reload, preserves other settings/stores and allows new recording', async t => {
  const {page} = await fixture(t);
  await save(page); await save(page);
  await page.evaluate(async () => {
    localStorage.setItem('unrelated-setting', 'keep');
    await new Promise((resolve,reject) => {
      const request=indexedDB.open('unrelated-app',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('settings');
      request.onsuccess=()=>{const db=request.result,tx=db.transaction('settings','readwrite');tx.objectStore('settings').put('keep','key');tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};
    });
  });
  assert.equal((await confirmReset(page,[true,true])).length,2);
  assert.deepEqual(await rows(page), []);
  await page.reload(); await ready(page); assert.deepEqual(await rows(page), []);
  assert.equal(await page.evaluate(() => localStorage.getItem('unrelated-setting')), 'keep');
  assert.equal(await page.evaluate(() => new Promise(resolve=>{const req=indexedDB.open('unrelated-app');req.onsuccess=()=>{const db=req.result,tx=db.transaction('settings');const get=tx.objectStore('settings').get('key');get.onsuccess=()=>resolve(get.result);tx.oncomplete=()=>db.close();};})), 'keep');
  await save(page); assert.equal((await rows(page)).length,1);
});

test('delayed restore blocks Enter, editing, reset and export until original records are loaded', async t => {
  const {page} = await fixture(t);
  await save(page); const original = await rows(page);
  const storageSource=await fs.readFile(path.join(root,'storage.js'),'utf8');
  await page.route('**/storage.js', route => route.fulfill({contentType:'text/javascript',body:storageSource+`
    const actualLoad=PlayLogStore.load;
    PlayLogStore.load=()=>{PlayLogStore.load=actualLoad;return new Promise(resolve=>{window.releaseRestore=()=>resolve(actualLoad());});};
  `}));
  await page.reload();
  assert.equal(await page.locator('#enter').isDisabled(),true);
  assert.equal(await page.locator('#remark').isDisabled(),true);
  assert.equal(await page.locator('#exportBtn').isDisabled(),true);
  assert.equal(await page.locator('#resetBtn').isDisabled(),true);
  await page.keyboard.press('Enter');
  await page.evaluate(()=>{saveRecord();editRecord(1);resetRecords();releaseRestore();});
  await ready(page); assert.deepEqual(await rows(page), original);
  await save(page); assert.equal((await rows(page)).length,2);
});

test('failed restore does not allow overwrites; retry restores existing data', async t => {
  const {page} = await fixture(t);
  await save(page); const original=await rows(page);
  await page.addInitScript(() => {
    const actual=IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll=function(...args){IDBObjectStore.prototype.getAll=actual;throw new DOMException('Injected read failure','UnknownError');};
  });
  await page.reload();
  await page.locator('#retryStorage').waitFor({state:'visible'});
  assert.equal(await page.locator('#enter').isDisabled(),true);
  assert.equal(await page.locator('#resetBtn').isDisabled(),true);
  await page.keyboard.press('Enter');
  await page.locator('#retryStorage').click(); await ready(page);
  assert.deepEqual(await rows(page),original);
});

test('aborted new save retains all input, displays persistent failure and can be retried once', async t => {
  const {page} = await fixture(t);
  await fillPlay(page); await abortNext(page,'add'); await save(page);
  assert.deepEqual(await rows(page),[]);
  assert.equal(await page.locator('#remark').inputValue(),'日本語, "確認"\n次の行');
  assert.equal(await page.locator('#value-sign').textContent(),'12345');
  assert.match(await page.locator('#storageMessage').textContent(),/未保存/);
  await page.waitForTimeout(2000); assert.equal(await page.locator('#storageNotice').isVisible(),true);
  await save(page); assert.equal((await rows(page)).length,1);
  assert.equal(await page.locator('#storageNotice').isVisible(),false);
});

test('aborted edit retains original stored row, its time, and the unsaved edit for retry', async t => {
  const {page} = await fixture(t);
  await save(page); const [original]=await rows(page);
  await page.locator('#logBody tr[tabindex]').click();
  await page.locator('#remark').fill('未保存の編集');
  await abortNext(page,'put'); await save(page);
  assert.deepEqual(await rows(page),[original]);
  assert.equal(await page.locator('#remark').inputValue(),'未保存の編集');
  assert.match(await page.locator('#entryState').textContent(),/^EDIT/);
  await save(page); const [updated]=await rows(page);
  assert.equal(updated.id,original.id); assert.equal(updated.time,original.time); assert.equal(updated.remark,'未保存の編集');
  await page.reload(); await ready(page); assert.deepEqual(await rows(page),[updated]);
});

test('aborted reset retains all records and existing draft; reload restores unchanged data', async t => {
  const {page} = await fixture(t);
  await save(page); const original=await rows(page);
  await page.locator('#remark').fill('次の入力'); await abortNext(page,'clear');
  await confirmReset(page,[true,true]);
  assert.deepEqual(await rows(page),original);
  assert.equal(await page.locator('#remark').inputValue(),'次の入力');
  assert.match(await page.locator('#storageMessage').textContent(),/リセットできません/);
  await page.reload(); await ready(page); assert.deepEqual(await rows(page),original);
});

test('physical keyboard Enter after keypad focus saves; Tab, deletion, expansion, search and scrolling still work', async t => {
  const {page} = await fixture(t);
  await page.locator('[data-key="2"]').click();
  await page.keyboard.press('Enter'); await ready(page);
  assert.equal((await rows(page))[0].down,'2');
  await page.locator('#tab').click();
  await page.locator('[data-key="7"]').click(); await page.locator('#backspace').click();
  assert.equal(await page.locator('#value-distance').textContent(),'—');
  for(let i=0;i<6;i++) await save(page);
  assert.ok(await page.locator('#tableWrap').evaluate(el=>el.scrollHeight>el.clientHeight));
  await page.locator('#toggleTable').click();
  assert.equal(await page.locator('.entry-stage').isVisible(),false);
  await page.locator('#search').fill('2');
  await page.locator('#logBody tr[tabindex]').first().click();
  assert.equal(await page.locator('.entry-stage').isVisible(),true);
  await page.locator('#cancelEdit').click(); assert.equal(await page.locator('#entryState').textContent(),'NEW PLAY');
});

test('records survive closing and reopening the browser with the same isolated profile', async () => {
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'sideline-persistence-'));
  let context;
  try {
    context=await browserType.launchPersistentContext(profile,{...launchOptions,viewport:{width:1180,height:820}});
    let page=await context.newPage(); await page.goto(origin); await ready(page);
    await importCSV(page); await fillPlay(page); await save(page); const original=await rows(page);const savedMapping=await mappingRows(page);
    await context.close(); context=null;
    context=await browserType.launchPersistentContext(profile,{...launchOptions,viewport:{width:1180,height:820}});
    page=await context.newPage(); await page.goto(origin); await ready(page);
    assert.deepEqual(await rows(page),original);assert.deepEqual(await mappingRows(page),savedMapping);
    assert.equal(await page.locator('#logBody tr[tabindex]').count(),1);
  } finally {if(context)await context.close();await fs.rm(profile,{recursive:true,force:true});}
});

async function typeSign(page,sign){await page.locator('[data-field="sign"]').click();for(const key of sign)await page.locator(`[data-key="${key}"]`).click();}
async function mappingRows(page){return page.evaluate(()=>PlayLogStore.loadMapping());}

test('unloaded CSV never exposes fictional matches; unknown and unloaded signs remain recordable',async t=>{
  const {page}=await fixture(t,{withMapping:false});
  await typeSign(page,'12345');
  assert.match(await page.locator('#lookupResult').textContent(),/未読込/);
  assert.doesNotMatch(await page.locator('#lookupResult').textContent(),/TRIPS RIGHT|INSIDE ZONE/);
  await save(page);let record=(await rows(page))[0];
  assert.equal(record.lookupStatus,'not_loaded');assert.equal(record.formation,'');assert.equal(record.play,'');
  await importCSV(page);await typeSign(page,'99999');await save(page);
  record=(await rows(page))[1];assert.equal(record.lookupStatus,'unmatched');assert.equal(record.resolvedSign,'');
  await page.reload();await ready(page);assert.equal((await rows(page)).length,2);
});

test('native file chooser imports a mapping; cancellation leaves mapping and draft untouched',async t=>{
  const {page}=await fixture(t,{withMapping:false});
  await page.locator('#remark').fill('入力を保持');
  const choose=page.waitForEvent('filechooser');await page.locator('#importBtn').click();
  const chooser=await choose;
  await chooser.setFiles([]);assert.equal(await mappingRows(page),undefined);
  assert.equal(await page.locator('#remark').inputValue(),'入力を保持');
  await importCSV(page);assert.equal((await mappingRows(page)).rows.length,7);
  assert.match(await page.locator('#importBtn').textContent(),/7件/);
  assert.equal(await page.locator('#remark').inputValue(),'入力を保持');
});

test('invalid replacement CSVs never replace the previous table in memory or IndexedDB',async t=>{
  const {page}=await fixture(t);const original=await mappingRows(page);
  const duplicate=signCSV([...fixtureRecords,fixtureRecords[0]]);
  const missingChild=signCSV(fixtureRecords.slice(0,-1));
  for(const text of [duplicate,missingChild,'wrong,header\n1,2',signCSV().replace(',normal,',',bad,')]){
    await importCSV(page,text);assert.match(await page.locator('#storageMessage').textContent(),/適用できません.*保持/);
    assert.deepEqual(await mappingRows(page),original);
  }
  await typeSign(page,'12345');assert.match(await page.locator('#lookupResult').textContent(),/TRIPS RIGHT/);
  await page.reload();await ready(page);assert.deepEqual(await mappingRows(page),original);
});

test('mismatched CWM child Signs are rejected and preserve the previous lookup and stored table after reload',async t=>{
  const {page}=await fixture(t);const original=await mappingRows(page);
  await typeSign(page,'01010');await page.locator('[data-key="1"]').click();
  for(const sign of ['11011','31010']){
    const changed=fixtureRecords.map(r=>[...r]);changed[5][0]=sign;changed[5][2]='REJECTED PLAY';
    await importCSV(page,signCSV(changed));
    assert.match(await page.locator('#storageMessage').textContent(),/適用できません.*保持.*CWM子Signは枝番＋親Signの後ろ4桁/);
    assert.deepEqual(await mappingRows(page),original);
    assert.match(await page.locator('#lookupResult').textContent(),/TEST CHILD ONE.*TEST PLAY ONE/);
  }
  await page.reload();await ready(page);assert.deepEqual(await mappingRows(page),original);
  await typeSign(page,'11010');assert.match(await page.locator('#lookupResult').textContent(),/TEST CHILD ONE.*TEST PLAY ONE/);
});

test('invalid UTF-8 is rejected without corrupting the saved mapping; the same file can be retried',async t=>{
  const {page}=await fixture(t);const original=await mappingRows(page);
  for(let i=0;i<2;i++){
    await page.locator('#signCsvInput').setInputFiles({name:'bad.csv',mimeType:'text/csv',buffer:Buffer.from([0xff,0xfe,0x80])});await ready(page);
    assert.match(await page.locator('#storageMessage').textContent(),/適用できません/);
    assert.deepEqual(await mappingRows(page),original);
  }
  await importCSV(page);assert.equal(await page.locator('#storageNotice').isVisible(),false);
});

test('mapping write abort keeps the previous table and can be retried',async t=>{
  const {page}=await fixture(t);const original=await mappingRows(page);
  const changed=signCSV().replace('TRIPS RIGHT','REPLACEMENT');
  await abortNext(page,'put');await importCSV(page,changed);
  assert.deepEqual(await mappingRows(page),original);
  await typeSign(page,'12345');assert.match(await page.locator('#lookupResult').textContent(),/TRIPS RIGHT/);
  await importCSV(page,changed);assert.match(await page.locator('#lookupResult').textContent(),/REPLACEMENT/);
  await page.reload();await ready(page);await typeSign(page,'12345');assert.match(await page.locator('#lookupResult').textContent(),/REPLACEMENT/);
});

test('CWM parent shows pending and records without silently choosing a child; blank parent Play is not a match',async t=>{
  const {page}=await fixture(t);await typeSign(page,'01010');
  assert.match(await page.locator('#lookupResult').textContent(),/CWM.*未確定/);
  assert.equal(await page.locator('#cwmBranchInput').isVisible(),true);
  await save(page);const [record]=await rows(page);
  assert.equal(record.sign,'01010');assert.equal(record.lookupStatus,'cwm_pending');assert.equal(record.branch,'');
  assert.equal(record.resolvedSign,'');assert.equal(record.cwmBranch,'');assert.equal(record.parentSign,'01010');assert.equal(record.play,'CWM（枝番未確定）');
  assert.match(await page.locator('#logBody').textContent(),/未確定/);
  await page.reload();await ready(page);assert.deepEqual(await rows(page),[record]);
  await page.locator('#logBody tr[tabindex]').click();assert.match(await page.locator('#lookupResult').textContent(),/未確定/);
});

test('parent plus keypad branch 1/2 uses child Formation/Play and records the exact child identity',async t=>{
  const {page}=await fixture(t);
  for(const branch of ['1','2']){
    await typeSign(page,'01010');await page.locator(`[data-key="${branch}"]`).click();
    assert.equal(await page.locator('#value-sign').textContent(),'01010 · '+branch);
    assert.match(await page.locator('#lookupResult').textContent(),branch==='1'?/TEST CHILD ONE.*TEST PLAY ONE/:/TEST CHILD TWO.*TEST PLAY TWO/);
    await save(page);
  }
  const records=await rows(page);
  assert.equal(records[0].resolvedSign,'11010');assert.equal(records[0].branch,'1');assert.equal(records[0].cwmBranch,'1');
  assert.equal(records[1].resolvedSign,'21010');assert.equal(records[1].cwmBranch,'2');assert.equal(records[1].sign,'01010');
  await page.reload();await ready(page);assert.deepEqual(await rows(page),records);
});

test('direct five-digit child input resolves without requesting or appending a branch',async t=>{
  const {page}=await fixture(t);await typeSign(page,'21010');
  assert.equal(await page.locator('#cwmBranchInput').isVisible(),false);
  assert.match(await page.locator('#lookupResult').textContent(),/TEST CHILD TWO.*TEST PLAY TWO/);
  await save(page);const [record]=await rows(page);
  assert.equal(record.sign,'21010');assert.equal(record.branch,'');assert.equal(record.resolvedSign,'21010');assert.equal(record.parentSign,'01010');assert.equal(record.cwmBranch,'2');
});

test('branch focus reuses the keypad; invalid branches do nothing; deletion removes branch before Sign',async t=>{
  const {page}=await fixture(t);await typeSign(page,'01010');
  await page.locator('[data-key="3"]').click();assert.equal(await page.locator('#value-sign').textContent(),'01010');
  await page.locator('#tab').click();await page.locator('#cwmBranchInput').click();
  await page.locator('[data-key="1"]').click();await page.locator('[data-key="2"]').click();
  assert.match(await page.locator('#lookupResult').textContent(),/TEST PLAY TWO/);
  await page.locator('#backspace').click();assert.equal(await page.locator('#value-sign').textContent(),'01010');assert.match(await page.locator('#lookupResult').textContent(),/未確定/);
  await page.locator('#backspace').click();assert.equal(await page.locator('#value-sign').textContent(),'0101');assert.equal(await page.locator('#cwmBranchInput').isVisible(),false);
});

test('editing a pending CWM into a chosen child updates the same ID and original time; cancelling edits is safe',async t=>{
  const {page}=await fixture(t);await typeSign(page,'01010');await save(page);const [pending]=await rows(page);
  await page.locator('#logBody tr[tabindex]').click();await page.locator('#cwmBranchInput').click();await page.locator('[data-key="1"]').click();await page.locator('#cancelEdit').click();
  assert.deepEqual(await rows(page),[pending]);
  await page.locator('#logBody tr[tabindex]').click();await page.locator('#cwmBranchInput').click();await page.locator('[data-key="2"]').click();await save(page);
  const [chosen]=await rows(page);assert.equal(chosen.id,pending.id);assert.equal(chosen.time,pending.time);assert.equal(chosen.recordedAt,pending.recordedAt);assert.equal(chosen.resolvedSign,'21010');
  await page.reload();await ready(page);assert.deepEqual(await rows(page),[chosen]);
});

test('replacing CSV preserves existing normal, pending and resolved logs, including while editing',async t=>{
  const {page}=await fixture(t);await fillPlay(page);await save(page);
  await typeSign(page,'01010');await save(page);await typeSign(page,'01010');await page.locator('[data-key="1"]').click();await save(page);
  const original=await rows(page);
  await page.locator('#logBody tr[tabindex]').nth(2).click();
  const changed=signCSV().replace('TEST PLAY ONE','CHANGED CHILD').replace('TRIPS RIGHT','CHANGED FORMATION');
  await importCSV(page,changed);assert.deepEqual(await rows(page),original);
  assert.match(await page.locator('#lookupResult').textContent(),/TEST PLAY ONE/);assert.doesNotMatch(await page.locator('#lookupResult').textContent(),/CHANGED CHILD/);
  await page.locator('#remark').fill('追記だけ');await save(page);
  const edited=await rows(page);assert.equal(edited[2].play,'TEST PLAY ONE');assert.equal(edited[0].formation,'TRIPS RIGHT');assert.equal(edited[1].lookupStatus,'cwm_pending');
  await page.reload();await ready(page);assert.deepEqual(await rows(page),edited);
  await typeSign(page,'01010');await page.locator('[data-key="1"]').click();assert.match(await page.locator('#lookupResult').textContent(),/CHANGED CHILD/);
});

test('CSV exports explicit CWM pending/resolved/unknown metadata while keeping the original eight columns',async t=>{
  const {page}=await fixture(t);
  await typeSign(page,'01010');await save(page);await typeSign(page,'01010');await page.locator('[data-key="2"]').click();await save(page);await typeSign(page,'99999');await save(page);
  const original=await rows(page),downloading=page.waitForEvent('download');await page.locator('#exportBtn').click();const download=await downloading;
  const text=await fs.readFile(await download.path(),'utf8');
  assert.match(text,/Time,Down,Distance,Str Side,Sign,Formation,Play,Remark,Lookup Status,Resolved Sign,Parent Sign,CWM Branch/);
  assert.match(text,/01010,TEST PARENT,CWM（枝番未確定）,,cwm_pending,,01010,/);
  assert.match(text,/01010,TEST CHILD TWO,TEST PLAY TWO,,cwm_resolved,21010,01010,2/);
  assert.match(text,/99999,,,,unmatched,,,/);
  assert.deepEqual(await rows(page),original);
});

test('game reset deletes plays only; imported mapping remains available after reload',async t=>{
  const {page}=await fixture(t);const mapping=await mappingRows(page);await save(page);
  await confirmReset(page,[true,true]);assert.deepEqual(await rows(page),[]);assert.deepEqual(await mappingRows(page),mapping);
  await page.reload();await ready(page);await typeSign(page,'01010');await page.locator('[data-key="1"]').click();assert.match(await page.locator('#lookupResult').textContent(),/TEST PLAY ONE/);
});

test('delayed mapping restore blocks all recording and import until the persisted mapping is ready',async t=>{
  const {page}=await fixture(t);await save(page);const original=await rows(page);
  const source=await fs.readFile(path.join(root,'storage.js'),'utf8');
  await page.route('**/storage.js',route=>route.fulfill({contentType:'text/javascript',body:source+`
    const actualMappingLoad=PlayLogStore.loadMapping;
    PlayLogStore.loadMapping=()=>{PlayLogStore.loadMapping=actualMappingLoad;return new Promise(resolve=>{window.releaseMapping=()=>resolve(actualMappingLoad());});};
  `}));
  await page.reload();await page.waitForFunction(()=>typeof releaseMapping==='function');
  assert.equal(await page.locator('#enter').isDisabled(),true);assert.equal(await page.locator('#importBtn').isDisabled(),true);
  await page.keyboard.press('Enter');await page.evaluate(()=>releaseMapping());await ready(page);
  assert.deepEqual(await rows(page),original);await typeSign(page,'01010');assert.match(await page.locator('#lookupResult').textContent(),/CWM/);
});

test('mapping restore failure blocks writes and retry restores both mapping and logs',async t=>{
  const {page}=await fixture(t);await save(page);const original=await rows(page),mapping=await mappingRows(page);
  await page.addInitScript(()=>{const actual=IDBObjectStore.prototype.get;IDBObjectStore.prototype.get=function(...args){if(this.name==='signMappings'){IDBObjectStore.prototype.get=actual;throw new DOMException('Injected mapping read failure','UnknownError');}return actual.apply(this,args);};});
  await page.reload();await page.locator('#retryStorage').waitFor({state:'visible'});assert.equal(await page.locator('#enter').isDisabled(),true);
  await page.locator('#retryStorage').click();await ready(page);assert.deepEqual(await rows(page),original);assert.deepEqual(await mappingRows(page),mapping);
});

test('Phase 1 database upgrade preserves original rows byte-for-byte, IDs and sequence before importing CSV',async t=>{
  const context=await browser.newContext({viewport:{width:1180,height:820}});t.after(()=>context.close());
  const original={id:17,time:'12:34:56',recordedAt:'2026-01-01T03:34:56.000Z',down:'1',distance:'10',strSide:'L',sign:'12345',formation:'LEGACY FORMATION',play:'LEGACY PLAY',remark:'過去記録'};
  const page=await context.newPage();await page.goto(origin+'/blank');
  await page.evaluate(original=>new Promise((resolve,reject)=>{
    const request=indexedDB.open('sideline-play-logger',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('plays',{keyPath:'id',autoIncrement:true});
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{const db=request.result,tx=db.transaction('plays','readwrite');tx.objectStore('plays').put(original);tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};
  }),original);
  await page.goto(origin);await ready(page);
  assert.deepEqual(await rows(page),[original]);assert.equal(await page.evaluate(()=>new Promise(resolve=>{const req=indexedDB.open('sideline-play-logger');req.onsuccess=()=>{resolve(req.result.version);req.result.close();};})),2);
  await importCSV(page);assert.deepEqual(await rows(page),[original]);
  await page.locator('#logBody tr[tabindex]').click();assert.match(await page.locator('#lookupResult').textContent(),/LEGACY FORMATION.*LEGACY PLAY/);
  await page.locator('#remark').fill('編集');await save(page);const [edited]=await rows(page);assert.equal(edited.formation,'LEGACY FORMATION');assert.equal(edited.play,'LEGACY PLAY');assert.equal(edited.time,original.time);
  await save(page);assert.equal((await rows(page))[1].id,18);
});

test('CSV cell text is rendered literally, not as HTML or executable instructions',async t=>{
  const {page}=await fixture(t);const records=fixtureRecords.map(r=>[...r]);records[0][1]='<img src=x onerror="window.csvExecuted=true">';records[0][2]='<script>window.csvExecuted=true</script>';
  await importCSV(page,signCSV(records));await typeSign(page,'12345');
  assert.equal(await page.locator('#lookupResult img,#lookupResult script').count(),0);assert.equal(await page.evaluate(()=>window.csvExecuted),undefined);
  await save(page);assert.equal(await page.locator('#logBody img,#logBody script').count(),0);
});

test('CSV replacement never clears a failed-record draft or its unsaved warning',async t=>{
  const {page}=await fixture(t);await fillPlay(page);await abortNext(page,'add');await save(page);
  await importCSV(page,'invalid');assert.match(await page.locator('#storageMessage').textContent(),/未保存/);
  await importCSV(page);assert.match(await page.locator('#storageMessage').textContent(),/未保存/);
  assert.equal(await page.locator('#remark').inputValue(),'日本語, "確認"\n次の行');assert.deepEqual(await rows(page),[]);
  await save(page);assert.equal((await rows(page)).length,1);assert.equal(await page.locator('#storageNotice').isVisible(),false);
});
