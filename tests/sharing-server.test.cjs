'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),{service}=require('./sharing-fixture.cjs');
let env,adminToken,game;
const writer='10000000-0000-4000-8000-000000000001',password='FAKE-viewer-pass-2026';
before(async()=>{env=await service();adminToken=env.authToken(env.adminId).access_token;});after(async()=>{await env?.close();});
async function action(body,token=adminToken,origin=env.origin){return env.handler(new Request(env.origin+'/functions/v1/logger-share',{method:'POST',headers:{origin,...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}),{url:env.origin,serviceKey:'service-test',allowedOrigins:[env.origin],fetch:env.api});}
test('administrator ID login checks the server-only password hash and issues only its mapped account session',async()=>{
 const before=env.calls.filter(c=>c.route==='/auth/v1/admin/generate_link').length;
 for(const [id,pw] of [['fixture-admin','wrong'],['unknown-admin','short']]){
  const denied=await action({action:'admin-login',id,password:pw},null);assert.equal(denied.status,401);assert.deepEqual(await denied.json(),{error:'IDまたはPWを確認してください。'});
 }
 assert.equal(env.calls.filter(c=>c.route==='/auth/v1/admin/generate_link').length,before,'Wrong credentials never mint an Auth link');
 const response=await action({action:'admin-login',id:'fixture-admin',password:'short',userId:env.otherId,email:'other@sideline.invalid'},null),body=await response.json();assert.equal(response.status,200);
 assert.deepEqual(Object.keys(body),['session']);assert(body.session.access_token);assert(!JSON.stringify(body).includes('password_hash'));assert(!JSON.stringify(body).includes('@sideline.invalid'));
 const status=await action({action:'status'},body.session.access_token);assert.equal(status.status,200);assert.equal((await status.json()).ownerId,env.adminId);
 for(const token of [null,body.session.access_token]){
  const read=await env.api(env.origin+'/rest/v1/logger_admin_logins?select=password_hash',{headers:token?{Authorization:'Bearer '+token}:{}});assert.equal(read.status,403);
 }
 const native=await env.api(env.origin+'/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email:'admin@sideline.invalid',password:'FAKE-admin-pass-2026'})});assert.equal(native.status,200,'Existing Auth password remains valid');
});
test('only allowlisted admins may create sharing; wrong origins and anonymous writes are rejected',async()=>{
 assert.equal((await action({action:'status'},null)).status,401);assert.equal((await action({action:'status'},env.authToken(env.otherId).access_token)).status,403);assert.equal((await action({action:'status'},adminToken,'https://not-allowed.invalid')).status,403);
 const response=await action({action:'configure',id:'fixture-game',password,writerId:writer});assert.equal(response.status,200);game=(await response.json()).game;
 const denied=await env.api(env.origin+'/rest/v1/logger_games?select=id',{headers:{}});assert.equal(denied.status,403);
});
test('viewer ID/PW produces a read-only session; wrong credentials return no records',async()=>{
 assert.equal((await action({action:'viewer-login',id:'fixture-game',password:'wrong'},null)).status,401);
 assert.equal((await action({action:'viewer-login',id:'missing-id',password:'wrong'},null)).status,401);
 const response=await action({action:'viewer-login',id:'fixture-game',password},null),login=await response.json();assert.equal(response.status,200);
 const token=login.session.access_token;assert.equal(login.gameId,game.id);
 const headers={Authorization:'Bearer '+token};assert.equal((await env.api(env.origin+'/rest/v1/logger_games?select=id&id=eq.'+game.id,{headers})).status,200);
 assert.equal((await env.api(env.origin+'/rest/v1/logger_games?select=id&id=eq.'+game.id,{method:'DELETE',headers})).status,403);
 assert.equal((await env.api(env.origin+'/rest/v1/rpc/logger_publish',{method:'POST',headers,body:JSON.stringify({p_game:game.id,p_writer:writer,p_revision:1,p_records:[]})})).status,403);
 assert.equal((await action({action:'configure',id:'hacked-game',password,writerId:writer},token)).status,403);
});
test('new snapshots, duplicate retries and resets reject stale data and unknown/CSV fields',async()=>{
 const publish=(revision,records)=>env.api(env.origin+'/rest/v1/rpc/logger_publish',{method:'POST',headers:{Authorization:'Bearer '+adminToken},body:JSON.stringify({p_game:game.id,p_writer:writer,p_revision:revision,p_records:records})});
 const records=[{id:1,time:'12:00:00',formation:'FAKE',play:'FAKE PLAY',remark:'架空メモ'}];
 assert.equal((await publish(1,records)).status,200);assert.equal((await publish(1,records)).status,200);
 assert.equal((await publish(2,[])).status,200);assert.equal((await publish(1,records)).status,200);
 assert.deepEqual((await env.query('service_role',null,'select records from logger_games where id=$1',[game.id])).rows[0].records,[]);
 assert.equal((await publish(3,[{...records[0],signMappings:['must never be accepted']}])).status,400);
 assert.equal((await publish(3,[records[0],records[0]])).status,400);
 const sent=(await env.db.query('select payload from realtime.sent')).rows;assert(sent.every(r=>Object.keys(r.payload).join(',')==='version'));
});
test('credential rotation revokes an already logged-in viewer and failed configuration preserves the table',async()=>{
 const old=await(await action({action:'viewer-login',id:'fixture-game',password},null)).json();
 const failed=await action({action:'configure',id:'fixture-game',password,writerId:'20000000-0000-4000-8000-000000000001'});assert.equal(failed.status,409);
 assert.equal((await action({action:'viewer-login',id:'fixture-game',password},null)).status,200);
 const changed=await action({action:'configure',id:'fixture-game',password:'FAKE-new-password-2026',writerId:writer});assert.equal(changed.status,200);
 const oldRead=await env.api(env.origin+'/rest/v1/logger_games?select=id&id=eq.'+game.id,{headers:{Authorization:'Bearer '+old.session.access_token}});assert.deepEqual(await oldRead.json(),[]);
 assert.equal((await action({action:'viewer-login',id:'fixture-game',password},null)).status,401);
 const newer=await(await action({action:'viewer-login',id:'fixture-game',password:'FAKE-new-password-2026'},null)).json();
 assert.equal((await action({action:'stop'})).status,200);
 assert.deepEqual(await(await env.api(env.origin+'/rest/v1/logger_games?select=id',{headers:{Authorization:'Bearer '+newer.session.access_token}})).json(),[]);
});
test('removing administrator permission also removes its ID login without minting a session',async()=>{
 await env.query('service_role',null,'delete from logger_admins where user_id=$1',[env.adminId]);
 const before=env.calls.filter(c=>c.route==='/auth/v1/admin/generate_link').length;
 assert.equal((await action({action:'admin-login',id:'fixture-admin',password:'short'},null)).status,401);
 assert.equal(env.calls.filter(c=>c.route==='/auth/v1/admin/generate_link').length,before);
});
