'use strict';
const {test:nodeTest,before,after}=require('node:test'),assert=require('node:assert/strict'),playwright=require('playwright'),{service}=require('./sharing-fixture.cjs'),{csv}=require('./fixtures.cjs');
const test=(name,fn)=>nodeTest(name,{timeout:45000},fn),password='FAKE-viewer-pass-2026';let env,browser;
before(async()=>{env=await service();const options={headless:true};if(process.env.BROWSER_CHANNEL)options.channel=process.env.BROWSER_CHANNEL;browser=await playwright[process.env.BROWSER_ENGINE||'chromium'].launch(options);});
after(async()=>{await browser?.close();await env?.close();});
const ready=page=>page.waitForFunction(()=>!document.getElementById('enter').disabled);
const saved=page=>page.evaluate(()=>PlayLogStore.load());
async function save(page){await page.locator('[data-field=sign]').click();await page.locator('#enter').click();await ready(page);}
async function fixture(t){
 env.setOffline(false);const contexts=[];t.after(async()=>{for(const c of contexts)await c.close();});
 async function page(viewer=false){const context=await browser.newContext({viewport:{width:1180,height:820},hasTouch:true});contexts.push(context);if(viewer)await context.addInitScript(()=>{indexedDB.open=()=>{throw new Error('Viewer must not open local records or mapping');};});const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>assert(r.url().startsWith(env.origin+'/'),'Only the local fictional test service is contacted'));t.after(()=>assert.deepEqual(errors,[]));await p.goto(env.origin+(viewer?'/?view=1':'/'));return p;}
 const input=await page();await ready(input);await input.locator('#sharingBtn').click();await input.locator('#adminId').fill('fixture-admin');await input.locator('#adminPassword').fill('short');await input.locator('#adminLogin button').click();await input.locator('#shareSettings').waitFor({state:'visible'});await input.locator('#newViewerId').fill('fixture-game');await input.locator('#newViewerPassword').fill(password);if(await input.locator('#takeoverLabel').isVisible())await input.locator('#takeover').check();await input.locator('#viewerSettings button[type=submit]').click();await input.waitForFunction(()=>document.getElementById('shareMessage').textContent.includes('共有設定を保存しました'));await input.locator('#closeSharing').click();await input.waitForFunction(async()=>{const s=await PlayLogStore.loadSharing();return s.syncedRevision>=s.revision;});
 const viewer=await page(true);await viewer.locator('#viewerId').fill('fixture-game');await viewer.locator('#viewerPassword').fill(password);await viewer.locator('#viewerLoginSubmit').click();await viewer.locator('#viewerLoginDialog').waitFor({state:'hidden'});
 return {input,viewer};
}
test('admin login accepts a short ID and password, rejecting wrong credentials before opening settings',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(env.origin);await ready(page);await page.locator('#sharingBtn').click();
 assert.equal(await page.locator('#adminId').getAttribute('type'),'text');
 await page.locator('#adminId').fill('fixture-admin');await page.locator('#adminPassword').fill('wrong');await page.locator('#adminLogin button').click();
 await page.waitForFunction(()=>document.getElementById('shareMessage').textContent.includes('IDまたはPW'));
 assert.equal(await page.locator('#shareSettings').isVisible(),false);
 await page.locator('#adminPassword').fill('short');await page.locator('#adminLogin button').click();await page.locator('#shareSettings').waitFor({state:'visible'});
 assert.equal(await page.locator('#adminPassword').inputValue(),'');assert.deepEqual(errors,[]);
});
test('two devices share only committed records; viewer has the same table and live note popovers',async t=>{
 const {input,viewer}=await fixture(t);const published=()=>env.calls.filter(c=>c.route.endsWith('/logger_publish')).length,before=published();
 await input.locator('#signCsvInput').setInputFiles({name:'fictional.csv',mimeType:'text/csv',buffer:Buffer.from(csv())});await ready(input);
 await input.locator('[data-key="1"]').click();await input.locator('[data-distance="M"]').click();await input.locator('[data-key="L"]').click();for(const k of '12345')await input.locator(`[data-key="${k}"]`).click();
 await input.locator('#observationsBtn').click();await input.locator('#insideText').fill('架空Front\nStunt');await input.locator('#outsideText').fill('架空担当');await input.locator('[data-cover="0"]').click();await input.locator('#returnWithDraft').click();await input.locator('#remark').fill('架空メモ');
 assert.equal(published(),before,'Drafts and sign mapping do not publish');assert.equal(await viewer.locator('#logBody tr[tabindex]').count(),0);
 await save(input);await viewer.waitForFunction(()=>document.getElementById('logBody').textContent.includes('INSIDE ZONE'));
 assert.deepEqual(await viewer.locator('#logBody .check-cell .note-summary').allTextContents(),['✓','✓']);
 for(const selector of ['#entry','#importBtn','#resetBtn','#exportBtn','#toggleTable','.series-controls'])assert.equal(await viewer.locator(selector).isVisible(),false);
 await viewer.locator('[data-kind=inside]').click();assert.equal(await viewer.locator('#noteContent').innerText(),'架空Front\nStunt');
 const first=(await saved(input))[0];await input.locator('#logBody tr[tabindex]').click();await input.locator('#observationsBtn').click();await input.locator('#insideText').fill('架空Frontの訂正');await input.locator('#saveObservation').click();await ready(input);
 await viewer.waitForFunction(()=>document.getElementById('noteContent').textContent==='架空Frontの訂正');assert.equal(await viewer.locator('#notePopover').isVisible(),true);
 const edited=(await saved(input))[0];assert.equal(edited.id,first.id);assert.equal(edited.time,first.time);assert.equal((await saved(input)).length,1);
 await viewer.locator('#closeNote').click();await viewer.locator('[data-kind=outside]').click();assert.match(await viewer.locator('#noteContent').innerText(),/Coverage：0\n架空担当/);await viewer.locator('#closeNote').click();await viewer.locator('[data-kind=remark]').click();assert.equal(await viewer.locator('#noteContent').innerText(),'架空メモ');
 await viewer.evaluate(()=>{saveRecord();resetRecords();editRecord(1);exportCSV();});assert.equal(await viewer.locator('#entry').isVisible(),false);
 for(const call of env.calls.filter(c=>c.route.endsWith('/logger_publish')))assert(!JSON.stringify(call.body).includes('signMappings'));
});
test('offline records survive reload and reconnect exactly once without blocking entry',async t=>{
 const {input,viewer}=await fixture(t);env.setOffline(true);await save(input);const original=await saved(input);assert.equal(original.length,1);
 await input.waitForFunction(()=>document.getElementById('sharingBtn').textContent.includes('未送信'));assert.equal(await viewer.locator('#logBody tr[tabindex]').count(),0);
 await input.reload();await ready(input);assert.deepEqual(await saved(input),original);const pending=await input.evaluate(()=>PlayLogStore.loadSharing());assert(pending.revision>pending.syncedRevision);
 env.setOffline(false);await input.evaluate(()=>{window.dispatchEvent(new Event('online'));});await viewer.waitForFunction(()=>document.querySelectorAll('#logBody tr[tabindex]').length===1);await input.evaluate(()=>LoggerSharing.flush());assert.equal((await saved(input)).length,1);
 const cloud=(await env.query('service_role',null,'select records from logger_games')).rows[0].records;assert.deepEqual(cloud,original);
});
test('a delayed old publish cannot restore records after the reset has reached the shared table',async t=>{
 const {input,viewer}=await fixture(t);env.delayNextPublish();await save(input);await input.waitForFunction(()=>document.getElementById('sharingBtn').textContent.includes('送信中'));
 input.on('dialog',d=>d.accept());await input.locator('#resetBtn').click();await ready(input);
 await input.waitForFunction(async()=>{const s=await PlayLogStore.loadSharing();return s.syncedRevision>=s.revision;});
 env.releasePublish();await input.evaluate(()=>LoggerSharing.flush());await viewer.reload();await viewer.locator('#viewerLoginDialog').waitFor({state:'hidden'});
 await viewer.waitForFunction(()=>document.getElementById('viewerStatus').textContent.includes('更新'));
 assert.equal(await viewer.locator('#logBody tr[tabindex]').count(),0);assert.deepEqual((await env.query('service_role',null,'select records from logger_games')).rows[0].records,[]);
 await input.reload();await ready(input);assert.deepEqual(await saved(input),[]);
});
test('sharing stop clears an already logged-in viewer and preserves local records and mapping',async t=>{
 const {input,viewer}=await fixture(t);await input.locator('#signCsvInput').setInputFiles({name:'fictional.csv',mimeType:'text/csv',buffer:Buffer.from(csv())});await ready(input);await save(input);await viewer.waitForFunction(()=>document.querySelectorAll('#logBody tr[tabindex]').length===1);const before=await saved(input);
 await input.locator('#sharingBtn').click();input.once('dialog',d=>d.accept());await input.locator('#stopSharing').click();await input.waitForFunction(()=>document.getElementById('shareCurrent').textContent.startsWith('共有停止中'));
 await viewer.locator('#viewerLoginDialog').waitFor({state:'visible'});assert.equal(await viewer.locator('#logBody tr[tabindex]').count(),0);assert.equal(await viewer.locator('#notePopover').isVisible(),false);assert.deepEqual(await saved(input),before);assert.equal((await input.evaluate(()=>PlayLogStore.loadMapping())).rows.length,7);
});

test('an aborted local save never advances the durable sharing revision or uploads the draft',async t=>{
 const {input,viewer}=await fixture(t);const initial=await input.evaluate(()=>PlayLogStore.loadSharing()),count=env.calls.filter(c=>c.route.endsWith('/logger_publish')).length;
 await input.locator('#remark').fill('端末内の未確定入力');
 await input.evaluate(()=>{const original=IDBObjectStore.prototype.add;IDBObjectStore.prototype.add=function(...args){IDBObjectStore.prototype.add=original;const result=original.apply(this,args);result.addEventListener('success',()=>this.transaction.abort());return result;};});
 await save(input);assert.deepEqual(await saved(input),[]);assert.equal(await input.locator('#remark').inputValue(),'端末内の未確定入力');
 assert.match(await input.locator('#storageMessage').textContent(),/未保存/);
 assert.deepEqual(await input.evaluate(()=>PlayLogStore.loadSharing()),initial);assert.equal(env.calls.filter(c=>c.route.endsWith('/logger_publish')).length,count);assert.equal(await viewer.locator('#logBody tr[tabindex]').count(),0);
});
