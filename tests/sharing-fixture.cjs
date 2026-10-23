'use strict';
// All identities, passwords, plays and keys in this fixture are fictional.
const {PGlite}=require('@electric-sql/pglite'),{WebSocketServer}=require('ws'),http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),adminId='00000000-0000-4000-8000-000000000001',otherId='00000000-0000-4000-8000-000000000002';
async function database(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create schema realtime;create table realtime.messages(topic text);alter table realtime.messages enable row level security;
 create table realtime.sent(topic text,payload jsonb);
 create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true)$$;
 create function realtime.send(payload jsonb,event text,topic text,private boolean) returns void language sql as $$insert into realtime.sent values(topic,payload)$$;
 grant usage on schema public,auth,realtime to anon,authenticated,service_role;
 grant select on realtime.messages to authenticated;
 grant all on auth.users to service_role;
 insert into auth.users values('${adminId}'),('${otherId}');`);
 const migrations=path.join(root,'supabase/migrations');
 for(const file of (await fs.readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await fs.readFile(path.join(migrations,file),'utf8'));
 await db.query('insert into public.logger_admins values($1)',[adminId]);
 const salt=crypto.randomBytes(16).toString('hex'),hash=crypto.pbkdf2Sync('short',Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex');
 await db.query('insert into public.logger_admin_logins(login_id,user_id,password_salt,password_hash) values($1,$2,$3,$4)',['fixture-admin',adminId,salt,hash]);
 return db;
}
async function service(){
 const db=await database(),users=new Map([[adminId,{id:adminId,email:'admin@sideline.invalid',password:'FAKE-admin-pass-2026'}],[otherId,{id:otherId,email:'other@sideline.invalid',password:'FAKE-other-pass-2026'}]]),tokens=new Map(),links=new Map();
 let chain=Promise.resolve(),origin,failPublish=false,delayPublish=null,releasePublish=null;
 const calls=[],sockets=new Set();
 async function query(role,user,sql,params=[]){
  const next=chain.then(async()=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user||'']);await db.exec('set role '+role);try{return await db.query(sql,params);}finally{await db.exec('reset role');}});chain=next.catch(()=>{});return next;
 }
 const authToken=(id)=>{const token=crypto.randomUUID();tokens.set(token,id);return {access_token:token,refresh_token:token,expires_in:3600,expires_at:Date.now()/1000+3600,user:{id}};};
 async function api(url,options={}){
  const u=new URL(url),route=u.pathname,method=options.method||'GET',headers=new Headers(options.headers),token=headers.get('authorization')?.replace(/^Bearer /i,''),role=token==='service-test'?'service_role':tokens.has(token)?'authenticated':'anon',uid=tokens.get(token);
  let body=options.body?JSON.parse(options.body):{};calls.push({route,method,body,uid});
  const reply=(status,value)=>new Response(value===null?'':JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  try{
   if(route==='/auth/v1/token'){
    let user;if(u.searchParams.get('grant_type')==='refresh_token'){user=users.get(tokens.get(body.refresh_token));}else user=[...users.values()].find(x=>x.email===body.email&&x.password===body.password);
    return user?reply(200,authToken(user.id)):reply(400,{error:'Invalid login credentials'});
   }
   if(route==='/auth/v1/user')return users.has(uid)?reply(200,{id:uid}):reply(401,{error:'Unauthorized'});
   if(route==='/auth/v1/logout'){tokens.delete(token);return reply(200,null);}
   if(route==='/auth/v1/admin/generate_link'){
    if(role!=='service_role')return reply(403,{error:'Forbidden'});
    const user=[...users.values()].find(x=>x.email===body.email);if(!user||body.type!=='magiclink')return reply(400,{error:'Unknown account'});
    const hash=crypto.randomUUID();links.set(hash,user.id);return reply(200,{hashed_token:hash});
   }
   if(route==='/auth/v1/verify'){
    const id=links.get(body.token_hash);links.delete(body.token_hash);return id&&body.type==='email'?reply(200,authToken(id)):reply(400,{error:'Invalid token'});
   }
   if(route.startsWith('/auth/v1/admin/users')){
    if(role!=='service_role')return reply(403,{error:'Forbidden'});
    if(method==='POST'){const id=crypto.randomUUID();users.set(id,{id,email:body.email,password:body.password});await query('service_role',null,'insert into auth.users values($1)',[id]);return reply(200,{id});}
    if(method==='DELETE'){const id=route.split('/').at(-1);users.delete(id);await query('service_role',null,'delete from auth.users where id=$1',[id]);return reply(200,null);}
    if(method==='GET'){const user=users.get(route.split('/').at(-1));return user?reply(200,{id:user.id,email:user.email,email_confirmed_at:'2026-01-01T00:00:00Z'}):reply(404,{error:'Unknown account'});}
   }
   if(route.startsWith('/rest/v1/rpc/')){
    const name=route.split('/').at(-1),signature={logger_configure:[['p_owner','uuid'],['p_writer','uuid'],['p_login','text'],['p_viewer','uuid'],['p_email','text'],['p_takeover','boolean']],logger_stop:[['p_owner','uuid']],logger_publish:[['p_game','uuid'],['p_writer','uuid'],['p_revision','bigint'],['p_records','jsonb']]}[name];
    if(!signature)return reply(404,{error:'Unknown RPC'});
    if(name==='logger_publish'&&failPublish)return reply(503,{error:'Test disconnection'});
    if(name==='logger_publish'&&delayPublish){const waiting=delayPublish;delayPublish=null;await waiting;}
    const params=signature.map(([key,type])=>type==='jsonb'?JSON.stringify(body[key]):body[key]),sql='select public.'+name+'('+signature.map(([,type],i)=>'$'+(i+1)+'::'+type).join(',')+') as result';
    const result=(await query(role,uid,sql,params)).rows[0].result;await broadcast();return reply(200,result);
   }
   if(route.startsWith('/rest/v1/')){
    const table=route.split('/').at(-1);if(!['logger_games','logger_admins','logger_admin_logins'].includes(table))return reply(404,{error:'Unknown table'});
    const allowed=['id','user_id','owner_id','active','writer_id','writer_revision','viewer_login','viewer_email','viewer_user_id','version','records','updated_at','login_id','password_salt','password_hash'];
    const columns=(u.searchParams.get('select')||'*').split(',');if(columns.some(c=>!allowed.includes(c)))return reply(400,{error:'Invalid columns'});
    const filters=[...u.searchParams].filter(([k])=>k!=='select'),params=filters.map(([,v])=>v.slice(3));if(filters.some(([k,v])=>!allowed.includes(k)||!v.startsWith('eq.')))return reply(400,{error:'Invalid filter'});
    const where=filters.length?' where '+filters.map(([k],i)=>k+'=$'+(i+1)).join(' and '):'';
    if(method==='GET')return reply(200,(await query(role,uid,'select '+columns.join(',')+' from public.'+table+where,params)).rows);
    // Direct viewer writes hit real PostgreSQL grants rather than a mocked denial.
    await query(role,uid,'delete from public.'+table+where,params);return reply(200,null);
   }
   return reply(404,{error:'Unknown API route'});
  }catch(error){return reply(error.code==='42501'?403:400,{message:error.message,code:error.code});}
 }
 async function broadcast(){for(const item of sockets){if(!item.gameId)continue;const game=(await query('service_role',null,'select version from public.logger_games where id=$1',[item.gameId])).rows[0];if(game)item.ws.send(JSON.stringify({topic:'realtime:logger:'+item.gameId,event:'broadcast',payload:{event:'changed',payload:{version:game.version}}}));}}
 const handler=(await import(path.join(root,'supabase/functions/logger-share/handler.mjs'))).handleShareRequest;
 const server=http.createServer(async(req,res)=>{
  try{
   const u=new URL(req.url,origin),chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString();
   let response;
   if(u.pathname==='/functions/v1/logger-share')response=await handler(new Request(u,{method:req.method,headers:{...req.headers,origin},body:req.method==='POST'?body:undefined}),{url:origin,serviceKey:'service-test',allowedOrigins:[origin],fetch:api});
   else if(u.pathname.startsWith('/rest/')||u.pathname.startsWith('/auth/'))response=await api(u,{method:req.method,headers:req.headers,body:body||undefined});
   else if(u.pathname==='/sharing-config.js')response=new Response(`window.LOGGER_SHARING_CONFIG=${JSON.stringify({url:origin,publishableKey:'sb_publishable_test'})}`,{headers:{'Content-Type':'text/javascript'}});
   else {const file=u.pathname.slice(1)||'index.html';if(!['index.html','storage.js','sign-lookup.js','sharing.js'].includes(file)){res.writeHead(404).end();return;}response=new Response(await fs.readFile(path.join(root,file)),{headers:{'Content-Type':file.endsWith('.js')?'text/javascript':'text/html'}});}
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
  }catch(error){res.writeHead(500).end(error.stack);}
 });
 const wsServer=new WebSocketServer({server,path:'/realtime/v1/websocket'});
 wsServer.on('connection',ws=>{const item={ws};sockets.add(item);ws.on('close',()=>sockets.delete(item));ws.on('message',async data=>{
  const m=JSON.parse(data);if(m.event==='phx_join'){const uid=tokens.get(m.payload.access_token),id=m.topic.replace('realtime:logger:','');const rows=uid?(await query('authenticated',uid,'select id from public.logger_games where id=$1',[id])).rows:[];if(rows.length)item.gameId=id;ws.send(JSON.stringify({topic:m.topic,event:'phx_reply',ref:m.ref,payload:{status:rows.length?'ok':'error',response:{}}}));}
  if(m.event==='heartbeat')ws.send(JSON.stringify({topic:'phoenix',event:'phx_reply',ref:m.ref,payload:{status:'ok',response:{}}}));
 });});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 return {db,origin,calls,query,api,handler,authToken,adminId,otherId,
  setOffline:value=>failPublish=value,
  delayNextPublish:()=>{delayPublish=new Promise(resolve=>releasePublish=resolve);},
  releasePublish:()=>{releasePublish?.();releasePublish=null;},
  broadcast,
  close:async()=>{for(const s of sockets)s.ws.terminate();await new Promise(r=>wsServer.close(r));await new Promise(r=>server.close(r));await db.close();}
 };
}
module.exports={database,service,adminId,otherId};
