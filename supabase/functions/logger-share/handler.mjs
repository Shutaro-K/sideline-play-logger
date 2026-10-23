// Passwords and Auth links are never logged or returned by admin status.
async function passwordMatches(password, credentials) {
  const salt=credentials?.password_salt||'0'.repeat(32),expected=credentials?.password_hash||'0'.repeat(64);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const bytes=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:100000,salt:Uint8Array.from(salt.match(/../g),v=>parseInt(v,16))},key,256));
  let difference=0;for(let i=0;i<bytes.length;i++)difference|=bytes[i]^parseInt(expected.slice(i*2,i*2+2),16);
  return Boolean(credentials)&&difference===0;
}
export async function handleShareRequest(request, env) {
  const origin=request.headers.get('origin');
  const cors={'Access-Control-Allow-Origin':origin || '',Vary:'Origin','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS','Cache-Control':'no-store'};
  const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
  if(!origin || !env.allowedOrigins.includes(origin))return reply(403,{error:'接続元が許可されていません。'});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(request.method!=='POST')return reply(405,{error:'POSTのみ利用できます。'});
  let createdUser=null;
  async function api(route,{method='GET',body,token=env.serviceKey}={}) {
    const response=await env.fetch(env.url+route,{method,headers:{apikey:env.serviceKey,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await response.text();let data;try{data=text?JSON.parse(text):null;}catch{throw new Error('upstream_error');}
    if(!response.ok)throw new Error(data?.message==='writer_conflict'?'writer_conflict':'upstream_error');
    return data;
  }
  try {
    if(!env.url||!env.serviceKey)return reply(503,{error:'共有先の設定が完了していません。'});
    const text=await request.text();if(text.length>8192)return reply(413,{error:'入力が長すぎます。'});
    let input;try{input=JSON.parse(text);}catch{return reply(400,{error:'入力形式が不正です。'});}
    if(!input||typeof input!=='object'||Array.isArray(input))return reply(400,{error:'入力形式が不正です。'});
    if(input.action==='admin-login') {
      const login=String(input.id||'').trim().toLowerCase(),password=String(input.password||'');
      if(!/^[a-z0-9_-]{1,40}$/.test(login)||password.length<1||password.length>128)return reply(401,{error:'IDまたはPWを確認してください。'});
      const credentials=(await api('/rest/v1/logger_admin_logins?select=user_id,password_salt,password_hash&login_id=eq.'+encodeURIComponent(login)))[0];
      if(!await passwordMatches(password,credentials))return reply(401,{error:'IDまたはPWを確認してください。'});
      // The account comes only from the service-only mapping, never from client input.
      const admins=await api('/rest/v1/logger_admins?select=user_id&user_id=eq.'+credentials.user_id);
      if(!admins.length)return reply(401,{error:'IDまたはPWを確認してください。'});
      const user=await api('/auth/v1/admin/users/'+credentials.user_id);
      if(user.id!==credentials.user_id||!user.email||!user.email_confirmed_at)throw new Error('upstream_error');
      const link=await api('/auth/v1/admin/generate_link',{method:'POST',body:{type:'magiclink',email:user.email}});
      // Generating and consuming the one-use link here sends no email and changes no password.
      const next=await api('/auth/v1/verify',{method:'POST',body:{type:'email',token_hash:link.hashed_token}});
      if(next.user?.id!==credentials.user_id)throw new Error('upstream_error');
      const session=Object.fromEntries(['access_token','refresh_token','expires_in','expires_at','token_type'].filter(k=>next[k]!==undefined).map(k=>[k,next[k]]));
      return reply(200,{session});
    }
    if(input.action==='viewer-login') {
      const login=String(input.id||'').toLowerCase(),password=String(input.password||'');
      if(!/^[a-z0-9_-]{4,40}$/.test(login)||password.length<1||password.length>128)return reply(401,{error:'IDまたはPWを確認してください。'});
      const games=await api('/rest/v1/logger_games?select=id,viewer_email&active=eq.true&viewer_login=eq.'+encodeURIComponent(login));
      // Unknown IDs still perform an Auth request; all failures have the same response.
      let session;try{session=await api('/auth/v1/token?grant_type=password',{method:'POST',body:{email:games[0]?.viewer_email||'missing@logger.invalid',password}});}catch{return reply(401,{error:'IDまたはPWを確認してください。'});}
      if(!games[0])return reply(401,{error:'IDまたはPWを確認してください。'});
      return reply(200,{session,gameId:games[0].id});
    }
    const token=request.headers.get('authorization')?.replace(/^Bearer /i,'');
    if(!token)return reply(401,{error:'管理者としてログインしてください。'});
    let user;try{user=await api('/auth/v1/user',{token});}catch{return reply(401,{error:'管理者としてログインしてください。'});}
    if(!user?.id)return reply(401,{error:'管理者としてログインしてください。'});
    const admins=await api('/rest/v1/logger_admins?select=user_id&user_id=eq.'+encodeURIComponent(user.id));
    if(!admins.length)return reply(403,{error:'管理権限がありません。'});
    const existing=(await api('/rest/v1/logger_games?select=id,active,writer_id,writer_revision,viewer_login,viewer_user_id&owner_id=eq.'+encodeURIComponent(user.id)))[0]||null;
    if(input.action==='status')return reply(200,{game:existing,ownerId:user.id});
    if(input.action==='stop') {
      await api('/rest/v1/rpc/logger_stop',{method:'POST',body:{p_owner:user.id}});
      if(existing?.viewer_user_id)try{await api('/auth/v1/admin/users/'+existing.viewer_user_id,{method:'DELETE'});}catch{/* A detached account has no data access. */}
      return reply(200,{stopped:true});
    }
    if(input.action!=='configure')return reply(400,{error:'操作が不正です。'});
    const login=String(input.id||'').toLowerCase(),password=String(input.password||''),writer=String(input.writerId||'');
    if(!/^[a-z0-9_-]{4,40}$/.test(login)||password.length<12||password.length>128||! /^[0-9a-f-]{36}$/i.test(writer))return reply(400,{error:'IDは半角英数字等4〜40文字、PWは12〜128文字で設定してください。'});
    const email='viewer-'+crypto.randomUUID()+'@logger.invalid';
    const viewer=await api('/auth/v1/admin/users',{method:'POST',body:{email,password,email_confirm:true}});createdUser=viewer.id;
    const game=await api('/rest/v1/rpc/logger_configure',{method:'POST',body:{p_owner:user.id,p_writer:writer,p_login:login,p_viewer:viewer.id,p_email:email,p_takeover:input.takeover===true}});
    createdUser=null;
    if(existing?.viewer_user_id)try{await api('/auth/v1/admin/users/'+existing.viewer_user_id,{method:'DELETE'});}catch{/* Old JWTs no longer match database membership. */}
    return reply(200,{game,ownerId:user.id});
  } catch(error) {
    if(createdUser)try{
      // A timed-out configure may already have committed. Never delete its current user.
      const current=await api('/rest/v1/logger_games?select=id&viewer_user_id=eq.'+createdUser);
      if(!current.length)await api('/auth/v1/admin/users/'+createdUser,{method:'DELETE'});
    }catch{/* Preserve a possibly active account when the outcome is unknown. */}
    return reply(error.message==='writer_conflict'?409:503,{error:error.message==='writer_conflict'?'別の記録端末が設定されています。端末を切り替える場合は確認欄を選んでください。':'共有先に接続できませんでした。現在の設定は変更された可能性があるため、状態を再確認してください。'});
  }
}
