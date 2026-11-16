import {
  MIN_PLAYERS, MAX_PLAYERS, ANSWER_SECONDS, roomCode, cleanName, createRoom,
  addPlayer, removePlayer, setConnected, getPlayer, startGame, submitAnswer,
  finishWriting, expireWriting, revealFish, bankPoints, skipRound, nextRound,
  resetGame, snapshot
} from './engine.mjs';
import { QUESTIONS } from './questions.mjs';

const root = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const SESSION_KEY = 'pescao-session-v1';
const HOST_STATE_PREFIX = 'pescao-room-v1-';
const NAME_KEY = 'pescao-last-name-v1';
const PREFIX = 'pescao-sala-';
const PEER_OPTIONS = {host:'0.peerjs.com',port:443,secure:true,path:'/',debug:1};
const FISHES = ['🐠','🐡','🐟','🦈','🐬','🪼','🦀','🦑','🐙','🦞'];
const UI = {
  mode:'home', code:'', token:'', name:'', host:false, peer:null, conn:null,
  conns:new Map(), state:null, view:null, online:false, draft:'',
  reconnecting:false, wakeLock:null, lastError:'', loading:false, connectAttemptAt:0,
  lastRevealKey:null, inviteFromUrl:new URLSearchParams(location.search).get('sala')||''
};
let toastTimer = null;
const safe = value => String(value??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const playerName = (view,id) => view.players.find(p=>p.id===id)?.name || 'Jugador';
const localGet = (key) => {try{return JSON.parse(localStorage.getItem(key));}catch{return null;}};
const localSet = (key,val) => {try{localStorage.setItem(key,JSON.stringify(val));}catch{}};
const localRemove = (key) => {try{localStorage.removeItem(key);}catch{}};
const stored = () => localGet(SESSION_KEY);
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>toastEl.classList.remove('show'),3400);
}
function sessionSave() {
  localSet(SESSION_KEY,{host:UI.host,code:UI.code,token:UI.token,name:UI.name,at:Date.now()});
  localSet(NAME_KEY,UI.name);
}
function saveHost() {
  if(UI.host && UI.state) localSet(HOST_STATE_PREFIX+UI.code, UI.state);
}
function inviteLink() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('sala',UI.code);
  return url.toString();
}
function updateUrl() {
  const url = new URL(location.href);
  url.searchParams.set('sala',UI.code);
  history.replaceState({},'',url.pathname+url.search);
}
function wakeHost() {
  if(!UI.host || !navigator.wakeLock?.request || document.visibilityState!=='visible') return;
  navigator.wakeLock.request('screen').then(lock=>{UI.wakeLock=lock;}).catch(()=>{});
}
async function ensurePeerLibrary(){
  if(window.Peer) return;
  await new Promise((resolve,reject)=>{
    const tag=document.createElement('script');
    tag.src='https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js';
    tag.onload=resolve;tag.onerror=reject;
    document.head.appendChild(tag);
  });
  if(!window.Peer) throw new Error('No pudo cargarse el servicio de conexión. Revisa tu internet.');
}
function closePeer(){
  try{UI.conn?.close();}catch{}
  for(const c of UI.conns.values()) try{c.close();}catch{}
  UI.conns.clear();
  try{UI.peer?.destroy();}catch{}
  UI.peer=null;UI.conn=null;UI.online=false;UI.view=null;UI.state=null;
}
function sendTo(conn, payload) {try{if(conn?.open) conn.send(payload);}catch{}}
function publish() {
  if(!UI.host || !UI.state) return;
  UI.view=snapshot(UI.state,UI.token);
  for(const [token,conn] of UI.conns) sendTo(conn,{type:'snapshot',state:snapshot(UI.state,token)});
  saveHost();
  render();
}
function errorText(e){return e?.message || String(e);}
function hostAction(action, token, payload={}){
  try {
    switch(action){
      case 'start': if(token!==UI.state.hostToken) throw Error('Sólo el anfitrión puede empezar.'); startGame(UI.state,QUESTIONS);break;
      case 'submit': submitAnswer(UI.state,token,payload.text);break;
      case 'reveal': {
        const player=UI.state.players.find(p=>p.tag===payload.target);
        if(!player) throw Error('Jugador no encontrado.');
        revealFish(UI.state,token,player.id);break;
      }
      case 'bank': bankPoints(UI.state,token);break;
      case 'force': if(token!==UI.state.hostToken) throw Error('Sólo el anfitrión puede cerrar respuestas.');finishWriting(UI.state);break;
      case 'skip': skipRound(UI.state,token);break;
      case 'next': nextRound(UI.state,token,QUESTIONS);break;
      case 'rematch':resetGame(UI.state,token);break;
      case 'leave':removePlayer(UI.state,token);const c=UI.conns.get(token);sendTo(c,{type:'departed'});UI.conns.delete(token);setTimeout(()=>{try{c?.close();}catch{}},250);break;
      case 'kick':{if(token!==UI.state.hostToken)throw Error('Sólo el anfitrión puede quitar jugadores.');const p=UI.state.players.find(p=>p.tag===payload.target);if(!p||p.id===UI.state.hostToken)throw Error('Jugador inválido.');removePlayer(UI.state,p.id);const c=UI.conns.get(p.id);sendTo(c,{type:'departed'});UI.conns.delete(p.id);setTimeout(()=>{try{c?.close();}catch{}},250);break;}
      default:throw Error('Acción desconocida.');
    }
    publish();
  }catch(e){
    if(token===UI.token)toast(errorText(e));
    else sendTo(UI.conns.get(token),{type:'error',message:errorText(e)});
  }
}
function perform(action,payload={}) {
  if(UI.host) hostAction(action,UI.token,payload);
  else if(UI.conn?.open) sendTo(UI.conn,{type:'action',action,payload});
  else toast('Conexión interrumpida. Reconectando...');
}
function newToken() {return crypto.randomUUID()+'-'+crypto.randomUUID();}
async function create(name, resume=false) {
  name=cleanName(name);
  if(name.length<2){toast('Escribe un nombre de al menos 2 caracteres.');return;}
  UI.loading=true;UI.lastError='';UI.mode='connecting';render();
  try {
    await ensurePeerLibrary();
    closePeer();
    const saved=resume?stored():null;
    UI.host=true;
    UI.token=saved?.token||newToken();
    UI.code=saved?.code||roomCode();
    UI.name=name;
    const oldState=resume?localGet(HOST_STATE_PREFIX+UI.code):null;
    UI.state=oldState&&oldState.hostToken===UI.token?oldState:createRoom(UI.code,UI.token,UI.name);
    UI.state.players.forEach(p=>p.connected=p.id===UI.token);
    UI.state.players.find(p=>p.id===UI.token).name=name;
    const peer=new window.Peer(PREFIX+UI.code.toLowerCase(),PEER_OPTIONS);
    UI.peer=peer;
    peer.on('open',()=>{
      if(UI.peer!==peer)return;
      UI.online=true;UI.mode='room';UI.loading=false;
      sessionSave();updateUrl();wakeHost();publish();
      toast(resume?'Sala recuperada. ¡Que se reconecten tus amigos!':'¡Sala lista! Comparte el código.');
    });
    peer.on('connection',conn=>attachHostConnection(conn));
    peer.on('error',e=>{
      UI.lastError=e.type==='unavailable-id'?'Este código ya está en uso. Crea otra sala.':`Error de conexión: ${errorText(e)}`;
      UI.loading=false;UI.online=false;render();toast(UI.lastError);
    });
    peer.on('disconnected',()=>{
      UI.online=false;render();try{peer.reconnect();}catch{}
    });
  }catch(e){UI.lastError=errorText(e);UI.mode='home';UI.loading=false;render();toast(UI.lastError);}
}
function attachHostConnection(conn){
  let token=null;
  conn.on('data',msg=>{
    if(!msg||typeof msg!=='object')return;
    if(!token){
      if(msg.type!=='join') {sendTo(conn,{type:'error',message:'Identificación requerida.'});return;}
      try{
        if(typeof msg.token!=='string'||msg.token.length>120)throw Error('Sesión inválida.');
        const p=addPlayer(UI.state,msg.token,msg.name);
        token=p.id;
        const previous=UI.conns.get(token);
        if(previous&&previous!==conn)try{previous.close();}catch{}
        UI.conns.set(token,conn);
        publish();
        toast(`${p.name} ${UI.state.status==='lobby'?'se unió':'se reconectó'}`);
      }catch(e){sendTo(conn,{type:'error',message:errorText(e)});setTimeout(()=>conn.close(),500);}
      return;
    }
    if(msg.type==='action'&&typeof msg.action==='string')hostAction(msg.action,token,msg.payload||{});
  });
  conn.on('close',()=>{
    if(token&&UI.conns.get(token)===conn){
      UI.conns.delete(token);setConnected(UI.state,token,false);publish();
    }
  });
  conn.on('error',()=>{
    if(token&&UI.conns.get(token)===conn){UI.conns.delete(token);setConnected(UI.state,token,false);publish();}
  });
}
async function join(code, name, resume=false){
  code=String(code||'').replace(/\s/g,'').toUpperCase();
  name=cleanName(name);
  if(!/^[A-HJ-NP-Z2-9]{6}$/.test(code)){toast('El código debe tener 6 letras o números.');return;}
  if(name.length<2){toast('Escribe un nombre de al menos 2 caracteres.');return;}
  UI.mode='connecting';UI.lastError='';UI.loading=true;render();
  try{
    await ensurePeerLibrary();closePeer();
    const previous=resume?stored():null;
    UI.host=false;UI.token=previous?.token||newToken();UI.code=code;UI.name=name;
    const peer=new window.Peer(PEER_OPTIONS);UI.peer=peer;
    peer.on('open',()=>{if(UI.peer===peer)connectToHost();});
    peer.on('error',e=>{UI.lastError=`Conexión: ${errorText(e)}`;UI.online=false;UI.loading=false;render();});
    peer.on('disconnected',()=>{UI.online=false;UI.mode='connecting';render();try{peer.reconnect();}catch{}});
    sessionSave();updateUrl();
  }catch(e){UI.mode='home';UI.loading=false;render();toast(errorText(e));}
}
function connectToHost(){
  if(UI.host||!UI.peer||UI.peer.destroyed||UI.peer.disconnected||UI.conn?.open)return;
  if(UI.conn && Date.now()-UI.connectAttemptAt<10000)return;
  if(UI.conn)try{UI.conn.close();}catch{}
  const peer=UI.peer;
  try{
    const conn=peer.connect(PREFIX+UI.code.toLowerCase(),{reliable:true,serialization:'json'});
    UI.conn=conn;UI.connectAttemptAt=Date.now();
    conn.on('open',()=>{
      if(UI.conn!==conn)return;
      sendTo(conn,{type:'join',token:UI.token,name:UI.name});
      UI.lastError='';UI.online=true;UI.loading=false;render();
    });
    conn.on('data',msg=>{
      if(UI.conn!==conn||!msg||typeof msg!=='object')return;
      if(msg.type==='snapshot'&&msg.state){
        UI.view=msg.state;UI.online=true;UI.mode='room';UI.loading=false;
        if(UI.view.round?.mySubmitted)UI.draft='';
        render();
      }else if(msg.type==='error'){
        UI.lastError=String(msg.message||'Error de conexión.');toast(UI.lastError);
      }else if(msg.type==='departed'){
        leaveLocal();toast('Saliste de la sala.');
      }
    });
    conn.on('close',()=>{
      if(UI.conn===conn){UI.online=false;UI.mode='connecting';UI.conn=null;render();}
    });
    conn.on('error',()=>{
      if(UI.conn===conn){UI.online=false;UI.mode='connecting';UI.conn=null;render();}
    });
  }catch(e){UI.lastError=errorText(e);render();}
}
function leaveLocal(){
  closePeer();UI.mode='home';UI.code='';UI.token='';UI.host=false;UI.loading=false;
  UI.lastError='';UI.draft='';localRemove(SESSION_KEY);
  const url=new URL(location.href);url.searchParams.delete('sala');history.replaceState({},'',url.pathname+url.search);
  render();
}
function resume(){
  const saved=stored();
  if(!saved?.code||!saved?.token)return;
  if(saved.host)create(saved.name,true);
  else join(saved.code,saved.name,true);
}
async function copyText(text){
  try{await navigator.clipboard.writeText(text);toast('¡Copiado! Envíalo a tus amigos.');}
  catch{toast('Copia este enlace: '+text);}
}
async function shareInvite(){
  const data={title:'¡Juguemos Pescao Online!',text:`Entra a mi sala ${UI.code} 🐟`,url:inviteLink()};
  if(navigator.share){try{await navigator.share(data);}catch(e){if(e.name!=='AbortError')copyText(data.url);}}
  else copyText(data.url);
}
function header(online=false){
  return `<header class="topbar"><div class="brand"><div class="brand-mark"><span>🐟</span></div><span>PESCAO<span class="accent">.</span> ONLINE</span></div><div class="top-label ${online?'live':''}">${online?'CONECTADOS':'JUEGO EN VIVO'}</div></header>`;
}
function footer(){return `<footer class="footer"><span>Una versión independiente con preguntas originales. No oficial.</span><span>4–10 personas · Gratis · Sin descargar app</span></footer>`;}
function homeHtml(){
  const saved=stored();
  const prevName=safe(localGet(NAME_KEY)||saved?.name||'');
  const invite=String(UI.inviteFromUrl||'').replace(/[^A-Za-z0-9]/g,'').toUpperCase().slice(0,6);
  return `${header()}
    <main>
      <section class="hero">
        <div class="hero-copy">
          <div class="eyebrow">✦ EL JUEGO DE LAS MENTIRAS</div>
          <h1>Algo aquí <em>huele raro.</em></h1>
          <p>Una respuesta es real. Las demás son puro cuento. ¿Podrás pescar a los mentirosos sin caer en la trampa?</p>
          <div class="stat-strip"><span class="mini-stat">👥 <b>4–10</b> jugadores</span><span class="mini-stat">📱 Desde tu celular</span><span class="mini-stat">⚡ En tiempo real</span></div>
          <div class="illustration" aria-hidden="true"><div class="illus-fish one">🐠</div><div class="illus-fish two">🐡</div><div class="illus-fish three">🐟</div></div>
        </div>
        <div class="panel entry-panel">
          <div class="eyebrow">🐬 A JUGAR</div>
          <h2 class="panel-title">¿Listos para pescar?</h2>
          <p class="subtle">Cada persona entra desde su teléfono. Sin cuentas ni descargas.</p>
          <label class="field" for="player-name">Tu nombre</label>
          <input class="text-input" id="player-name" maxlength="22" value="${prevName}" placeholder="Ej. Alex" autocomplete="nickname">
          <button class="btn btn-primary btn-wide" data-action="create" style="margin-top:14px">✨ Crear una sala</button>
          <div class="divider-word">O ÚNETE A TUS AMIGOS</div>
          <label class="field" for="room-input" style="margin-top:0">Código de sala</label>
          <input class="text-input code" id="room-input" value="${safe(invite)}" maxlength="6" placeholder="ABC123" autocomplete="off" autocapitalize="characters" spellcheck="false">
          <button class="btn btn-coral btn-wide" data-action="join" style="margin-top:12px">🐟 Entrar a la sala</button>
          ${saved?.token ? `<button class="line-link" data-action="resume">↩ Reanudar sala ${safe(saved.code)} como ${safe(saved.name)}</button>` : ''}
          ${UI.lastError?`<p class="warning-line">⚠️ ${safe(UI.lastError)}</p>`:''}
          <p class="tiny-note">El anfitrión mantiene la sala abierta mientras juega.</p>
        </div>
      </section>
      <section class="how-it-works"><h2 class="how-title">Tres pasos. Muchas mentiras.</h2>
      <div class="steps">
        <div class="step-card"><div class="step-n">01 /</div><b>Recibe tu pez</b><p>Uno conoce la verdad; los demás inventan respuestas. El pescador no sabe quién es quién.</p></div>
        <div class="step-card"><div class="step-n">02 /</div><b>Hazte el inocente</b><p>Escribe una respuesta convincente para confundir al pescador. Todos la verán.</p></div>
        <div class="step-card"><div class="step-n">03 /</div><b>Pesca o plántate</b><p>Descubre mentiras para ganar puntos. Si pescas la verdad, pierdes los puntos de esa ronda.</p></div>
      </div></section>
    </main>${footer()}`;
}
function connectingHtml(){
  return `${header()}<div class="game-shell"><div class="panel center" style="padding:44px 22px"><div class="fish-large">${UI.host?'🐡':'🐟'}</div><h1 class="heading">${UI.host?'Abriendo tu sala...':'Buscando a tus amigos...'}</h1><p class="game-lead">${UI.host?'Conectando con el océano.':'Conectando con la sala '+safe(UI.code)+'. El anfitrión debe tener su pantalla abierta.'}</p><div class="spinner"></div>${UI.lastError?`<div class="callout warm">⚠️ ${safe(UI.lastError)}</div>`:''}<div class="row-actions center-actions"><button class="btn btn-ghost" data-action="retry">↻ Reintentar</button><button class="btn btn-ghost" data-action="exit">Volver al inicio</button></div></div></div>`;
}
function roomHeader(view){
  const connected=view.players.filter(p=>p.connected).length;
  return `${header(UI.online)}<div class="game-shell"><div class="room-head"><div><div class="round-kicker">SALA EN VIVO</div><div style="font-size:.86rem;color:#bcd6d9;margin-top:5px">${connected} / ${MAX_PLAYERS} conectados ${UI.online?'· 🟢':'· 🔴 sin red'}</div></div><button class="room-code" data-action="copy-code" aria-label="Copiar código de sala"><span>📋</span><span><small>CÓDIGO</small><strong>${safe(view.code)}</strong></span></button></div>`;
}
function playersGrid(view,allowKick=false){
  return `<div class="player-grid">${view.players.map((p,i)=>`<div class="player-card"><div class="avatar v${i%5}">${FISHES[i%FISHES.length]}</div><div class="player-info"><strong>${safe(p.name)}${p.id===view.me?' (tú)':''}</strong><span>${p.id===view.host?'👑 Anfitrión':`✨ ${p.score} pts`}</span></div>${allowKick&&p.id!==view.host&&!p.connected?`<button class="line-link" data-action="kick" data-target="${safe(p.id)}" title="Quitar jugador sin conexión">✕</button>`:`<span class="status-dot ${p.connected?'':'off'}" title="${p.connected?'Conectado':'Desconectado'}"></span>`}</div>`).join('')}</div>`;
}
function scoreboard(view,withDelta=false){
  const totals=view.round?.settlement||[];
  const sorted=[...view.players].sort((a,b)=>b.score-a.score || a.name.localeCompare(b.name));
  const max=sorted[0]?.score??0;
  return `<div class="score-board">${sorted.map((p,i)=>{
    const delta=totals.find(t=>t.id===p.id)?.delta;
    return `<div class="score-row ${view.status==='finished'&&p.score===max?'winner':''}"><span class="rank">${i===0?'🥇':String(i+1).padStart(2,'0')}</span><span class="score-name">${safe(p.name)}${p.id===view.me?' · tú':''}</span>${withDelta&&delta>0?`<span class="score-delta">+${delta}</span>`:''}<span class="score-num">${p.score} <small>pts</small></span></div>`;
  }).join('')}</div>`;
}
function lobbyHtml(view){
  const isHost=view.me===view.host;
  const everyoneOnline=view.players.every(p=>p.connected);
  const canStart=view.players.length>=MIN_PLAYERS&&everyoneOnline&&UI.online;
  return `${roomHeader(view)}<section class="panel"><div class="round-kicker">LA TRIPULACIÓN</div><h1 class="heading">Juntando a los <span class="accent">sospechosos.</span></h1><p class="game-lead">Comparte el código o el enlace. Cada amigo entra desde su teléfono y elige un nombre.</p><div class="pills"><span class="pill"><span class="dot"></span>${view.players.length} de ${MAX_PLAYERS} peces</span><span class="pill">Mínimo ${MIN_PLAYERS} para empezar</span></div>
  ${playersGrid(view,isHost)}<div class="callout"><b>📲 Invita a tus amigos</b>Comparte el enlace directo y se llenará el código automáticamente.</div>
  <div class="row-actions"><button class="btn btn-cream" data-action="share">↗ Compartir invitación</button><button class="btn btn-ghost" data-action="copy-link">Copiar enlace</button></div>
  ${isHost?`<button class="btn btn-coral btn-wide" data-action="start" ${canStart?'':'disabled'} style="margin-top:15px">🎣 ${view.players.length<MIN_PLAYERS?`Faltan ${MIN_PLAYERS-view.players.length} jugadores`:!everyoneOnline?'Esperando reconexiones':'¡Empezar partida!'}</button><p class="tiny-note center">Como anfitrión, mantén la página abierta durante toda la partida.</p>`:`<div class="callout warm"><b>⏳ Esperando al anfitrión</b>La partida comenzará cuando todos estén listos.</div>`}
  ${isHost?'':`<button class="line-link" data-action="exit">Salir de esta sala</button>`}
  </section>${footer()}</div>`;
}
function timerHtml(deadline){
  const remaining=Math.max(0,Math.ceil((deadline-Date.now())/1000));
  const width=Math.max(0,Math.min(100,remaining/ANSWER_SECONDS*100));
  return `<div class="timer"><span>⏳</span><div class="timer-track"><span id="timer-fill" style="width:${width}%"></span></div><strong id="timer-seconds">${remaining}s</strong></div>`;
}
function roleHtml(view){
  const r=view.round;
  if(r.mine==='guesser')return `<div class="role-card fisher"><div class="role-icon">🎣</div><div><h3>¡Eres el pescador!</h3><p>No sabes la respuesta. Observa las mentiras y elige con cuidado.</p></div></div>`;
  if(r.mine==='blue')return `<div class="role-card blue"><div class="role-icon">🐟</div><div><h3>¡Eres el pez azul!</h3><p>Conoces la verdad. Tu misión es hacerla sonar sospechosa.</p></div></div>`;
  return `<div class="role-card red"><div class="role-icon">🐠</div><div><h3>¡Eres un pez rojo!</h3><p>Inventa una mentira ingeniosa para que parezca la respuesta correcta.</p></div></div>`;
}
function writingHtml(view){
  const r=view.round;
  const fisher=playerName(view,r.guesser);
  const expected=view.players.length-1;
  const ready=r.submittedIds.length;
  return `${roomHeader(view)}<section class="panel"><div class="round-kicker">RONDA ${r.number} DE ${view.totalTurns} · PREPARANDO RESPUESTAS</div><h1 class="heading">Hora de <span class="accent">inventar.</span></h1>
  <div class="pills"><span class="pill">🎣 Pescador: ${safe(fisher)}</span><span class="pill">✍️ ${ready}/${expected} respuestas</span></div>
  <div class="question-card"><span class="tag">PREGUNTA DE LA RONDA</span><h2>${safe(r.question)}</h2></div>
  ${roleHtml(view)}
  ${r.mine==='guesser'?`<div class="callout warm"><b>🤫 Prohibido mirar respuestas todavía</b>Los demás están preparando sus respuestas. En un momento te tocará pescar.</div>${timerHtml(r.deadline)}`:
    r.mine==='blue'?`<div class="truth-box"><span class="label">TU RESPUESTA VERDADERA · SOLO TÚ LA VES</span><b>${safe(r.myTruth||'')}</b></div><p class="subtle">Ya está enviada automáticamente. Piensa cómo defender esta verdad sin parecer confiable.</p>${timerHtml(r.deadline)}`:
    r.mySubmitted?`<div class="callout"><b>✅ Mentira enviada</b>Ya está. ¡Cruza las aletas y espera a los demás!</div>${timerHtml(r.deadline)}`:
    `<label class="field" for="answer-field">Tu respuesta falsa</label><textarea id="answer-field" class="answer-input" maxlength="130" placeholder="Una mentira que suene increíblemente real...">${safe(UI.draft)}</textarea><div class="tiny-note">No pongas la verdad; ¡se trata de despistar!</div><button class="btn btn-coral btn-wide" data-action="send-answer" style="margin:14px 0 0">🐠 Enviar mi mentira</button>${timerHtml(r.deadline)}`
  }
  ${view.me===view.host?`<button class="line-link" data-action="force" style="margin-top:12px">Cerrar respuestas antes de tiempo</button>`:''}
  <p class="desktop-hint">Si cambias de app, vuelve aquí para no perder la conexión.</p></section>${footer()}</div>`;
}
function answerOptions(view, interactive=false){
  const r=view.round;
  return `<div class="fish-grid">${r.answers.map((a,i)=>{
    const p=view.players.find(p=>p.id===a.id);
    const flipped=a.flipped;
    const kind=a.role==='blue'?'blue-fish':a.role==='red'?'red-fish':'';
    return `<button class="fish-option ${flipped?'flipped':''} ${kind}" ${interactive&&!flipped?'data-action="reveal" data-target="'+safe(a.id)+'"':'disabled'}><div class="option-top"><span>🐟 ${safe(p?.name||'Pez desconocido')}</span><span class="option-emoji">${flipped?(a.role==='blue'?'🔵':'🔴'):'❔'}</span></div><div class="answer-text">${safe(a.text)}</div><small>${flipped?(a.role==='blue'?'¡ERA LA VERDAD!':'¡MENTIRA DESCUBIERTA!'):(interactive?'TOCA PARA PESCAR':'ESPERANDO AL PESCADOR')}</small><span class="stamp">🐟</span></button>`;
  }).join('')}</div>`;
}
function guessingHtml(view){
  const r=view.round;
  const isFisher=r.mine==='guesser';
  const remaining=r.answers.filter(a=>!a.flipped).length;
  return `${roomHeader(view)}<section class="panel"><div class="round-kicker">RONDA ${r.number} DE ${view.totalTurns} · A PESCAR</div><h1 class="heading">¿Cuál <span class="accent">huele a mentira?</span></h1>
  <div class="pills"><span class="pill">🎣 ${safe(playerName(view,r.guesser))}</span><span class="pill">🔴 ${r.caught} mentiras descubiertas</span><span class="pill">🐟 ${remaining} peces en el agua</span></div>
  <div class="question-card"><span class="tag">LA PREGUNTA</span><h2>${safe(r.question)}</h2></div>
  ${isFisher?`<div class="callout"><b>¡Es tu turno de pescar!</b>Toca al jugador que crees que mintió. Cada rojo suma 1 punto; puedes plantarte. Si atrapas el azul, pierdes tus puntos de esta ronda.</div>`:
    `<div class="callout warm"><b>🎭 Espera y observa</b>${safe(playerName(view,r.guesser))} está eligiendo a los mentirosos. ¡Ojalá se equivoque contigo!</div>`}
  ${answerOptions(view,isFisher)}
  ${isFisher?`<button class="btn btn-primary btn-wide" data-action="bank">🪙 Plantarme y guardar ${r.caught} ${r.caught===1?'punto':'puntos'}</button>`:''}
  ${view.me===view.host?`<button class="line-link" data-action="skip">Saltar esta ronda (sin puntos)</button>`:''}
  </section>${footer()}</div>`;
}
function resultHtml(view){
  const r=view.round;
  const guesser=playerName(view,r.guesser);
  const outcome=r.outcome;
  const config=outcome==='caught'?{icon:'💦',title:'¡Se fue al agua!',text:`${guesser} pescó la verdad y perdió los puntos de esta ronda.`}:
    outcome==='sweep'?{icon:'🏆',title:'¡Pesca perfecta!',text:`${guesser} encontró todas las mentiras y ganó el punto extra.`}:
    outcome==='bank'?{icon:'🪙',title:'¡Puntos asegurados!',text:`${guesser} decidió plantarse antes de encontrar al pez azul.`}:
    {icon:'⏭️',title:'Ronda saltada',text:'Esta ronda no repartió puntos.'};
  return `${roomHeader(view)}<section class="panel"><div class="round-kicker">RONDA ${r.number} DE ${view.totalTurns} · RESULTADOS</div>
  <div class="result-hero"><div class="result-emoji">${config.icon}</div><h2>${config.title}</h2><p>${safe(config.text)}</p><div class="earned">🎣 ${safe(guesser)}: +${r.roundPoints} pts</div></div>
  <div class="revealed-truth"><span>🔵 ESTA ERA LA RESPUESTA VERDADERA</span><strong>${safe(r.truth)}</strong></div>
  <h3 class="how-title" style="margin-top:22px">Las cartas sobre la mesa</h3>
  ${answerOptions(view,false)}
  <h3 class="how-title">Así va el marcador</h3>${scoreboard(view,true)}
  ${view.me===view.host?`<button class="btn btn-coral btn-wide" data-action="next">${r.number===view.totalTurns?'🏁 Ver ganadores':'🎣 Siguiente ronda'}</button>`:`<div class="callout"><b>⏳ El anfitrión avanza</b>Prepárate, ¡la próxima ronda viene en camino!</div>`}
  </section>${footer()}</div>`;
}
function finishedHtml(view){
  const ranking=[...view.players].sort((a,b)=>b.score-a.score);
  const top=ranking.filter(p=>p.score===ranking[0].score).map(p=>p.name).join(' y ');
  return `${roomHeader(view)}<section class="panel"><div class="result-hero"><div class="result-emoji">🏆🐟</div><div class="round-kicker">¡PARTIDA TERMINADA!</div><h1 class="heading" style="margin-top:12px">¡Qué buena <span class="accent">pesca!</span></h1><p>El océano tiene ${ranking.filter(p=>p.score===ranking[0].score).length>1?'ganadores':'un ganador'}...</p><h2 style="color:var(--yellow);margin:12px 0 3px">${safe(top)}</h2><p>${ranking[0].score} puntos</p></div>
  <h3 class="how-title">Clasificación final</h3>${scoreboard(view)}
  ${view.me===view.host?`<button class="btn btn-coral btn-wide" data-action="rematch">🔁 Jugar otra partida</button>`:`<div class="callout"><b>¿Revancha?</b>El anfitrión puede iniciar otra partida con la misma sala.</div>`}
  <button class="btn btn-ghost btn-wide" data-action="share" style="margin-top:12px">↗ Invitar a otra partida</button>
  </section>${footer()}</div>`;
}
function render(){
  if(UI.mode==='home'){root.innerHTML=homeHtml();return;}
  if(UI.mode==='connecting'||!UI.view){root.innerHTML=connectingHtml();return;}
  const v=UI.view;
  if(v.status==='lobby'){root.innerHTML=lobbyHtml(v);return;}
  if(v.status==='finished'){root.innerHTML=finishedHtml(v);return;}
  if(v.round?.phase==='writing'){root.innerHTML=writingHtml(v);return;}
  if(v.round?.phase==='guessing'){root.innerHTML=guessingHtml(v);return;}
  if(v.round?.phase==='result'){root.innerHTML=resultHtml(v);return;}
  root.innerHTML=connectingHtml();
}
root.addEventListener('input',e=>{
  if(e.target.id==='answer-field')UI.draft=e.target.value;
  if(e.target.id==='room-input')e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
});
root.addEventListener('click', async e=>{
  const btn=e.target.closest('[data-action]');if(!btn||btn.disabled)return;
  const action=btn.dataset.action;
  if(action==='create'){create(document.querySelector('#player-name')?.value);return;}
  if(action==='join'){join(document.querySelector('#room-input')?.value,document.querySelector('#player-name')?.value);return;}
  if(action==='resume'){resume();return;}
  if(action==='retry'){
    if(UI.host){create(UI.name,!UI.lastError.includes('ya está en uso'));}else if(UI.peer&&!UI.peer.destroyed){connectToHost();toast('Reintentando conexión...');}else join(UI.code,UI.name,true);
    return;
  }
  if(action==='exit'){
    if(UI.mode==='room'&&!UI.host&&UI.view?.status==='lobby'){perform('leave');setTimeout(leaveLocal,350);}else leaveLocal();return;
  }
  if(action==='copy-code'){copyText(UI.code);return;}
  if(action==='copy-link'){copyText(inviteLink());return;}
  if(action==='share'){shareInvite();return;}
  if(action==='start'){perform('start');return;}
  if(action==='kick'){perform('kick',{target:btn.dataset.target});return;}
  if(action==='send-answer'){
    if(!UI.draft.trim()){toast('Escribe tu mentira antes de enviarla.');return;}
    perform('submit',{text:UI.draft});return;
  }
  if(action==='reveal'){perform('reveal',{target:btn.dataset.target});return;}
  if(action==='bank'){perform('bank');return;}
  if(action==='force'){perform('force');return;}
  if(action==='skip'){if(confirm('¿Saltar esta ronda sin entregar puntos?'))perform('skip');return;}
  if(action==='next'){perform('next');return;}
  if(action==='rematch'){if(confirm('¿Empezar otra partida desde cero con la misma sala?'))perform('rematch');return;}
});
root.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey&&e.target.id==='player-name'){
    e.preventDefault();root.querySelector('[data-action="create"]')?.click();
  }
  if(e.key==='Enter'&&e.target.id==='room-input'){
    e.preventDefault();root.querySelector('[data-action="join"]')?.click();
  }
});
window.addEventListener('online',()=>{if(!UI.host&&UI.peer?.open)connectToHost();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){wakeHost();if(!UI.host&&UI.peer?.open&&!UI.conn?.open)connectToHost();}});
setInterval(()=>{
  if(UI.host && UI.state?.status==='playing' && expireWriting(UI.state)) publish();
  if(!UI.host && UI.mode!=='home' && UI.peer?.open && !UI.conn?.open) connectToHost();
  const left=document.querySelector('#timer-seconds');
  const bar=document.querySelector('#timer-fill');
  const deadline=UI.view?.round?.deadline;
  if(deadline&&left&&bar){
    const seconds=Math.max(0,Math.ceil((deadline-Date.now())/1000));
    left.textContent=seconds+'s';bar.style.width=Math.max(0,Math.min(100,seconds/ANSWER_SECONDS*100))+'%';
  }
},1500);
render();