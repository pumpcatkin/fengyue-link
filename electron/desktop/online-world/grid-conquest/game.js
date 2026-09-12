const canvas=document.querySelector("#map");
const context=canvas.getContext("2d");
const viewport=document.querySelector("#map-viewport");
const message=document.querySelector("#message");
let payload=null;
let selected=null;
let zoom=1;
const ZOOM_LEVELS=[.1875,.25,.5,.75,1,1.25,1.5,2,3];
const DEFAULT_VISIBLE_CELLS=12;
let mapCssSize=2048;
let mapCentered=false;
let panState=null;
let suppressMapClick=false;
let receivedAt=Date.now();
let serverNow=Date.now();
let dialogueGeneralId=null;
const dialogueLines=[];

function host(type,data={}){parent.postMessage({source:"fyow-grid-conquest",type,...data},"*")}
function ownPlayer(){return payload?.world?.players?.[payload?.account?.accountId]||null}
function cellKey(x,y){return `${x},${y}`}
function dynamicCell(x,y){return payload?.world?.cells?.[cellKey(x,y)]||{ownerAccountId:null,soldiers:0,generalIds:[]}}
function fact(x,y){return payload?.mapFacts?.[y*64+x]||{x,y,population:0,resourceGrade:"—",resourceRank:0,garrisonCap:0,neutralPower:0}}
function ownerColor(owner,rank){
  const neutral=["#b6c88d","#a9bf82","#9fb679","#95ad70","#8aa568"];
  const mine=["#f3cf76","#edbf61","#e6b151","#dc9f45","#d18f3c"];
  const rivals=["#d98169","#cb6b5d","#bd5e54","#ae514b","#9b4745"];
  const palette=!owner?neutral:owner===payload?.account?.accountId?mine:rivals;
  if(!owner)return palette[Math.min(palette.length-1,Math.floor(rank/3))];
  if(owner===payload?.account?.accountId)return palette[Math.min(palette.length-1,Math.floor(rank/3))];
  let hash=0;for(const char of owner)hash=(hash*31+char.charCodeAt(0))|0;
  const offset=Math.abs(hash)%palette.length;
  return palette[(offset+Math.min(palette.length-1,Math.floor(rank/3)))%palette.length];
}
function zoomLabel(){return `${Number(zoom.toFixed(3))}×`}
function updateMapScale(preserveCenter=true){
  const previous=mapCssSize||canvas.getBoundingClientRect().width||2048;
  const centerX=(viewport.scrollLeft+viewport.clientWidth/2-canvas.offsetLeft)/previous;
  const centerY=(viewport.scrollTop+viewport.clientHeight/2-canvas.offsetTop)/previous;
  const visibleSpan=Math.max(320,Math.max(viewport.clientWidth,viewport.clientHeight)-36);
  const next=visibleSpan/DEFAULT_VISIBLE_CELLS*64*zoom;
  if(Math.abs(next-mapCssSize)<1)return;
  mapCssSize=next;canvas.style.width=`${next}px`;canvas.style.height=`${next}px`;document.querySelector("#zoom-label").textContent=zoomLabel();
  if(preserveCenter)requestAnimationFrame(()=>viewport.scrollTo({left:canvas.offsetLeft+centerX*next-viewport.clientWidth/2,top:canvas.offsetTop+centerY*next-viewport.clientHeight/2}));
}
function setZoom(next){
  const clamped=Math.max(ZOOM_LEVELS[0],Math.min(ZOOM_LEVELS.at(-1),next));
  if(clamped===zoom)return;
  zoom=clamped;updateMapScale(true);
}
function stepZoom(direction){
  const current=ZOOM_LEVELS.indexOf(zoom);
  const index=current>=0?current:ZOOM_LEVELS.reduce((best,value,index)=>Math.abs(value-zoom)<Math.abs(ZOOM_LEVELS[best]-zoom)?index:best,0);
  setZoom(ZOOM_LEVELS[Math.max(0,Math.min(ZOOM_LEVELS.length-1,index+direction))]);
}
function centerMap(position,behavior="smooth"){
  if(!position)return;
  const tile=mapCssSize/64;
  viewport.scrollTo({left:canvas.offsetLeft+(position.x+.5)*tile-viewport.clientWidth/2,top:canvas.offsetTop+(position.y+.5)*tile-viewport.clientHeight/2,behavior});
}
function draw(){
  context.clearRect(0,0,canvas.width,canvas.height);
  const size=canvas.width/64;
  for(let y=0;y<64;y+=1)for(let x=0;x<64;x+=1){
    const info=fact(x,y);const cell=dynamicCell(x,y);
    context.fillStyle=ownerColor(cell.ownerAccountId,info.resourceRank);context.fillRect(x*size,y*size,size,size);
    if(cell.generalIds?.length){context.fillStyle="#f4d889";context.fillRect(x*size+size*.34,y*size+size*.34,size*.32,size*.32)}
  }
  context.strokeStyle="#5c704e";context.globalAlpha=.36;context.lineWidth=2;
  for(let i=0;i<=64;i+=1){context.beginPath();context.moveTo(i*size,0);context.lineTo(i*size,canvas.height);context.stroke();context.beginPath();context.moveTo(0,i*size);context.lineTo(canvas.width,i*size);context.stroke()}
  context.globalAlpha=1;
  if(selected){context.fillStyle="#fff1ac";context.globalAlpha=.36;context.fillRect(selected.x*size+2,selected.y*size+2,size-4,size-4);context.globalAlpha=1;context.strokeStyle="#4f3b2a";context.lineWidth=6;context.strokeRect(selected.x*size+3,selected.y*size+3,size-6,size-6)}
  const player=ownPlayer();if(player){const px=(player.position.x+.5)*size,py=(player.position.y+.5)*size;context.fillStyle="#fff8e5";context.strokeStyle="#9d3f34";context.lineWidth=4;context.beginPath();context.moveTo(px,py-size*.34);context.lineTo(px+size*.28,py);context.lineTo(px,py+size*.34);context.lineTo(px-size*.28,py);context.closePath();context.fill();context.stroke()}
}
function showMessage(text){message.textContent=text;message.classList.remove("flash");requestAnimationFrame(()=>message.classList.add("flash"))}
function formatDuration(ms){const seconds=Math.max(0,Math.ceil(ms/1000));if(seconds<60)return `${seconds}秒`;const minutes=Math.floor(seconds/60);const rest=seconds%60;return `${minutes}分${String(rest).padStart(2,"0")}秒`}
function hostTime(){return serverNow+(Date.now()-receivedAt)}
function renderClock(){const now=hostTime();document.querySelector("#clock").textContent=new Date(now).toLocaleTimeString("zh-CN",{hour12:false});const started=Number(payload?.world?.startedAt||now);document.querySelector("#year").textContent=`第 ${1+Math.floor(Math.max(0,now-started)/86400000)} 年`}
function renderPlayer(){
  const player=ownPlayer();document.querySelector("#join-world").classList.toggle("hidden",!payload?.initialized||Boolean(player));
  document.querySelector("#player-name").textContent=player?.displayName||"尚未加入";document.querySelector("#gold").textContent=`${player?.gold||0} 金币`;
  const ownCells=Object.values(payload?.world?.cells||{}).filter(cell=>cell.ownerAccountId===payload?.account?.accountId);
  document.querySelector("#territories").textContent=String(ownCells.length);document.querySelector("#soldiers").textContent=String(ownCells.reduce((sum,cell)=>sum+Number(cell.soldiers||0),Number(player?.fieldArmySoldiers||0)));
  document.querySelector("#position").textContent=player?`${player.position.x},${player.position.y}`:"—";
}
function renderCell(){
  const fields={"#cell-coordinate":"请选择地图格子","#cell-owner":"—","#cell-population":"—","#cell-resource":"—","#cell-garrison":"—","#cell-power":"—"};
  if(selected){const info=fact(selected.x,selected.y);const cell=dynamicCell(selected.x,selected.y);const owner=payload?.world?.players?.[cell.ownerAccountId];const occupiedPower=Number(cell.soldiers||0)+(cell.generalIds||[]).reduce((sum,id)=>sum+Number(payload?.world?.generals?.[id]?.power||0),0);fields["#cell-coordinate"]=`${selected.x}, ${selected.y}`;fields["#cell-owner"]=cell.ownerAccountId?(cell.ownerAccountId===payload?.account?.accountId?"我的领地":owner?.displayName||"其他玩家"):"未占领";fields["#cell-population"]=info.population.toLocaleString();fields["#cell-resource"]=info.resourceGrade;fields["#cell-garrison"]=`${cell.soldiers||0} / ${info.garrisonCap}`;fields["#cell-power"]=String(cell.ownerAccountId?occupiedPower:info.neutralPower)}
  for(const [selector,value] of Object.entries(fields))document.querySelector(selector).textContent=value;
  const player=ownPlayer();const mine=selected&&dynamicCell(selected.x,selected.y).ownerAccountId===payload?.account?.accountId;
  document.querySelector("#start-mining").disabled=!player||!mine;document.querySelector("#train").disabled=!player||!mine;document.querySelector("#march").disabled=!player||!selected;
}
function renderJobs(){
  const target=document.querySelector("#jobs");target.replaceChildren();const jobs=Object.values(payload?.world?.jobs||{}).filter(job=>job.accountId===payload?.account?.accountId);
  target.classList.toggle("empty",!jobs.length);if(!jobs.length){target.textContent="暂无任务";return}
  for(const job of jobs){const node=document.createElement("div");node.className="job";const title=job.type==="mining"?`开采 ${job.x},${job.y}`:job.type==="training"?`练兵 ${job.amount} 人`:`行军至 ${job.to.x},${job.to.y}`;const finish=job.type==="mining"?job.lastSettledAt+job.cycleMs:job.finishAt;node.innerHTML=`<div><b></b><small></small></div><small></small>`;node.querySelector("b").textContent=title;node.querySelector("div small").dataset.finish=String(finish);node.querySelector(":scope>small").textContent=job.type==="mining"?`${job.auto?"自动续采":"单次"} · 每轮 ${job.yieldPerCycle} 金币`:`花费 ${job.cost||0} 金币`;if(job.type==="mining"){const stop=document.createElement("button");stop.type="button";stop.textContent="停止开采";stop.addEventListener("click",()=>sendIntent({type:"stop-mining",jobId:job.id}));node.append(stop)}target.append(node)}
}
function renderGenerals(){
  const target=document.querySelector("#generals");target.replaceChildren();const generals=Object.values(payload?.world?.generals||{}).filter(general=>general.holderAccountId===payload?.account?.accountId||general.status==="deployed");
  target.classList.toggle("empty",!generals.length);if(!generals.length){target.textContent="尚无将领";return}
  const player=ownPlayer();
  for(const general of generals){const node=document.createElement("article");node.className="general";const location=general.status==="deployed"?`部署于 ${general.location?.x},${general.location?.y}`:general.status==="captured"?`俘虏留置于 ${general.location?.x},${general.location?.y}`:general.status==="waiting"?`等待接纳于 ${general.location?.x},${general.location?.y}`:"随行";node.innerHTML="<div><b></b><small></small></div><p></p><div class='buttons'></div>";node.querySelector("b").textContent=`${general.name} · ${general.power}`;node.querySelector("small").textContent=location;node.querySelector("p").textContent=general.memoryText||general.setting||"暂无记忆";const buttons=node.querySelector(".buttons");if(player?.carriedGeneralIds?.includes(general.id)){for(const [label,action] of [["交谈","talk"],["部署","deploy"]]){const button=document.createElement("button");button.textContent=label;button.addEventListener("click",()=>action==="talk"?openDialogue(general):sendIntent({type:"deploy-general",generalId:general.id}));buttons.append(button)}}else if(general.status==="deployed"&&general.holderAccountId===payload?.account?.accountId&&player?.position?.x===general.location?.x&&player?.position?.y===general.location?.y){const button=document.createElement("button");button.textContent="召回";button.addEventListener("click",()=>sendIntent({type:"recall-general",generalId:general.id}));buttons.append(button)}else if(["captured","waiting"].includes(general.status)&&general.holderAccountId===payload?.account?.accountId&&player?.position?.x===general.location?.x&&player?.position?.y===general.location?.y){const button=document.createElement("button");button.textContent="带在身边";button.addEventListener("click",()=>sendIntent({type:"take-general",generalId:general.id}));buttons.append(button)}target.append(node)}
}
function renderMarchGenerals(){
  const target=document.querySelector("#march-generals");target.replaceChildren();const label=document.createElement("small");label.textContent="随行将领";target.append(label);
  const player=ownPlayer();const generals=(player?.carriedGeneralIds||[]).map(id=>payload?.world?.generals?.[id]).filter(Boolean);
  if(!generals.length){const empty=document.createElement("span");empty.textContent="暂无可选将领";target.append(empty);return}
  for(const general of generals){const option=document.createElement("label");const input=document.createElement("input");input.type="checkbox";input.value=general.id;input.checked=true;const name=document.createElement("span");name.textContent=`${general.name}（${general.power}）`;option.append(input,name);target.append(option)}
}
function directLetterCandidates(recipient){
  const player=ownPlayer();
  return (player?.carriedGeneralIds||[]).map(id=>payload?.world?.generals?.[id]).filter(general=>general&&(general.capturedFromAccountId===recipient||general.loyalToAccountId===recipient));
}
function renderDirectGeneralOptions(){
  const recipient=document.querySelector("#direct-recipient").value;
  const type=document.querySelector("#direct-type").value;
  const row=document.querySelector("#direct-general-row");
  const select=document.querySelector("#direct-general");
  row.classList.toggle("hidden",type!=="captured-general-letter");
  const prior=select.value;select.replaceChildren();
  for(const general of directLetterCandidates(recipient)){const option=document.createElement("option");option.value=general.id;option.textContent=general.name;select.append(option)}
  if([...select.options].some(option=>option.value===prior))select.value=prior;
  if(type==="captured-general-letter"&&!select.options.length){const option=document.createElement("option");option.value="";option.textContent="没有可写信的被俘将领";select.append(option)}
}
function renderDirect(){
  const recipient=document.querySelector("#direct-recipient");const prior=recipient.value;recipient.replaceChildren();
  const players=Object.values(payload?.world?.players||{}).filter(player=>player.accountId!==payload?.account?.accountId);
  for(const player of players){const option=document.createElement("option");option.value=player.accountId;option.textContent=player.displayName||player.accountId;recipient.append(option)}
  if(players.some(player=>player.accountId===prior))recipient.value=prior;
  if(!players.length){const option=document.createElement("option");option.value="";option.textContent="暂无其他玩家";recipient.append(option)}
  const inbox=document.querySelector("#direct-inbox");inbox.replaceChildren();const messages=[...(payload?.directInbox||[])].reverse();
  document.querySelector("#direct-count").textContent=`${messages.length} 封来信`;inbox.classList.toggle("empty",!messages.length);
  if(!messages.length)inbox.textContent="暂无来信";
  for(const item of messages){const sender=payload?.world?.players?.[item.fromAccountId];const node=document.createElement("article");node.className="direct-message";const heading=document.createElement("div");const title=document.createElement("b");const time=document.createElement("time");const body=document.createElement("p");const label=item.type==="captured-general-letter"?`${item.payload?.generalName||"被俘将领"}来信`:"私人密谈";title.textContent=`${sender?.displayName||item.fromAccountId} · ${label}`;time.textContent=new Date(Number(item.createdAt||item.receivedAt||Date.now())).toLocaleString("zh-CN",{hour12:false});body.textContent=String(item.payload?.text||"");heading.append(title,time);node.append(heading,body);inbox.append(node)}
  renderDirectGeneralOptions();
  document.querySelector("#direct-form button").disabled=!ownPlayer()||!players.length;
}
function render(){
  document.querySelector("#world-status").textContent=payload?.syncing?"正在同步评论账本…":payload?.initialized?`赛季 ${payload.control?.seasonId?.slice(0,8)||"—"} · 修订 ${payload.world?.revision||0}`:payload?.status==="needs-initialization"?"等待作品作者初始化赛季":"等待宿主";
  renderPlayer();renderCell();renderJobs();renderGenerals();renderMarchGenerals();renderDirect();draw();renderClock();
  if(!mapCentered&&ownPlayer()){mapCentered=true;requestAnimationFrame(()=>centerMap(ownPlayer().position,"auto"))}
}
function sendIntent(intent){if(!payload?.initialized){showMessage("赛季尚未初始化");return}host("intent",{intent:{...intent,idempotencyKey:crypto.randomUUID()}});showMessage("行动已提交给工具宿主验证…")}
function openDialogue(general){dialogueGeneralId=general.id;document.querySelector("#dialogue-panel").classList.remove("hidden");document.querySelector("#dialogue-general").textContent=`与 ${general.name} 交谈`;document.querySelector("#dialogue-input").focus()}
function addDialogue(text){dialogueLines.push(text);const target=document.querySelector("#dialogue-history");const line=document.createElement("p");line.textContent=text;target.append(line);target.scrollTop=target.scrollHeight}

canvas.addEventListener("click",event=>{if(event.button!==0||suppressMapClick){suppressMapClick=false;return}const rect=canvas.getBoundingClientRect();selected={x:Math.max(0,Math.min(63,Math.floor((event.clientX-rect.left)/rect.width*64))),y:Math.max(0,Math.min(63,Math.floor((event.clientY-rect.top)/rect.height*64)))};renderCell();draw()});
viewport.addEventListener("contextmenu",event=>event.preventDefault());
viewport.addEventListener("pointerdown",event=>{if(event.button!==2)return;event.preventDefault();panState={pointerId:event.pointerId,x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop,moved:false};viewport.setPointerCapture(event.pointerId);viewport.classList.add("panning")});
viewport.addEventListener("pointermove",event=>{if(!panState||event.pointerId!==panState.pointerId)return;const dx=event.clientX-panState.x;const dy=event.clientY-panState.y;if(Math.abs(dx)>3||Math.abs(dy)>3)panState.moved=true;viewport.scrollLeft=panState.left-dx;viewport.scrollTop=panState.top-dy});
function finishPan(event){if(!panState||event.pointerId!==panState.pointerId)return;suppressMapClick=panState.moved;panState=null;viewport.classList.remove("panning");if(viewport.hasPointerCapture(event.pointerId))viewport.releasePointerCapture(event.pointerId)}
viewport.addEventListener("pointerup",finishPan);viewport.addEventListener("pointercancel",finishPan);
document.querySelector("#zoom-in").addEventListener("click",()=>stepZoom(1));
document.querySelector("#zoom-out").addEventListener("click",()=>stepZoom(-1));
document.querySelector("#center-map").addEventListener("click",()=>{const player=ownPlayer();if(!player)return;selected={...player.position};renderCell();draw();centerMap(player.position)});
document.querySelector("#join-world").addEventListener("click",()=>sendIntent({type:"join"}));
document.querySelector("#start-mining").addEventListener("click",()=>selected&&sendIntent({type:"start-mining",x:selected.x,y:selected.y,auto:true}));
document.querySelector("#train").addEventListener("click",()=>selected&&sendIntent({type:"train",x:selected.x,y:selected.y,amount:Number(document.querySelector("#train-amount").value)}));
document.querySelector("#march").addEventListener("click",()=>selected&&sendIntent({type:"march",to:selected,soldiers:Number(document.querySelector("#march-soldiers").value),generalIds:[...document.querySelectorAll("#march-generals input:checked")].map(input=>input.value),attack:document.querySelector("#march-attack").checked}));
document.querySelector("#close-dialogue").addEventListener("click",()=>document.querySelector("#dialogue-panel").classList.add("hidden"));
document.querySelector("#dialogue-form").addEventListener("submit",event=>{event.preventDefault();const input=document.querySelector("#dialogue-input");const topic=input.value.trim();if(!topic||!dialogueGeneralId)return;addDialogue(`你：${topic}`);sendIntent({type:"talk-general",generalId:dialogueGeneralId,topic});input.value=""});
document.querySelector("#direct-type").addEventListener("change",renderDirectGeneralOptions);
document.querySelector("#direct-recipient").addEventListener("change",renderDirectGeneralOptions);
document.querySelector("#direct-form").addEventListener("submit",event=>{event.preventDefault();const toAccountId=document.querySelector("#direct-recipient").value;const type=document.querySelector("#direct-type").value;const text=document.querySelector("#direct-text").value.trim();const generalId=document.querySelector("#direct-general").value;if(!toAccountId){showMessage("当前没有可选择的收信玩家");return}if(!text){showMessage("请输入消息正文");return}if(type==="captured-general-letter"&&!generalId){showMessage("请选择当前带在身边的被俘将领");return}host("direct",{message:{toAccountId,type,payload:{text,...(generalId?{generalId}:{})}}});showMessage("正在通过评论回复唤醒收信方，并发送加密私信…")});
window.addEventListener("message",event=>{if(event.source!==parent||event.data?.source!=="fengyue-host")return;if(event.data.type==="state"){payload=event.data.state;receivedAt=Date.now();serverNow=Number(payload.serverNow||Date.now());render()}else if(event.data.type==="result"){const result=event.data.result;if(result?.dialogue?.reply)addDialogue(`${document.querySelector("#dialogue-general").textContent.replace("与 ","").replace(" 交谈","")}：${result.dialogue.reply}`);if(result?.direct){document.querySelector("#direct-text").value="";showMessage("定向消息已加密发送，并在收信方评论入口留下唤醒指令。")}else showMessage(result?.queued?"行动已写入评论区，等待权威端确认。":"行动已经确认并写入账本。") }else if(event.data.type==="error")showMessage(`行动失败：${event.data.message}`)});
setInterval(()=>{renderClock();document.querySelectorAll("[data-finish]").forEach(node=>node.textContent=formatDuration(Number(node.dataset.finish)-hostTime()))},1000);
new ResizeObserver(()=>updateMapScale(true)).observe(viewport);
requestAnimationFrame(()=>updateMapScale(false));
host("ready");
