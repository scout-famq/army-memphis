import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const profilesFile = path.join(dataDir, 'profiles.json');
const applicationsFile = path.join(dataDir, 'applications.json');
const port = Number(process.env.PORT || 3000);
const secret = process.env.SESSION_SECRET;
const required = ['DISCORD_CLIENT_ID','DISCORD_CLIENT_SECRET','DISCORD_REDIRECT_URI','DISCORD_WEBHOOK_URL','SESSION_SECRET'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) console.warn(`Missing environment settings: ${missing.join(', ')}`);
const cookieSecure = process.env.COOKIE_SECURE !== 'false';
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
const b64 = x => Buffer.from(x).toString('base64url');
const sign = value => crypto.createHmac('sha256', secret || 'local-development-key').update(value).digest('base64url');
const safeEqual = (a,b) => {const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y)};
function cookie(req,name){const item=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));return item?decodeURIComponent(item.slice(name.length+1)):''}
function setCookie(res,name,value,maxAge){res.setHeader('Set-Cookie',`${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${cookieSecure?'; Secure':''}`)}
function session(req){const token=cookie(req,'sang_session').split('.');if(token.length!==2||!secret)return null;const [body,sig]=token;if(!safeEqual(sig,sign(body)))return null;try{const data=JSON.parse(Buffer.from(body,'base64url'));if(data.exp<Date.now())return null;return data.user}catch{return null}}
function json(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj))}
function readBody(req){return new Promise((resolve,reject)=>{let data='',size=0;req.on('data',chunk=>{size+=chunk.length;if(size>20000){reject(new Error('too large'));req.destroy()}else data+=chunk});req.on('end',()=>{try{resolve(JSON.parse(data||'{}'))}catch{reject(new Error('invalid json'))}});req.on('error',reject)})}
function readStore(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return {}}}
function writeStore(file,value){fs.mkdirSync(dataDir,{recursive:true});const temp=`${file}.${crypto.randomBytes(5).toString('hex')}.tmp`;fs.writeFileSync(temp,JSON.stringify(value,null,2));fs.renameSync(temp,file)}
const units=['HS','A','MP','MA','SEAL','SOG','DIV','MMS','DF','USAF','AF','CG','MCE'];
let leadershipCache={at:0,data:null};
const onlineHighStaff=new Map();
const discordPresenceState={configured:false,connected:false,guildReady:false,error:''};
const highStaffMembers=new Map();
const guildPresences=new Map();
const guildMemberProfiles=new Map();
let presenceSocket=null,presenceHeartbeat=null,presenceReconnect=null,presenceSequence=null,presenceRetry=0;
const GATEWAY_INTENTS=1|2|256;
async function getLeadership(){
 const {DISCORD_GUILD_ID:guildId,DISCORD_BOT_TOKEN:botToken,GENERAL_ROLE_ID:generalRole,DEPUTY_ROLE_ID:deputyRole}=process.env;
 if(!guildId||!botToken||!generalRole||!deputyRole)return {configured:false,general:null,deputies:[]};
 if(leadershipCache.data&&Date.now()-leadershipCache.at<60000)return leadershipCache.data;
 const response=await fetch(`https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`,{headers:{Authorization:`Bot ${botToken}`}});if(!response.ok)throw Error(`Discord member lookup failed: ${response.status}`);
 const members=await response.json();const toPerson=member=>({id:member.user.id,name:member.nick||member.user.global_name||member.user.username,username:member.user.username,avatar:member.user.avatar?`https://cdn.discordapp.com/avatars/${member.user.id}/${member.user.avatar}.png`:null});
 const general=members.find(member=>member.roles.includes(generalRole));const deputies=members.filter(member=>member.roles.includes(deputyRole)).map(toPerson);
 leadershipCache={at:Date.now(),data:{configured:true,general:general?toPerson(general):null,deputies}};return leadershipCache.data;
}
async function isHighStaff(userId){
 if(!process.env.DISCORD_GUILD_ID||!process.env.DISCORD_BOT_TOKEN||!process.env.HIGH_STAFF_ROLE_ID)return false;
 try{const response=await fetch(`https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members/${userId}`,{headers:{Authorization:`Bot ${process.env.DISCORD_BOT_TOKEN}`}});if(!response.ok)return false;const member=await response.json();return member.roles.includes(process.env.HIGH_STAFF_ROLE_ID)}catch{return false}
}
function updateHighStaffPresence(presence){
 if(presence.guild_id&&presence.guild_id!==process.env.DISCORD_GUILD_ID)return;
 const user=presence.user;if(!user?.id)return;
 guildPresences.set(user.id,presence);publishHighStaffPresence(user.id);
}
function publishHighStaffPresence(userId){
 const presence=guildPresences.get(userId),isMember=highStaffMembers.get(userId)===true;
 if(!presence||!isMember||!['online','idle','dnd'].includes(presence.status)){onlineHighStaff.delete(userId);return}
 const user={...(presence.user||{}),...(guildMemberProfiles.get(userId)||{})};
 onlineHighStaff.set(userId,{id:userId,name:user.nick||user.global_name||user.username||'Discord участник',username:user.username||'',avatar:user.avatar?`https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.png`:null,status:presence.status});
}
function startDiscordPresence(){
 const {DISCORD_BOT_TOKEN:token,DISCORD_GUILD_ID:guildId,HIGH_STAFF_ROLE_ID:roleId}=process.env;
 discordPresenceState.configured=!!(token&&guildId&&roleId);
 if(!discordPresenceState.configured)return;
 async function connect(){
  if(typeof WebSocket==='undefined'){discordPresenceState.error='Node.js 22 or newer is required for Discord presence';return}
  try{
   const gatewayResponse=await fetch('https://discord.com/api/v10/gateway/bot',{headers:{Authorization:`Bot ${token}`}});if(!gatewayResponse.ok)throw Error(`Discord gateway lookup failed: ${gatewayResponse.status}`);
   const gateway=await gatewayResponse.json();const gatewayUrl=new URL(gateway.url);gatewayUrl.searchParams.set('v','10');gatewayUrl.searchParams.set('encoding','json');
   const socket=new WebSocket(gatewayUrl.href);presenceSocket=socket;
   let heartbeatAck=true;
   socket.addEventListener('message',async event=>{
    try{
     const raw=typeof event.data==='string'?event.data:await event.data.text();const packet=JSON.parse(raw);if(packet.s!==null&&packet.s!==undefined)presenceSequence=packet.s;
     if(packet.op===10){const interval=packet.d.heartbeat_interval;presenceHeartbeat=setInterval(()=>{if(!heartbeatAck){socket.close();return}heartbeatAck=false;socket.send(JSON.stringify({op:1,d:presenceSequence}))},interval);socket.send(JSON.stringify({op:2,d:{token,intents:GATEWAY_INTENTS,properties:{os:process.platform,browser:'sang-reporting',device:'sang-reporting'}}}))}
     else if(packet.op===11)heartbeatAck=true;
     else if(packet.op===1)socket.send(JSON.stringify({op:1,d:presenceSequence}));
     else if(packet.op===7){socket.close();}
     else if(packet.op===9){socket.close();}
     else if(packet.op===0){
      const eventName=packet.t,data=packet.d;
      if(eventName==='READY'){discordPresenceState.connected=true;presenceRetry=0}
      if(eventName==='GUILD_CREATE'&&data.id===guildId){discordPresenceState.connected=true;discordPresenceState.guildReady=true;for(const member of data.members||[]){highStaffMembers.set(member.user.id,(member.roles||[]).includes(roleId));guildMemberProfiles.set(member.user.id,{...member.user,nick:member.nick,avatar:member.avatar||member.user.avatar})}for(const presence of data.presences||[])updateHighStaffPresence({...presence,guild_id:data.id})}
      if(eventName==='PRESENCE_UPDATE'&&data.guild_id===guildId)updateHighStaffPresence(data);
      if(eventName==='GUILD_MEMBER_UPDATE'&&data.guild_id===guildId){const isMember=(data.roles||[]).includes(roleId);highStaffMembers.set(data.user.id,isMember);guildMemberProfiles.set(data.user.id,{...data.user,nick:data.nick,avatar:data.avatar||data.user.avatar});publishHighStaffPresence(data.user.id)}
      if(eventName==='GUILD_MEMBER_REMOVE'&&data.guild_id===guildId){highStaffMembers.delete(data.user.id);guildMemberProfiles.delete(data.user.id);guildPresences.delete(data.user.id);onlineHighStaff.delete(data.user.id)}
     }
    }catch(err){console.error('Discord presence packet error:',err.message)}
   });
   socket.addEventListener('close',event=>{if(presenceHeartbeat)clearInterval(presenceHeartbeat);presenceHeartbeat=null;presenceSocket=null;discordPresenceState.connected=false;discordPresenceState.guildReady=false;onlineHighStaff.clear();guildPresences.clear();highStaffMembers.clear();guildMemberProfiles.clear();if([4004,4013,4014].includes(event.code)){discordPresenceState.error=`Discord rejected bot token or intents (${event.code})`;return}presenceRetry++;presenceReconnect=setTimeout(connect,Math.min(30000,3000*presenceRetry))});
   socket.addEventListener('error',()=>{discordPresenceState.error='Could not connect to Discord Gateway'});
  }catch(err){discordPresenceState.error=err.message;presenceRetry++;presenceReconnect=setTimeout(connect,Math.min(30000,3000*presenceRetry))}
 }
 connect();
}
async function updateDiscordApplication(item,status,reviewer){
 const webhook=new URL(process.env.DISCORD_WEBHOOK_URL);const parts=webhook.pathname.split('/').filter(Boolean);if(parts.length<4)throw Error('Invalid Discord webhook URL');const webhookId=parts.at(-2),token=parts.at(-1);
 const color=status==='Одобрена'?0x24c978:0xe34b4b;
 const embed={title:`Заявка ${item.type} · ${status}`,description:Object.entries(item.fields||{}).map(([k,v])=>`**${k}:** ${String(v).slice(0,1000)}`).join('\n').slice(0,4000),color,author:{name:`${item.username||'Пользователь'} · Discord`,icon_url:item.avatar||undefined},fields:[{name:'Статус',value:status,inline:true},{name:'Проверил',value:reviewer.username,inline:true}],footer:{text:`Заявка ${item.id} · Discord ID: ${item.userId}`},timestamp:item.createdAt};
 const response=await fetch(`https://discord.com/api/webhooks/${webhookId}/${token}/messages/${item.discordMessageId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({embeds:[embed],allowed_mentions:{parse:[]}})});if(!response.ok)throw Error(`Discord message update failed: ${response.status}`)
}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(req.method==='GET'&&url.pathname==='/api/auth/url'){
   if(!process.env.DISCORD_CLIENT_ID||!process.env.DISCORD_REDIRECT_URI)return json(res,503,{error:'Discord OAuth is not configured'});
   const state=crypto.randomBytes(24).toString('hex');setCookie(res,'sang_oauth_state',state,600);
   const authorize=new URL('https://discord.com/oauth2/authorize');authorize.searchParams.set('client_id',process.env.DISCORD_CLIENT_ID);authorize.searchParams.set('redirect_uri',process.env.DISCORD_REDIRECT_URI);authorize.searchParams.set('response_type','code');authorize.searchParams.set('scope','identify');authorize.searchParams.set('state',state);
   return json(res,200,{url:authorize.href});
 }
 if(req.method==='GET'&&url.pathname==='/auth/discord/callback'){
   const state=cookie(req,'sang_oauth_state');setCookie(res,'sang_oauth_state','',0);
   if(!state||!url.searchParams.get('state')||!safeEqual(state,url.searchParams.get('state')))return json(res,400,{error:'OAuth state mismatch'});
   if(url.searchParams.get('error')){res.writeHead(302,{Location:'/'});return res.end()}
   try{const tokenRes=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.DISCORD_CLIENT_ID,client_secret:process.env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code:url.searchParams.get('code'),redirect_uri:process.env.DISCORD_REDIRECT_URI})});if(!tokenRes.ok)throw Error('OAuth token exchange failed');const token=await tokenRes.json();const userRes=await fetch('https://discord.com/api/users/@me',{headers:{Authorization:`Bearer ${token.access_token}`}});if(!userRes.ok)throw Error('Discord user lookup failed');const u=await userRes.json();const user={id:u.id,username:u.global_name||u.username,avatar:u.avatar?`https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`:null};const body=b64(JSON.stringify({user,exp:Date.now()+7*86400000}));setCookie(res,'sang_session',`${body}.${sign(body)}`,7*86400);res.writeHead(302,{Location:'/'});return res.end()}catch(err){console.error(err.message);return json(res,502,{error:'Discord sign-in failed'})}
 }
 if(req.method==='GET'&&url.pathname==='/api/me'){const user=session(req);return json(res,200,{user,canReview:user?await isHighStaff(user.id):false})}
 if(req.method==='GET'&&url.pathname==='/api/leadership'){try{return json(res,200,await getLeadership())}catch(err){console.error(err.message);return json(res,502,{error:'Could not load Discord leadership'})}}
 if(req.method==='GET'&&url.pathname==='/api/high-staff/online'){return json(res,200,{configured:discordPresenceState.configured,connected:discordPresenceState.connected,guildReady:discordPresenceState.guildReady,error:discordPresenceState.error,people:[...onlineHighStaff.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru'))})}
 if(req.method==='GET'&&url.pathname==='/api/profile'){
   const user=session(req);if(!user)return json(res,401,{error:'Sign in with Discord first'});
   const profile=readStore(profilesFile)[user.id]||{};
   const history=Object.values(readStore(applicationsFile)).filter(item=>item.userId===user.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
   const canReview=await isHighStaff(user.id);return json(res,200,{user,unit:profile.unit||'',history,canReview});
 }
 if(req.method==='PUT'&&url.pathname==='/api/profile'){
   const user=session(req);if(!user)return json(res,401,{error:'Sign in with Discord first'});
   try{const body=await readBody(req);const unit=String(body.unit||'');if(unit&&!units.some(code=>unit.startsWith(code+' — ')))return json(res,400,{error:'Invalid unit'});const profiles=readStore(profilesFile);profiles[user.id]={unit,updatedAt:new Date().toISOString()};writeStore(profilesFile,profiles);return json(res,200,{ok:true,unit})}catch(err){console.error(err.message);return json(res,500,{error:'Could not save profile'})}
 }
 if(req.method==='GET'&&url.pathname==='/api/admin/applications'){
   const user=session(req);if(!user)return json(res,401,{error:'Sign in with Discord first'});if(!await isHighStaff(user.id))return json(res,403,{error:'High Staff role required'});
   const applications=Object.values(readStore(applicationsFile)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return json(res,200,{applications});
 }
 const reviewMatch=url.pathname.match(/^\/api\/admin\/applications\/([a-f0-9-]+)\/review$/i);
 if(req.method==='POST'&&reviewMatch){
   const user=session(req);if(!user)return json(res,401,{error:'Sign in with Discord first'});if(!await isHighStaff(user.id))return json(res,403,{error:'High Staff role required'});
   try{const body=await readBody(req);if(!['Одобрена','Отклонена'].includes(body.status))return json(res,400,{error:'Invalid review status'});const applications=readStore(applicationsFile);const item=applications[reviewMatch[1]];if(!item)return json(res,404,{error:'Application not found'});if(!item.discordMessageId)return json(res,409,{error:'No Discord message ID for this application'});await updateDiscordApplication(item,body.status,user);item.status=body.status;item.reviewedAt=new Date().toISOString();item.reviewer={id:user.id,username:user.username};writeStore(applicationsFile,applications);return json(res,200,{ok:true,status:item.status})}catch(err){console.error(err.message);return json(res,502,{error:'Could not update Discord application'})}
 }
 if(req.method==='POST'&&url.pathname==='/api/applications'){
   const user=session(req);if(!user)return json(res,401,{error:'Sign in with Discord first'});
   if(!process.env.DISCORD_WEBHOOK_URL)return json(res,503,{error:'Discord webhook is not configured'});
   try{const body=await readBody(req);if(typeof body.type!=='string'||!body.type||!body.fields||typeof body.fields!=='object')return json(res,400,{error:'Invalid application'});
     const lines=Object.entries(body.fields).map(([key,val])=>{const label=/^f\d+$/.test(key)?`Поле ${Number(key.slice(1))+1}`:key==='proof'?'Доказательства':key;return `**${label}:** ${String(val).slice(0,1000)}`});
     const embed={title:`Заявка: ${body.type.slice(0,150)} · На проверке`,description:lines.join('\n').slice(0,4000),color:0xff9d22,author:{name:`${user.username} · Discord`,icon_url:user.avatar||undefined},fields:[{name:'Статус',value:'На проверке',inline:true}],footer:{text:`Discord ID: ${user.id}`},timestamp:new Date().toISOString()};
     const hookUrl=new URL(process.env.DISCORD_WEBHOOK_URL);hookUrl.searchParams.set('wait','true');const sent=await fetch(hookUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({embeds:[embed],allowed_mentions:{parse:[]}})});if(!sent.ok)throw Error(`Webhook returned ${sent.status}`);const discordMessage=await sent.json();
     const applications=readStore(applicationsFile);const id=crypto.randomUUID();applications[id]={id,userId:user.id,username:user.username,avatar:user.avatar,type:body.type.slice(0,100),fields:body.fields,createdAt:new Date().toISOString(),status:'На проверке',discordMessageId:discordMessage.id};writeStore(applicationsFile,applications);return json(res,201,{ok:true,id});
   }catch(err){console.error(err.message);return json(res,400,{error:'Could not submit application'})}
 }
 if(req.method==='GET'&&url.pathname==='/')return fs.createReadStream(path.join(root,'index.html')).pipe(res);
 if(req.method==='GET'&&!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/auth/')){const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});return fs.createReadStream(file).pipe(res)}}
 json(res,404,{error:'Not found'});
});
server.listen(port,()=>{console.log(`SANG portal listening on http://localhost:${port}`);startDiscordPresence()});
