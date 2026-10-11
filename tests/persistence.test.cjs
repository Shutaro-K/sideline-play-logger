'use strict';
const {test: nodeTest, before, after} = require('node:test');
const test=(name,fn)=>nodeTest(name,{timeout:30000},fn);
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const playwright = require('playwright');

const engine = process.env.BROWSER_ENGINE || 'chromium';
const browserType = playwright[engine];
const launchOptions = {headless: true};
if (process.env.BROWSER_CHANNEL) launchOptions.channel = process.env.BROWSER_CHANNEL;
const root = path.resolve(__dirname, '..');
let server, browser, origin;

before(async () => {
  server = http.createServer(async (req, res) => {
    const filename = req.url.split('?')[0] === '/storage.js' ? 'storage.js' : 'index.html';
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
async function fixture(t) {
  const context = await browser.newContext({viewport: {width: 1180, height: 820}, hasTouch: true});
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'No uncaught browser errors'));
  await page.goto(origin);
  await ready(page);
  return {page, context};
}
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
  await page.evaluate(() => { DEMO_LOOKUP['12345']={formation:'CHANGED',play:'CHANGED'}; });
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
  assert.equal(bytes.toString('utf8'), '\uFEFFTime,Down,Distance,Str Side,Sign,Formation,Play,Remark\r\n'+
    `${records[0].time},1,10,R,12345,TRIPS RIGHT,INSIDE ZONE,"更新,日本語 ""注記""\n二行目"\r\n${records[1].time},,,,,,,`);
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
    await fillPlay(page); await save(page); const original=await rows(page);
    await context.close(); context=null;
    context=await browserType.launchPersistentContext(profile,{...launchOptions,viewport:{width:1180,height:820}});
    page=await context.newPage(); await page.goto(origin); await ready(page);
    assert.deepEqual(await rows(page),original);
    assert.equal(await page.locator('#logBody tr[tabindex]').count(),1);
  } finally {if(context)await context.close();await fs.rm(profile,{recursive:true,force:true});}
});
