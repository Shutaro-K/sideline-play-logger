'use strict';
window.LoggerSharing = (() => {
  const config=window.LOGGER_SHARING_CONFIG||{}, viewer=new URLSearchParams(location.search).get('view')==='1';
  const fields=['id','time','recordedAt','updatedAt','down','distance','strSide','sign','branch','formation','play','remark','inside','outside','coverage','q','series','ending','lookupStatus','resolvedSign','parentSign','cwmBranch','protection','lookupSourceSign'];
  const key='sideline-sharing-session',configured=Boolean(config.url&&/^sb_publishable_/.test(config.publishableKey));
  let session=null,refreshing=null,flushing=null,polling=null,socket=null,heartbeat=null,reconnect=null,lastVersion=null,needFull=false,stopped=false,publishing=null,flushAgain=false,viewerEpoch=0,lastUpdated=null;
  let onStatus=()=>{},onRows=()=>{},onLoginRequired=()=>{};
  try{session=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}
  if(session?.role!==(viewer?'viewer':'admin'))session=null;
  const remember=()=>{try{if(session)sessionStorage.setItem(key,JSON.stringify(session));else sessionStorage.removeItem(key);}catch{}};
  const cleanRows=records=>records.map(row=>Object.fromEntries(fields.filter(f=>row[f]!==undefined).map(f=>[f,row[f]])));
  function status(message,kind='ok'){onStatus(message,kind);}
  function staleStatus(label){return label+' · '+(lastUpdated?'最終'+new Date(lastUpdated).toLocaleTimeString('ja-JP',{hour12:false}):'未取得');}
  async function request(path,{method='GET',body,token,signal}={}) {
    if(!configured)throw new Error('共有先が未設定です。');
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
    const cancel=()=>controller.abort();if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
    try {
      const headers={apikey:config.publishableKey,'Content-Type':'application/json'};if(token)headers.Authorization='Bearer '+token;
      const response=await fetch(config.url+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,cache:'no-store'});
      const text=await response.text();let data;try{data=text?JSON.parse(text):null;}catch{throw new Error('共有先の応答を確認できません。');}
      if(!response.ok){const error=new Error(data?.error||data?.message||data?.msg||'共有先に接続できません。');error.status=response.status;throw error;}
      return data;
    }finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancel);}
  }
  async function accessToken(){
    if(!session)throw new Error('ログインしてください。');
    if((session.expires_at||0)>Date.now()/1000+60)return session.access_token;
    if(!refreshing)refreshing=request('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:session.refresh_token}}).then(next=>{
      session={...session,...next,expires_at:next.expires_at||Date.now()/1000+next.expires_in};remember();return session.access_token;
    }).catch(error=>{if(error.status===400||error.status===401){session=null;remember();}throw error;}).finally(()=>refreshing=null);
    return refreshing;
  }
  async function authorized(path,options={}){return request(path,{...options,token:await accessToken()});}
  async function adminAction(action,extra={}){return authorized('/functions/v1/logger-share',{method:'POST',body:{action,...extra}});}
  async function loginAdmin(id,password){
    stopped=false;
    const {session:next}=await request('/functions/v1/logger-share',{method:'POST',body:{action:'admin-login',id,password}});
    session={...next,role:'admin',expires_at:next.expires_at||Date.now()/1000+next.expires_in};
    try{const result=await adminAction('status');session.ownerId=result.ownerId;remember();return result;}catch(error){session=null;remember();throw error;}
  }
  async function loginViewer(id,password){
    const result=await request('/functions/v1/logger-share',{method:'POST',body:{action:'viewer-login',id,password}}),next=result.session;
    viewerEpoch++;session={...next,role:'viewer',gameId:result.gameId,expires_at:next.expires_at||Date.now()/1000+next.expires_in};remember();stopped=false;lastVersion=null;
    await refreshViewer(true);connect();return result;
  }
  function disconnect(){clearInterval(heartbeat);clearTimeout(reconnect);heartbeat=null;reconnect=null;if(socket){const old=socket;socket=null;old.onclose=null;old.close();}}
  async function logout(){
    viewerEpoch++;stopped=viewer;disconnect();const previous=session;session=null;remember();lastVersion=null;
    if(viewer){onRows([],null);onLoginRequired('ログインしてください。');}
    if(previous)try{await request('/auth/v1/logout',{method:'POST',token:previous.access_token});}catch{/* Local logout must still succeed offline. */}
  }
  async function configure(id,password,takeover=false){
    const local=await PlayLogStore.loadSharing(),result=await adminAction('configure',{id,password,writerId:local.writerId,takeover});
    await PlayLogStore.configureSharing({enabled:true,gameId:result.game.id,ownerId:result.ownerId,writerId:local.writerId});
    session.ownerId=result.ownerId;remember();void flush();return result;
  }
  async function stop(){
    await adminAction('stop');const local=await PlayLogStore.loadSharing();await PlayLogStore.configureSharing({...local,enabled:false});status('共有停止');
  }
  function flush(){
    if(viewer||!configured||stopped)return Promise.resolve();if(flushing)return flushing;
    flushAgain=false;flushing=(async()=>{
      for(;;){
        const {records,sharing}=await PlayLogStore.loadShareSnapshot();
        if(!sharing?.enabled){status('共有OFF');return;}
        if(!session||session.role!=='admin'||session.ownerId!==sharing.ownerId){status('未送信 · 管理者ログインが必要','warning');return;}
        if(sharing.syncedRevision>=sharing.revision){status('共有中');return;}
        status('共有へ送信中');
        publishing=new AbortController();
        await authorized('/rest/v1/rpc/logger_publish',{method:'POST',signal:publishing.signal,body:{p_game:sharing.gameId,p_writer:sharing.writerId,p_revision:sharing.revision,p_records:cleanRows(records)}});
        publishing=null;
        await PlayLogStore.ackSharing(sharing.gameId,sharing.writerId,sharing.revision);
      }
    })().catch(()=>status('未送信 · 端末内には保存済み','warning')).finally(()=>{publishing=null;flushing=null;if(flushAgain)queueMicrotask(()=>void flush());});
    return flushing;
  }
  function denied(){viewerEpoch++;lastUpdated=null;stopped=true;disconnect();session=null;remember();lastVersion=null;onRows([],null);onLoginRequired('閲覧が終了しました。ID・PWを確認してログインしてください。');}
  function refreshViewer(force=false){
    if(stopped||!session||session.role!=='viewer')return Promise.resolve();
    needFull ||= force;if(polling)return polling;const epoch=viewerEpoch,gameId=session.gameId;
    polling=(async()=>{
      do{
        const full=needFull;needFull=false;
        const metadata=await authorized('/rest/v1/logger_games?id=eq.'+encodeURIComponent(gameId)+'&select=id,version,updated_at');
        if(epoch!==viewerEpoch||stopped)return;if(!metadata.length){denied();return;}
        let current=metadata[0];
        if(full||current.version!==lastVersion){
          const rows=await authorized('/rest/v1/logger_games?id=eq.'+encodeURIComponent(gameId)+'&select=id,version,updated_at,records');
          if(epoch!==viewerEpoch||stopped)return;if(!rows.length){denied();return;}current=rows[0];
          if(!Array.isArray(current.records))throw new Error('共有データの形式を確認できません。');
          if(lastVersion===null||current.version>=lastVersion){lastVersion=current.version;lastUpdated=current.updated_at;onRows(cleanRows(current.records),current);}
        }
        status('更新 '+new Date(current.updated_at).toLocaleTimeString('ja-JP',{hour12:false}));
      }while(needFull&&!stopped);
    })().catch(error=>{if(epoch!==viewerEpoch||stopped)return;if(error.status===401||!session)denied();else status(staleStatus('接続失敗'),'warning');}).finally(()=>polling=null);
    return polling;
  }
  async function connect(){
    if(stopped||!viewer||!session)return;disconnect();
    try{
      const token=await accessToken();if(stopped||!session)return;
      const url=new URL(config.url);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname='/realtime/v1/websocket';url.search='apikey='+encodeURIComponent(config.publishableKey)+'&vsn=1.0.0';
      const ws=new WebSocket(url),topic='realtime:logger:'+session.gameId;socket=ws;let ref=1,joined=false;
      const send=(event,payload,channel=topic)=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({topic:channel,event,payload,ref:String(ref++),join_ref:channel===topic?'1':null}));};
      ws.onopen=()=>{send('phx_join',{config:{private:true,broadcast:{ack:false,self:false},presence:{enabled:false}},access_token:token});heartbeat=setInterval(async()=>{try{send('heartbeat',{},'phoenix');send('access_token',{access_token:await accessToken()});}catch{ws.close();}},25000);};
      ws.onmessage=e=>{try{const message=JSON.parse(e.data);if(message.topic!==topic)return;if(message.event==='phx_reply'&&message.ref==='1'){joined=message.payload.status==='ok';if(joined)void refreshViewer(true);else ws.close();}if(joined&&message.event==='broadcast'&&message.payload.event==='changed')void refreshViewer(true);}catch{/* Ignore unrelated or malformed frames. */}};
      ws.onerror=()=>ws.close();ws.onclose=()=>{if(socket!==ws)return;socket=null;clearInterval(heartbeat);status(staleStatus('再接続中'),'warning');if(!stopped)reconnect=setTimeout(connect,3000);};
    }catch{if(!stopped)reconnect=setTimeout(connect,5000);}
  }
  function init(callbacks){
    ({onStatus,onRows,onLoginRequired}=callbacks);stopped=false;
    if(!configured){status('共有先未設定');if(viewer)onLoginRequired('共有先が未設定です。');return;}
    if(viewer){if(session){void refreshViewer(true);void connect();}else onLoginRequired('試合の閲覧ID・PWを入力してください。');}
    else void flush();
    setInterval(()=>viewer?refreshViewer():flush(),5000);
    window.addEventListener('online',()=>{if(viewer){void refreshViewer(true);void connect();}else void flush();});
    window.addEventListener('offline',()=>status(viewer?staleStatus('オフライン'):'未送信 · 端末内には保存済み','warning'));
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(viewer){void refreshViewer(true);void connect();}else void flush();}});
    if(!viewer)window.addEventListener('playlogchange',()=>{flushAgain=true;publishing?.abort();void flush();});
  }
  return {viewer,configured,init,loginAdmin,loginViewer,configure,stop,logout,flush,adminStatus:()=>adminAction('status'),loggedIn:()=>Boolean(session),cleanRows};
})();
