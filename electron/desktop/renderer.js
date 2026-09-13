const api = window.fengyueBackend;
const settingsOverlayMode = new URLSearchParams(location.search).get("settingsOverlay") === "1";
document.body.classList.toggle("settings-overlay-mode", settingsOverlayMode);
const slot = document.querySelector("#surface-slot");
const loginPanel = document.querySelector("#login-panel");
const placeholder = document.querySelector(".stage-placeholder");
const gameFrame = document.querySelector("#game-frame");
const gameFrameContext = gameFrame.getContext("2d", { alpha: false, desynchronized: true });
const loginForm = document.querySelector("#login-form");
const accountInput = document.querySelector("#login-account");
const passwordInput = document.querySelector("#login-password");
const rememberInput = document.querySelector("#remember-password");
const autoLoginInput = document.querySelector("#auto-login");
const submitLogin = document.querySelector("#submit-login");
const domainList = document.querySelector("#domain-list");
const domainNote = document.querySelector("#domain-selection-note");
const homePage = document.querySelector("#home-page");
const profilesPage = document.querySelector("#profiles-page");
const onlineWorldPage = document.querySelector("#online-world-page");
const onlineWorldFrame = document.querySelector("#online-world-frame");
const multiplayerPage = document.querySelector("#multiplayer-page");
const appVersion = document.querySelector("#app-version");
const settingsToggle = document.querySelector("#settings-toggle");
const settingsPopover = document.querySelector("#settings-popover");
const settingsDomainList = document.querySelector("#settings-domain-list");
const officialNoticeOverlay = document.querySelector("#official-notice-overlay");
const officialNoticeCard = document.querySelector("#official-notice-card");
const officialNoticeEyebrow = document.querySelector("#official-notice-eyebrow");
const officialNoticeVersion = document.querySelector("#official-notice-version");
const officialNoticeTitle = document.querySelector("#official-notice-title");
const officialNoticeMessage = document.querySelector("#official-notice-message");
const officialNoticePoints = document.querySelector("#official-notice-points");
const officialNoticeOpen = document.querySelector("#official-notice-open");
const officialNoticeAction = document.querySelector("#official-notice-action");
const authorName = document.querySelector("#author-name");
const authorLinkButtons = [...document.querySelectorAll("[data-author-link]")];
const UI_THEME_STORAGE_KEY = "fengyue-link-ui-theme";
let automaticLoginActive=false;

function applyReleaseIdentity(){
  const productName="风月联机工具";
  document.title=productName;
  document.querySelectorAll("[data-product-name]").forEach(element=>{element.textContent=productName});
}

function renderAuthorInfo(info){
  if(!info)return;
  authorName.textContent=info.name||"八爪毛米";
  for(const button of authorLinkButtons){
    const item=info.links?.[button.dataset.authorLink];
    const label=button.querySelector("span");
    const status=button.querySelector("small");
    if(item?.label)label.textContent=item.label;
    button.disabled=!item?.configured;
    button.title=item?.configured?`打开${item.label}`:`${item?.label||"此页面"}链接待作者补充`;
    status.textContent=item?.configured?(button.dataset.authorLink==="github"?"唯一官方仓库":"打开链接"):"链接待补充";
  }
}

function setOfficialNoticePoints(items){
  officialNoticePoints.replaceChildren(...items.map(value=>{const item=document.createElement("span");item.textContent=value;return item}));
}

function showStartupOfficialNotice(){
  if(settingsOverlayMode)return;
  officialNoticeCard.dataset.mode="announcement";
  officialNoticeEyebrow.textContent="版本号对照";
  officialNoticeVersion.textContent="启动检查";
  officialNoticeTitle.textContent="正在对照版本号";
  officialNoticeMessage.textContent="每次启动都会对照当前版本号与发布版本号。";
  setOfficialNoticePoints(["当前版本","发布版本","每次启动"]);
  officialNoticeOpen.classList.remove("primary");
  officialNoticeAction.classList.add("primary");
  officialNoticeAction.disabled=false;
  officialNoticeAction.textContent="进入工具";
  officialNoticeOverlay.classList.remove("hidden");
  requestAnimationFrame(()=>officialNoticeAction.focus());
}

function showReleaseVerificationFailure(security,update={}){
  if(settingsOverlayMode)return;
  const updateRequired=security?.status==="update-required";
  const automaticUpdate=updateRequired&&["checking","downloading","verifying","installing","ready"].includes(update?.status);
  officialNoticeCard.dataset.mode=updateRequired?"update-required":"blocked";
  officialNoticeEyebrow.textContent="版本号对照";
  officialNoticeVersion.textContent=automaticUpdate?"正在更新":updateRequired?"发现新版本":"未完成";
  officialNoticeTitle.textContent=automaticUpdate
    ? update.status==="ready"?"新版本已下载":"正在更新版本"
    : updateRequired?"请更新版本":"版本号对照未完成";
  officialNoticeMessage.textContent=automaticUpdate
    ? update.message||security.message||"正在获取发布版本。"
    : security?.message||"版本号对照未完成。";
  setOfficialNoticePoints([`当前 ${security?.currentVersion?`v${security.currentVersion}`:"版本未知"}`,`发布 ${security?.latestVersion?`v${security.latestVersion}`:"版本未知"}`]);
  officialNoticeOpen.classList.toggle("primary",!automaticUpdate);
  officialNoticeAction.classList.toggle("primary",automaticUpdate);
  officialNoticeAction.disabled=automaticUpdate;
  officialNoticeAction.textContent=automaticUpdate?(update.status==="ready"?"关闭工具后自动安装":"自动更新中…"):"退出工具";
  officialNoticeOverlay.classList.remove("hidden");
  requestAnimationFrame(()=>(automaticUpdate?officialNoticeAction:officialNoticeOpen).focus());
}

function renderReleaseVerificationResult(next){
  const security=next?.releaseSecurity||{};
  if(["blocked","unavailable","update-required"].includes(security.status))showReleaseVerificationFailure(security,next?.appUpdate||{});
}

function initialUiTheme(){
  try{
    const saved=localStorage.getItem(UI_THEME_STORAGE_KEY);
    if(saved==="light"||saved==="dark")return saved;
  }catch{}
  return window.matchMedia?.("(prefers-color-scheme: light)").matches?"light":"dark";
}

function applyUiTheme(value,{persist=true,syncBackend=true}={}){
  const theme=value==="light"?"light":"dark";
  document.documentElement.dataset.theme=theme;
  document.querySelectorAll("[data-theme-choice]").forEach(button=>{
    const active=button.dataset.themeChoice===theme;
    button.classList.toggle("active",active);
    button.setAttribute("aria-pressed",active?"true":"false");
  });
  if(persist){try{localStorage.setItem(UI_THEME_STORAGE_KEY,theme)}catch{}}
  if(syncBackend)api.setTheme(theme).catch(()=>{});
  return theme;
}

let uiTheme=applyUiTheme(initialUiTheme(),{persist:false});
let state = null;
let onlineWorldState = null;
let onlineWorldCards = [];
let selectedOnlineWorldCardId = null;
let onlineWorldEnteredProfileId = null;
let onlineWorldInLibrary = true;
let onlineWorldFrameReady = false;
let onlineWorldProgramHash = "builtin-preview";
let onlineWorldProgramUrl = null;
let onlineWorldMigrationTarget = null;
let activePage = "home";
let profileEditorDirty = false;
let profileEditorId = null;
let domainDirectory = null;
let settingsOpen = false;
let resizeTimer;
let lastSurfaceBoundsKey = "";
let pendingGameScroll = 0;
let gameScrollTimer = null;
let latestGameFrame = null;
let hasGameFrame = false;
let pendingGameFrame = null;
let gameFrameDecodeBusy = false;
let gameFrameGeneration = 0;
let pendingPointerMove = null;
let pointerMoveTimer = null;
let gameInputQueue = Promise.resolve();
let activeModelFamily = "all";
const ONLINE_WORLD_COVER_MARKS = ["征","舟","田","夜","机","棋","驿","月","岛","云"];
let pendingModelChangeKey = null;
let adminLogsLoaded = false;
let renderedRoomChatRevision = -1;
let renderedRoomChatPendingId = "";
let conversationAttentionKey = null;
let lastObservedResultKey = null;
let conversationRenameTarget = null;
const expandedMemberAppearances = new Set();
let notificationAudioContext = null;
let pluginEditorDirty = false;
let perspectiveEditorDirty = false;
let workSettingsDirty = false;
let memorySettingsDirty = false;
let workSettingsSnapshot = null;
let workSettingsAppId = null;
const sessionLogEntries = new Map();

const MODEL_FAMILIES = [
  { id:"gemini", label:"Gemini" },
  { id:"claude", label:"Claude" },
  { id:"deepseek", label:"DeepSeek" },
  { id:"gpt", label:"GPT" },
  { id:"grok", label:"Grok" },
  { id:"kimi", label:"Kimi" },
  { id:"qwen", label:"Qwen" },
  { id:"other", label:"Other" }
];

function modelKey(model){return model?`${model.provider}\u0000${model.model}`:""}
function formatModelPrice(value){return value==null||String(value).trim()===""?"—":`×${String(value).replace(/^×/,"")}`}
function formatSuccessRate(value){if(value==null||String(value).trim()==="")return "—";const number=Number(value);return Number.isFinite(number)?`${Math.max(0,Math.min(100,number)).toFixed(number%1?1:0)}%`:"—"}

function renderModelSelector(next){
  const modelCard=document.querySelector("#model-card");
  const tabs=document.querySelector("#model-family-tabs");
  const options=document.querySelector("#model-options");
  const models=next.models||{items:[]};
  const items=models.items||[];
  modelCard.classList.toggle("hidden",!next.work);
  const ownModel=models.selected;
  const roomModel=next.room?.model||models.hostSelected;
  const displayedModel=next.room?.role==="guest"?roomModel:ownModel;
  document.querySelector("#model-name").textContent=displayedModel?.label||displayedModel?.model||(models.loading?"读取中…":"尚未选择");

  const presentFamilies=new Set(items.map(item=>item.family||"other"));
  const familyItems=MODEL_FAMILIES.filter(item=>presentFamilies.has(item.id));
  const visibleFamilies=[{id:"all",label:"全部"},...familyItems];
  if(!visibleFamilies.some(item=>item.id===activeModelFamily))activeModelFamily="all";
  tabs.replaceChildren();
  for(const family of visibleFamilies){
    const button=document.createElement("button");
    button.type="button";
    button.className="model-family-tab";
    button.classList.toggle("active",family.id===activeModelFamily);
    button.setAttribute("role","tab");
    button.setAttribute("aria-selected",family.id===activeModelFamily?"true":"false");
    button.textContent=family.label;
    button.addEventListener("click",()=>{activeModelFamily=family.id;renderModelSelector(state)});
    tabs.append(button);
  }

  const canChange=Boolean(next.work)&&next.room?.role!=="guest"&&!next.messageOperationBusy&&!['processing-input','generating','processing-output','syncing'].includes(next.room?.round?.status);
  const filtered=activeModelFamily==="all"?items:items.filter(item=>(item.family||"other")===activeModelFamily);
  options.replaceChildren();
  for(const item of filtered){
    const key=modelKey(item);
    const selected=key===modelKey(ownModel);
    const pending=key===pendingModelChangeKey;
    const button=document.createElement("button");
    button.type="button";
    button.className="model-option";
    button.classList.toggle("selected",selected);
    button.classList.toggle("pending",pending&&!selected);
    button.disabled=!canChange||Boolean(models.loading)||Boolean(models.changing)||Boolean(pendingModelChangeKey);
    button.setAttribute("role","option");
    button.setAttribute("aria-selected",selected?"true":"false");

    const top=document.createElement("span");
    top.className="model-option-top";
    const radio=document.createElement("i");
    radio.className="model-radio";
    const name=document.createElement("b");
    name.textContent=item.label||item.model;
    const selectedBadge=document.createElement("em");
    selectedBadge.textContent=pending&&!selected?"切换中":selected?"当前":"";
    top.append(radio,name,selectedBadge);

    const details=document.createElement("span");
    details.className="model-option-details";
    const provider=document.createElement("small");
    provider.textContent=item.providerLabel||item.provider;
    const metrics=document.createElement("span");
    metrics.className="model-metrics";
    const price=document.createElement("span");
    const priceLabel=document.createElement("small");
    const priceValue=document.createElement("b");
    priceLabel.textContent="价格系数";
    priceValue.textContent=formatModelPrice(item.priceCoefficient);
    price.append(priceLabel,priceValue);
    const success=document.createElement("span");
    const successLabel=document.createElement("small");
    const successValue=document.createElement("b");
    successLabel.textContent="出字率";
    successValue.textContent=formatSuccessRate(item.successRate);
    success.append(successLabel,successValue);
    metrics.append(price,success);
    details.append(provider,metrics);
    button.append(top,details);
    button.addEventListener("click",()=>{
      if(button.disabled||selected)return;
      pendingModelChangeKey=key;
      renderModelSelector(state);
      invoke(async()=>{await api.setModel({provider:item.provider,model:item.model});toast("模型已切换")})
        .catch(()=>{})
        .finally(()=>{pendingModelChangeKey=null;if(state)renderModelSelector(state)});
    });
    options.append(button);
  }
  if(!options.children.length){
    const empty=document.createElement("div");
    empty.className="model-empty";
    empty.textContent=models.loading?"正在读取模型…":"这个系列暂无模型";
    options.append(empty);
  }
  document.querySelector("#model-note").textContent=models.error
    ? `读取失败：${models.error}`
    : models.changing
      ? "正在切换模型并更新作品页面…"
      : next.room?.role==="guest"
        ? `房主：${roomModel?.label||roomModel?.model||"等待同步"} · 本机：${ownModel?.label||ownModel?.model||"自动选择中"}（优先 Grok；缺失时选其他实测型号）`
        : ownModel
          ? `价格系数 ${formatModelPrice(ownModel.priceCoefficient)} · 出字率 ${formatSuccessRate(ownModel.successRate)}`
          : "请选择模型";
}

function orderedSessionLogs(){return [...sessionLogEntries.values()].sort((left,right)=>Number(left.seq||0)-Number(right.seq||0))}
function renderSessionLogs(){
  const entries=orderedSessionLogs();
  const output=document.querySelector("#session-log");
  document.querySelector("#log-count").textContent=`${entries.length} 条`;
  output.textContent=entries.length?entries.map(entry=>JSON.stringify(entry,null,2)).join("\n\n"):"暂时没有联机日志";
  output.scrollTop=output.scrollHeight;
}
function receiveSessionLog(entry){
  if(!entry||sessionLogEntries.has(entry.seq))return;
  sessionLogEntries.set(entry.seq,entry);
  renderSessionLogs();
}

function activateSidebarTab(tab){
  document.querySelectorAll("[data-tab]").forEach(item=>item.classList.toggle("active",item.dataset.tab===tab));
  document.querySelectorAll("[data-panel]").forEach(panel=>panel.classList.toggle("active",panel.dataset.panel===tab));
}

function formatRoomChatTime(value){
  const date=new Date(Number(value)||0);
  return Number.isFinite(date.getTime())?date.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"}):"—";
}

function renderRoomChat(next){
  const chat=next.room?.chat||{revision:0,messages:[],pending:null,syncStatus:"ready",error:null};
  const messages=Array.isArray(chat.messages)?chat.messages:[];
  const list=document.querySelector("#room-chat-messages");
  const pendingId=String(chat.pending?.clientMessageId||"");
  const shouldFollow=Number(chat.revision||0)!==renderedRoomChatRevision||pendingId!==renderedRoomChatPendingId||list.scrollHeight-list.scrollTop-list.clientHeight<36;
  renderedRoomChatRevision=Number(chat.revision||0);
  renderedRoomChatPendingId=pendingId;
  list.replaceChildren();
  if(messages.length){
    for(const message of messages){
      const card=document.createElement("article");
      card.className="room-chat-message";
      card.classList.toggle("own",String(message.senderId)===String(next.account?.accountId));
      card.classList.toggle("pending",Boolean(message.optimistic));
      card.classList.toggle("failed",message.deliveryStatus==="error");
      const head=document.createElement("header");
      const name=document.createElement("b");
      const time=document.createElement("time");
      const body=document.createElement("p");
      name.textContent=message.displayName||"未命名玩家";
      time.dateTime=message.sentAtIso||new Date(Number(message.sentAt)||0).toISOString();
      const deliveryLabel=message.optimistic?(message.deliveryStatus==="error"?" · 发送失败":message.deliveryStatus==="retrying"?" · 重试中":" · 发送中"):"";
      time.textContent=`${formatRoomChatTime(message.sentAt)}${deliveryLabel}`;
      time.title=`发送时间：${time.dateTime}（Unix ${Number(message.sentAt)||0} ms）`;
      body.textContent=message.text||"";
      head.append(name,time);
      card.append(head,body);
      list.append(card);
    }
  }else{
    const empty=document.createElement("div");
    empty.className="empty-small";
    empty.textContent=next.room?.status==="waiting"?"还没有房间聊天消息":"创建或加入房间后即可聊天";
    list.append(empty);
  }
  if(shouldFollow)requestAnimationFrame(()=>{list.scrollTop=list.scrollHeight});
  document.querySelector("#room-chat-count").textContent=`${messages.length} 条`;
  const status=document.querySelector("#room-chat-status");
  const pending=chat.pending;
  status.classList.toggle("error",Boolean(chat.error)&&pending?.status==="error");
  status.textContent=!next.room
    ? "尚未加入房间"
    : next.room.status!=="waiting"
      ? "正在等待房间建立"
      : pending?.status==="error"
        ? `${chat.error||"发送失败"}；可以重新发送`
        : pending
          ? `${pending.status==="retrying"?"网络波动，正在重试":"已发送给房主，等待房主确认并回传"}（第 ${pending.attempts||1} 次）`
          : chat.syncStatus==="retrying"
            ? `最新消息广播失败，房主正在重试：${chat.error||"网络异常"}`
            : chat.syncStatus==="recovering"
              ? "检测到聊天消息缺口，正在向房主请求恢复"
              : chat.syncStatus==="error"
                ? chat.error||"房间聊天恢复失败"
            : chat.syncStatus==="syncing"
                ? "正在同步聊天"
                : "聊天已同步";
  const input=document.querySelector("#room-chat-input");
  const button=document.querySelector("#send-room-chat");
  const locked=!next.room||next.room.status!=="waiting"||Boolean(pending&&pending.status!=="error");
  input.disabled=locked;
  button.disabled=locked;
  button.textContent=pending&&pending.status!=="error"?"等待房主":"发送";
}

function renderWorkSettings(next){
  const settings=next.workSettings||{};
  const guest=next.room?.role==="guest";
  if(workSettingsAppId!==settings.appId){
    workSettingsAppId=settings.appId;
    workSettingsDirty=false;memorySettingsDirty=false;workSettingsSnapshot=null;
  }
  const locked=guest||!next.work||settings.loading||settings.saving||!settings.global||next.plugins?.busy
    ||(next.room?.round?.status&&next.room.round.status!=="collecting")||Boolean(next.room?.round?.readyCount);
  document.querySelector("#work-settings-card").classList.toggle("hidden",!next.work);
  if(!memorySettingsDirty)document.querySelector("#work-memory-count").value=settings.memoryCount??6;
  if(!workSettingsDirty){
    workSettingsSnapshot=structuredClone(settings.global||{});
    const {pre_prompt="",pre_text="",post_text="",...extra}=settings.global||{};
    document.querySelector("#work-global-prompt").value=pre_prompt;
    document.querySelector("#work-global-prefix").value=pre_text;
    document.querySelector("#work-global-postfix").value=post_text;
    document.querySelector("#work-global-extra").value=JSON.stringify(extra,null,2);
  }
  for(const id of ["work-memory-count","work-global-prompt","work-global-prefix","work-global-postfix","work-global-extra"]){
    document.getElementById(id).readOnly=Boolean(locked);
  }
  for(const id of ["save-work-memory","save-work-global"])document.getElementById(id).disabled=Boolean(locked);
  document.querySelector("#refresh-work-settings").disabled=guest||!next.work||settings.loading||settings.saving;
  document.querySelector("#work-global-count").textContent=settings.global?`${settings.characters??0} 字`:"尚未读取";
  document.querySelector("#work-settings-note").textContent=settings.error|| (settings.saving?"正在保存并验证平台设置…":settings.loading?"正在读取平台设置…":guest?"房主的作品配置 · 只读":"修改后写入平台；全局配置与当前会话配置各自保留。");
}

function renderPerspectivePlugin(next){
  const definition=next.plugins?.definitions?.find(item=>item.id==="perspective-split")||{enabled:false,settings:{}};
  const round=next.room?.round;
  const locked=Boolean(next.plugins?.busy)||Boolean(next.conversationBusy)||next.prefixAdapter?.status==="adapting"||next.room?.role==="guest"||(round&&round.status!=="collecting")||Boolean(round?.readyCount);
  document.querySelector("#perspective-split-enabled").checked=definition.enabled;
  if(!perspectiveEditorDirty)document.querySelector("#perspective-split-words").value=definition.settings?.wordsPerPlayer??800;
  for(const id of ["perspective-split-enabled","perspective-split-words","save-perspective-split"])document.getElementById(id).disabled=Boolean(locked);
  const runs=[...(next.plugins?.currentRuns||[]),...(next.plugins?.lastRuns||[])];
  const run=runs.find(item=>item.pluginId==="perspective-split");
  const progress=next.plugins?.perspectiveProgress;
  const cost=run?`${run.pointsIncomplete?"已读取 ":""}${run.points?.total??0} 积分${run.pointsIncomplete?"（部分尝试消耗未能读取）":""}`:"";
  document.querySelector("#perspective-split-summary-state").textContent=progress?`第 ${progress.attempt}/${progress.maxAttempts} 次`:run?.status==="running"?"处理中":definition.enabled?"已启用":"未启用";
  document.querySelector("#perspective-split-last-run").textContent=progress?`正在${progress.attempt>1?"重新加载整理作品并新建会话重试":"整理本轮视角"}（第 ${progress.attempt}/${progress.maxAttempts} 次）…`:run?run.status==="error"?`整理失败，原文暂不公开：${run.error} · ${cost}`:run.status==="completed"?`上次整理 ${run.memberCount} 人${run.attemptCount?`，尝试 ${run.attemptCount} 次`:""} · ${cost}`:"正在整理本轮视角…":"";
}

function renderPluginPanel(next){
  renderPerspectivePlugin(next);
  const plugins=next.plugins||{definitions:[],currentRuns:[],lastRuns:[]};
  const definition=(plugins.definitions||[]).find(item=>item.id==="effect-judge")||{enabled:false,settings:{}};
  const settings=definition.settings||{};
  const effectCard=document.querySelector("#effect-judge-card");
  const effectSummaryState=document.querySelector("#effect-judge-summary-state");
  document.querySelector("#effect-judge-enabled").checked=Boolean(definition.enabled);
  if(!pluginEditorDirty){
    document.querySelector("#effect-judge-context").value=String(settings.previousOutputs??3);
    document.querySelector("#effect-judge-degrees").value=String(settings.degreeCount??4);
    document.querySelector("#effect-judge-faces").value=String(settings.dieFaces??10);
    document.querySelector("#effect-judge-degrees").max=String(Math.max(4,Number(settings.dieFaces??10)-2));
    document.querySelector("#effect-judge-style-preset").value=settings.stylePreset||"regular";
    document.querySelector("#effect-judge-style").value=settings.stylePrompt||"";
  }
  const round=next.room?.round;
  const locked=Boolean(plugins.busy)||next.room?.role==="guest"||(round&&round.status!=="collecting")||Boolean(round?.readyCount);
  for(const id of ["#effect-judge-enabled","#effect-judge-context","#effect-judge-degrees","#effect-judge-faces","#effect-judge-style-preset","#effect-judge-style","#save-effect-judge"]){
    document.querySelector(id).disabled=locked;
  }
  const stackStatus=document.querySelector("#plugin-stack-status");
  stackStatus.classList.toggle("running",Boolean(plugins.busy)||["processing-input","processing-output"].includes(round?.status));
  stackStatus.textContent=round?.status==="processing-input"?"正在处理玩家输入":round?.status==="processing-output"?"正在处理模型输出":plugins.busy?"插件正在运行":next.room?.role==="guest"?"由房主统一执行":"处理栈空闲";

  const runs=[...(plugins.currentRuns||[]),...(plugins.lastRuns||[])];
  const run=runs.find(item=>item.pluginId==="effect-judge")||null;
  const runNeedsAttention=["running","error"].includes(run?.status);
  if(runNeedsAttention)effectCard.open=true;
  const contextAvailable=Boolean(definition.contextAvailable);
  effectSummaryState.className=run?.status==="error"?"error":run?.status==="running"?"running":definition.enabled&&contextAvailable?"active":"";
  effectSummaryState.textContent=run?.status==="error"?"上轮已降级":run?.status==="running"?"处理中":definition.enabled&&!contextAvailable?"等待上文":definition.enabled?"已启用":"未启用";
  const toggleLabel=document.querySelector("#effect-judge-enabled").closest(".plugin-summary-toggle");
  toggleLabel.title=!contextAvailable
    ? "当前会话没有可读取的历史模型输出；可以预先启用，但首轮不会运行，会在历史输出可读后自动生效。"
    : "启用或停用效果判定";
}

function activeConversationFlow(next){
  if(!next.room)return "";
  const round=next.room.round;
  const running=(next.plugins?.currentRuns||[]).find(run=>run?.status==="running");
  const phase=round?.status==="processing-output"?"output":"input";
  const configured=(next.plugins?.definitions||[]).find(plugin=>plugin?.enabled&&plugin?.phase===phase);
  const pluginName=String(running?.name||running?.pluginId||configured?.name||configured?.id||"").trim();
  const operation=next.room.messageOperation;
  if(next.messageOperationBusy||["running","syncing"].includes(operation?.status)){
    if(operation?.action==="edit")return "正在保存编辑内容";
    if(operation?.action==="delete")return "正在删除上一条对话";
    if(operation?.action==="refresh")return "正在刷新上一条对话";
    return "正在同步对话记录";
  }
  if(next.room.role==="guest"&&next.room.historySync?.status&&next.room.historySync.status!=="ready"&&next.room.historySync.status!=="error")return "正在准备对话记录";
  if(next.room.role==="host"&&next.room.promptSync?.status==="syncing")return "正在准备多人对话";
  if(round?.status==="processing-input")return pluginName?`插件${pluginName}处理输入信息中`:"插件处理输入信息中";
  if(round?.status==="generating")return next.room.role==="guest"?"等待房主生成对话内容":"正在生成对话内容";
  if(round?.status==="processing-output")return pluginName?`插件${pluginName}处理输出信息中`:"插件处理输出信息中";
  if(round?.status==="syncing")return "正在同步对话记录";
  if(round?.status==="collecting"&&round.readyCount>0&&round.readyCount<round.totalCount)return "已确认，等待其他成员";
  return "";
}

function loadAdminLogs(){
  if(adminLogsLoaded||!state?.isAdmin)return;
  adminLogsLoaded=true;
  api.getLogs().then(entries=>{if(!state?.isAdmin)return;for(const entry of entries||[])sessionLogEntries.set(entry.seq,entry);renderSessionLogs()}).catch(error=>{adminLogsLoaded=false;toast(friendlyError(error))});
}

const labels = {
  booting:["准备中",""],login:["账号登录",""],"oauth-login":["第三方账号认证","请在认证窗口中完成登录"],lobby:["房间大厅",""],selector:["选择作品",""],"loading-intro":["载入作品介绍",""],intro:["作品介绍",""],"intro-empty":["作品介绍暂不可用",""],"loading-game":["准备对话界面",""],game:["对话界面",""],"game-empty":["新会话尚无消息","首轮完成后会自动显示对话界面"],"guest-waiting":["等待房主模型输出",""],"guest-syncing":["正在同步本轮记录",""],"logged-out":["尚未登录",""]
};

function friendlyError(error){return String(error?.message||error||"操作失败").replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i,"")}
function toast(message){const element=document.querySelector("#toast");element.textContent=message;element.classList.add("show");clearTimeout(toast.timer);toast.timer=setTimeout(()=>element.classList.remove("show"),3200)}
function confirmAction(message,{title="确认操作",acceptText="继续"}={}){
  return api.confirmAction({message,title,acceptText}).catch(error=>{toast(friendlyError(error));return false});
}
function playMemberJoinSound(){
  try{
    notificationAudioContext ||= new (window.AudioContext||window.webkitAudioContext)();
    const context=notificationAudioContext;
    void context.resume?.();
    const gain=context.createGain();
    gain.gain.setValueAtTime(.0001,context.currentTime);
    gain.gain.exponentialRampToValueAtTime(.08,context.currentTime+.015);
    gain.gain.exponentialRampToValueAtTime(.0001,context.currentTime+.34);
    gain.connect(context.destination);
    for(const [frequency,delay] of [[660,0],[880,.12]]){
      const oscillator=context.createOscillator();oscillator.type="sine";oscillator.frequency.value=frequency;oscillator.connect(gain);oscillator.start(context.currentTime+delay);oscillator.stop(context.currentTime+delay+.18);
    }
  }catch{}
}
function showMemberJoinedTip(member){
  const stack=document.querySelector("#member-tip-stack");
  const tip=document.createElement("div");tip.className="member-tip";
  const copy=document.createElement("div");
  const title=document.createElement("b");title.textContent="新成员加入";
  const name=document.createElement("small");name.textContent=member?.displayName||member?.platformName||"新成员";
  copy.append(title,name);tip.append(copy);stack.append(tip);
  requestAnimationFrame(()=>tip.classList.add("show"));
  setTimeout(()=>{tip.classList.remove("show");setTimeout(()=>tip.remove(),240)},2800);
  playMemberJoinSound();
}
function roundResultKey(next){const result=next?.room?.round?.lastResult;return result?`${next.room.id}:${result.round}:${result.completedAt||0}`:null}
function renderSurfaceButtons(next=state){
  const intro=document.querySelector("#show-intro");
  const game=document.querySelector("#show-game");
  intro.classList.toggle("active",["loading-intro","intro","intro-empty"].includes(next?.mode));
  game.classList.toggle("active",["loading-game","game","game-empty","guest-waiting","guest-syncing"].includes(next?.mode));
  game.classList.toggle("attention",Boolean(conversationAttentionKey));
}
function consumeStateEffects(next,previous){
  if(next.memberJoined)showMemberJoinedTip(next.memberJoined);
  if(next.removedFromRoom)toast(next.removedFromRoom.message||"你已被房主移出房间");
  if(next.roomClosed)toast(next.roomClosed.message||"房主已解散房间，你已退出当前房间");
  if(next.versionMismatch)toast("联机版本不一致，请在访客端更新风月联机工具后重试");
  const key=roundResultKey(next);
  if(previous?.room?.id&&previous.room.id===next.room?.id&&key&&key!==lastObservedResultKey){
    const guestReady=next.room?.role!=="guest"||Boolean(next.roundSyncLocalCompleted)||previous.mode==="guest-syncing";
    if(guestReady)conversationAttentionKey=key;
  }
  if(previous?.room?.id!==next.room?.id)conversationAttentionKey=null;
  lastObservedResultKey=key;
}
async function invoke(action){try{return await action()}catch(error){toast(friendlyError(error));throw error}}
function syncSurfaceBounds(){if(activePage!=="multiplayer")return;clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{const rect=slot.getBoundingClientRect();const bounds={x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)};const key=`${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;if(key===lastSurfaceBoundsKey)return;lastSurfaceBoundsKey=key;api.setBounds(bounds)},40)}
function gamePoint(event){
  if(!latestGameFrame?.width||!latestGameFrame?.height)return null;
  const rect=gameFrame.getBoundingClientRect();
  const scale=Math.min(rect.width/latestGameFrame.width,rect.height/latestGameFrame.height);
  const width=latestGameFrame.width*scale;
  const height=latestGameFrame.height*scale;
  const left=rect.left+(rect.width-width)/2;
  const top=rect.bottom-height;
  if(event.clientX<left||event.clientX>left+width||event.clientY<top||event.clientY>top+height)return null;
  return {x:(event.clientX-left)/scale,y:(event.clientY-top)/scale};
}
function enqueueGameInput(action){gameInputQueue=gameInputQueue.then(action,action);return gameInputQueue}
function drawGameFrame(bitmap,width,height){
  const rect=gameFrame.getBoundingClientRect();
  const pixelRatio=Math.max(1,window.devicePixelRatio||1);
  const canvasWidth=Math.max(1,Math.round(rect.width*pixelRatio));
  const canvasHeight=Math.max(1,Math.round(rect.height*pixelRatio));
  if(gameFrame.width!==canvasWidth)gameFrame.width=canvasWidth;
  if(gameFrame.height!==canvasHeight)gameFrame.height=canvasHeight;
  const context=gameFrameContext;
  if(!context)return;
  context.fillStyle="#10151d";
  context.fillRect(0,0,canvasWidth,canvasHeight);
  const scale=Math.min(rect.width/width,rect.height/height);
  const drawWidth=width*scale*pixelRatio;
  const drawHeight=height*scale*pixelRatio;
  const drawX=(rect.width-width*scale)*pixelRatio/2;
  const drawY=(rect.height-height*scale)*pixelRatio;
  context.drawImage(bitmap,drawX,drawY,drawWidth,drawHeight);
}
function resetGameFrame(){
  gameFrameGeneration+=1;
  pendingGameFrame=null;
  latestGameFrame=null;
  hasGameFrame=false;
  gameFrameContext?.clearRect(0,0,gameFrame.width,gameFrame.height);
  gameFrame.classList.add("hidden");
}
async function drainGameFrames(){
  if(gameFrameDecodeBusy)return;
  gameFrameDecodeBusy=true;
  try{
    while(pendingGameFrame){
      const frame=pendingGameFrame;
      pendingGameFrame=null;
      const generation=gameFrameGeneration;
      const bytes=frame.bytes instanceof Uint8Array?frame.bytes:new Uint8Array(frame.bytes||[]);
      if(!bytes.byteLength)continue;
      const bitmap=await createImageBitmap(new Blob([bytes],{type:frame.mimeType||"image/jpeg"}));
      if(generation!==gameFrameGeneration||state?.backgroundPages?.gamePresentationAllowed===false){bitmap.close?.();continue}
      const width=Number(frame.width)||bitmap.width;
      const height=Number(frame.height)||bitmap.height;
      latestGameFrame={width,height};
      drawGameFrame(bitmap,width,height);
      bitmap.close?.();
      hasGameFrame=true;
      if(["loading-game","game","game-empty","guest-waiting","guest-syncing"].includes(state?.mode)){
        gameFrame.classList.remove("hidden");
        placeholder.classList.add("hidden");
      }
    }
  }catch(error){console.warn("对话画面解码失败",error)}
  finally{gameFrameDecodeBusy=false;if(pendingGameFrame)void drainGameFrames()}
}
function showPage(page){
  activePage=page;
  homePage.classList.toggle("hidden",page!=="home");
  profilesPage.classList.toggle("hidden",page!=="profiles");
  onlineWorldPage.classList.toggle("hidden",page!=="online-world");
  multiplayerPage.classList.toggle("hidden",page!=="multiplayer");
  if(page==="multiplayer")syncSurfaceBounds();
}

function postOnlineWorldState(){
  if(!onlineWorldFrameReady||!onlineWorldState)return;
  const hostedState={...onlineWorldState,characterProfiles:state?.characterProfiles||{items:[],selectedId:null}};
  onlineWorldFrame.contentWindow?.postMessage({source:"fengyue-host",type:"state",state:hostedState},"*");
}

function onlineWorldGalleryCards(){
  return onlineWorldCards.map((card,index)=>({...card,demo:false,coverIndex:index%10}));
}

function selectedOnlineWorldProfile(){
  const id=document.querySelector("#online-world-profile")?.value||onlineWorldEnteredProfileId;
  return state?.characterProfiles?.items?.find(item=>item.id===id)||currentCharacterProfile();
}

function renderOnlineWorldProfileChoices(){
  const select=document.querySelector("#online-world-profile");
  if(!select)return;
  const items=state?.characterProfiles?.items||[];
  const previous=onlineWorldState?.localPreferences?.characterProfileId||onlineWorldEnteredProfileId||select.value||state?.characterProfiles?.selectedId;
  select.replaceChildren();
  if(!items.length){
    const option=document.createElement("option");option.value="";option.textContent="请先填写角色设定";select.append(option);
  }else for(const profile of items){
    const option=document.createElement("option");
    option.value=profile.id;option.textContent=profile.label||profile.displayName||"未命名设定";
    option.selected=profile.id===previous;select.append(option);
  }
  const ownPlayer=onlineWorldState?.world?.players?.[onlineWorldState?.account?.accountId];
  select.disabled=Boolean(ownPlayer);
  document.querySelector("#online-world-open").disabled=!items.length||!selectedOnlineWorldCardId;
}

function showOnlineWorldDetails(card){
  selectedOnlineWorldCardId=card.cardId;
  document.querySelector("#online-world-detail-title").textContent=card.title;
  document.querySelector("#online-world-detail").classList.remove("hidden");
  renderOnlineWorldProfileChoices();
  document.querySelector("#online-world-profile").focus();
}

function closeOnlineWorldDetails(){document.querySelector("#online-world-detail").classList.add("hidden")}

function renderOnlineWorldCards(library={}){
  library=library||{};
  onlineWorldCards=Array.isArray(library.cards)?library.cards:onlineWorldCards;
  if(library.activeCardId&&onlineWorldCards.some(card=>card.cardId===library.activeCardId))selectedOnlineWorldCardId=library.activeCardId;
  const grid=document.querySelector("#online-world-library-grid");
  grid.replaceChildren();
  for(const card of onlineWorldGalleryCards()){
    const button=document.createElement("button");
    button.type="button";button.className="online-world-card-tile";button.dataset.cardId=card.cardId;button.dataset.cover=String(card.coverIndex);button.setAttribute("aria-label",`查看《${card.title}》`);
    const cover=document.createElement("span");cover.className="online-world-cover";
    const mark=document.createElement("i");mark.className="online-world-cover-mark";mark.textContent=ONLINE_WORLD_COVER_MARKS[card.coverIndex]||"游";
    const series=document.createElement("small");series.textContent="ONLINE GAME WORLD";
    const title=document.createElement("strong");title.textContent=card.title;
    cover.append(mark,series,title);button.append(cover);
    button.addEventListener("click",()=>showOnlineWorldDetails(card));grid.append(button);
  }
  document.querySelector("#online-world-title").textContent="联机游戏";
  renderOnlineWorldProfileChoices();
}

function loadOnlineWorldProgram(next){
  const hash=next?.program?.digest||"builtin-preview";
  if(hash===onlineWorldProgramHash)return;
  onlineWorldProgramHash=hash;
  onlineWorldFrameReady=false;
  if(onlineWorldProgramUrl){URL.revokeObjectURL(onlineWorldProgramUrl);onlineWorldProgramUrl=null}
  if(next?.programHtml){
    onlineWorldProgramUrl=URL.createObjectURL(new Blob([next.programHtml],{type:"text/html;charset=utf-8"}));
    onlineWorldFrame.src=onlineWorldProgramUrl;
  }else onlineWorldFrame.src="online-world/grid-conquest/index.html";
}

function followOnlineWorldMigration(next){
  const migration=next?.migration;
  if(!migration?.url||migration.workId===next?.work?.id||onlineWorldMigrationTarget===migration.workId)return;
  onlineWorldMigrationTarget=migration.workId;
  setTimeout(async()=>{
    try{
      const profile=selectedOnlineWorldProfile();
      const migrated=await api.followOnlineWorldMigration({displayName:profile?.displayName||state?.account?.username||"玩家",orientation:"any"});
      renderOnlineWorldCards(await api.listOnlineWorldCards());
      renderOnlineWorld(migrated);toast("游戏卡已按照作者签名指令迁移到新作品");
    }catch(error){toast(`游戏卡迁移地址暂时不可用：${friendlyError(error)}`)}
  },500);
}

function renderOnlineWorld(next){
  const wasInitialized=Boolean(onlineWorldState?.initialized);
  onlineWorldState=next;
  if(!wasInitialized&&next?.initialized)onlineWorldInLibrary=false;
  loadOnlineWorldProgram(next);
  const status=document.querySelector("#online-world-status");
  const serverOwner=Boolean(next?.isServerOwner||next?.isAuthor);
  const messages={closed:"尚未打开游戏卡",opening:"正在读取伴生作品",syncing:"正在同步评论账本",ready:`已同步 · 修订 ${next?.revision||0}`,"needs-initialization":serverOwner?"已确认服主身份 · 可以开服":"等待服主开服",degraded:"使用缓存，等待重新同步",error:"读取失败"};
  status.textContent=next?.syncing?messages.syncing:(messages[next?.status]||next?.status||messages.closed);
  const initialized=Boolean(next?.initialized);
  const gameVisible=(initialized||serverOwner)&&!onlineWorldInLibrary;
  onlineWorldPage.classList.toggle("game-active",gameVisible);
  settingsToggle.classList.toggle("hidden",gameVisible);
  document.querySelector("#online-world-setup").classList.toggle("hidden",gameVisible);
  onlineWorldFrame.classList.toggle("hidden",!gameVisible);
  document.querySelector(".online-world-toolbar").classList.toggle("hidden",gameVisible);
  const initializeButton=document.querySelector("#online-world-initialize");
  initializeButton.classList.toggle("hidden",!serverOwner||initialized);
  initializeButton.disabled=!["work-description","card-package"].includes(next?.program?.source);
  initializeButton.title=serverOwner?"平台伴生作品作者专用：创建首个在线赛季":"";
  document.querySelector("#online-world-activate-program").classList.toggle("hidden",!serverOwner||!initialized);
  document.querySelector("#online-world-export-card").classList.toggle("hidden",!serverOwner||!next?.work);
  document.querySelector("#online-world-migrate").classList.toggle("hidden",!serverOwner||!initialized);
  document.querySelector("#online-world-title").textContent=next?.work?(next?.card?.title||"猎艳疆土"):"联机游戏";
  renderOnlineWorldProfileChoices();
  postOnlineWorldState();
  followOnlineWorldMigration(next);
}

async function setSettingsOpen(open){
  const next=Boolean(open);
  if(next===settingsOpen)return;
  settingsOpen=next;
  settingsToggle.setAttribute("aria-expanded",next?"true":"false");
  settingsToggle.setAttribute("aria-label",next?"关闭设置":"打开设置");
  if(next){
    await api.setSettingsVisible(true);
    settingsPopover.classList.toggle("hidden",!settingsOverlayMode);
    if(!domainDirectory)await refreshDomains(false);
    if(settingsOverlayMode)document.querySelector("#settings-close").focus();
  }else{
    settingsPopover.classList.add("hidden");
    await api.setSettingsVisible(false);
  }
}

function currentCharacterProfile(next=state){
  const profiles=next?.characterProfiles;
  return profiles?.items?.find(item=>item.id===profiles.selectedId)||profiles?.items?.[0]||null;
}

function fillProfileEditor(profile){
  if(!profile)return;
  profileEditorId=profile.id;
  document.querySelector("#profile-editor-label").value=profile.label||"";
  document.querySelector("#profile-editor-name").value=profile.displayName||"";
  document.querySelector("#profile-editor-basic-info").value=profile.basicInfo??profile.info??"";
  document.querySelector("#profile-editor-appearance").value=profile.appearance||"";
  profileEditorDirty=false;
}

function renderCharacterProfiles(next){
  const profiles=next.characterProfiles||{items:[],selectedId:null};
  const selected=currentCharacterProfile(next);
  const activeSelect=document.querySelector("#active-character-profile");
  const editorSelect=document.querySelector("#profiles-list");
  for(const select of [activeSelect,editorSelect]){
    const previous=select===editorSelect?(profileEditorId||profiles.selectedId):profiles.selectedId;
    select.replaceChildren();
    for(const item of profiles.items||[]){
      const option=document.createElement("option");
      option.value=item.id;option.textContent=`${item.id===profiles.selectedId?"● ":""}${item.label||item.displayName||"未命名设定"}`;
      option.selected=item.id===previous;select.append(option);
    }
    select.disabled=Boolean(next.room);
  }
  document.querySelector("#display-name").value=selected?.displayName||"";
  document.querySelector("#profile-basic-info").value=selected?.basicInfo??selected?.info??"";
  document.querySelector("#profile-appearance").value=selected?.appearance||"";
  if(!profileEditorDirty&&(profileEditorId!==editorSelect.value||!profileEditorId))fillProfileEditor((profiles.items||[]).find(item=>item.id===editorSelect.value)||selected);
  document.querySelector("#profile-delete").disabled=Boolean(next.room)||(profiles.items||[]).length<=1;
  document.querySelector("#profile-new").disabled=Boolean(next.room);
  document.querySelector("#profile-save").disabled=Boolean(next.room);
  const needsSetup=!(profiles.items||[]).some(item=>String(item.displayName||"").trim());
  const editProfiles=document.querySelector("#edit-profiles");
  editProfiles.classList.toggle("needs-attention",needsSetup);
  editProfiles.setAttribute("aria-label",needsSetup?"编辑个人设定，首次联机前需要完成":"编辑个人设定");
  document.querySelector("#edit-profiles-note").textContent=needsSetup?"首次联机前，请先完善角色资料":"管理联机角色资料";
  renderOnlineWorldProfileChoices();
}

function sortedDomains(){
  return [...(domainDirectory?.domains||[])].sort((left,right)=>{
    const selected=value=>Boolean(state?.domainSelected&&(state.origin===value.origin||state.origin===value.finalOrigin));
    if(selected(left)!==selected(right))return selected(left)?-1:1;
    const stateRank=value=>value===true?0:value===false?2:1;
    if(stateRank(left.online)!==stateRank(right.online))return stateRank(left.online)-stateRank(right.online);
    return Number(left.latency??Number.MAX_SAFE_INTEGER)-Number(right.latency??Number.MAX_SAFE_INTEGER);
  });
}

function createDomainOption(item,{settings=false}={}){
  const button=document.createElement("button");
  button.type="button";
  button.className="domain-option";
  const selected=Boolean(state?.domainSelected&&(state.origin===item.origin||state.origin===item.finalOrigin));
  button.classList.toggle("selected",selected);
  button.classList.toggle("current",settings&&selected);
  button.disabled=automaticLoginActive||Boolean(state?.loginInProgress)||(settings?(selected||Boolean(state?.room)):Boolean(state?.originLocked));
  button.title=item.online===false?"后台检测未连通；如果浏览器可以打开该节点，仍可直接尝试":"";
  const name=document.createElement("b");
  name.textContent=new URL(item.origin).host;
  const status=document.createElement("span");
  status.className=item.online===true?"online":item.online===false?"offline":"pending";
  status.textContent=item.online===true?`${item.latency} ms`:item.online===false?"检测失败":"待检测";
  button.append(name,status);
  if(settings){
    button.addEventListener("click",async()=>{
      if(button.disabled)return;
      if(state?.loggedIn){
        const confirmed=await confirmAction(`切换到 ${name.textContent} 会登出当前账号，并返回登录界面。`,{title:"切换节点",acceptText:"切换并登出"});
        if(!confirmed)return;
      }
      invoke(async()=>{
        const next=await api.switchOrigin(item.origin);
        render(next);
        await setSettingsOpen(false);
        showPage("home");
        toast(`已切换节点：${new URL(next.origin).host}`);
      }).catch(()=>{});
    });
  }else{
    button.addEventListener("click",()=>invoke(async()=>{const next=await api.setOrigin(item.origin);render(next);toast(`已选择登录域名：${new URL(next.origin).host}`)}).catch(()=>{}));
  }
  return button;
}

function fillDomainList(target,{settings=false}={}){
  target.replaceChildren();
  for(const item of sortedDomains())target.append(createDomainOption(item,{settings}));
  if(!target.children.length){const empty=document.createElement("span");empty.textContent="域名目录暂时没有返回节点";target.append(empty)}
  if(domainDirectory?.directoryError){const warning=document.createElement("span");warning.className="domain-directory-error";warning.textContent=`目录读取失败：${domainDirectory.directoryError}`;target.append(warning)}
}

function renderDomainList(){
  if(!domainDirectory)return;
  fillDomainList(domainList);
  fillDomainList(settingsDomainList,{settings:true});
}

function renderDomainNote(next=state){
  if(!next)return;
  domainNote.textContent=(next.domainSelected?`${next.originLocked?"本次会话已锁定":"当前选择"}：${new URL(next.origin).host}`:"请选择节点后登录")+(domainDirectory?.probing?" · 延迟正在后台检测":"");
}

async function refreshDomains(force=false){
  const refreshButtons=[document.querySelector("#refresh-domains"),document.querySelector("#settings-refresh-domains")];
  for(const refresh of refreshButtons){refresh.disabled=true;refresh.textContent="检测中…"}
  if(domainDirectory){domainDirectory={...domainDirectory,probing:true};renderDomainList();renderDomainNote()}
  else{
    domainList.innerHTML="<span>正在读取节点列表…</span>";
    settingsDomainList.innerHTML="<span>正在读取节点列表…</span>";
  }
  try{
    domainDirectory=await api.listDomains(force);
    if(!state?.domainSelected&&!state?.originLocked&&!state?.loginInProgress){
      const fastest=sortedDomains().find(item=>item.online&&Number.isFinite(Number(item.latency)));
      if(fastest){
        const next=await api.setOrigin(fastest.origin);
        render(next);
      }
    }
    renderDomainList();
    renderDomainNote();
  }catch(error){
    if(domainDirectory){domainDirectory={...domainDirectory,probing:false,directoryError:friendlyError(error)};renderDomainList();renderDomainNote()}
    throw error;
  }
  finally{
    refreshButtons[0].disabled=Boolean(state?.originLocked);
    refreshButtons[1].disabled=Boolean(state?.loginInProgress);
    for(const refresh of refreshButtons)refresh.textContent="重新检测";
  }
}

function render(next){
  state=next;
  renderReleaseVerificationResult(next);
  if(next.uiTheme&&next.uiTheme!==uiTheme)uiTheme=applyUiTheme(next.uiTheme,{persist:true,syncBackend:false});
  settingsOpen=Boolean(next.settingsVisible);
  settingsToggle.setAttribute("aria-expanded",settingsOpen?"true":"false");
  settingsToggle.setAttribute("aria-label",settingsOpen?"关闭设置":"打开设置");
  settingsPopover.classList.toggle("hidden",!settingsOverlayMode||!settingsOpen);
  document.querySelector("#settings-account").textContent=next.loggedIn?(next.account?.username||"已登录账号"):"未登录";
  document.querySelector("#settings-current-node").textContent=next.domainSelected?`当前节点：${new URL(next.origin).host}`:"尚未选择节点";
  document.querySelector("#settings-logout").disabled=!next.loggedIn||Boolean(next.room)||Boolean(next.loginInProgress);
  document.querySelector("#settings-logout").title=next.room?"请先退出或关闭当前房间":"";
  if(domainDirectory)renderDomainList();
  document.querySelectorAll("[data-admin-only]").forEach(element=>element.classList.toggle("hidden",!next.isAdmin));
  const activeAdminTab=document.querySelector('[data-tab].active[data-admin-only]');
  if(!next.isAdmin&&activeAdminTab)activateSidebarTab("room");
  if(next.isAdmin)loadAdminLogs();
  else if(adminLogsLoaded||sessionLogEntries.size){adminLogsLoaded=false;sessionLogEntries.clear();renderSessionLogs()}
  const requiresLogin=!next.loggedIn;
  if(requiresLogin&&activePage!=="home")showPage("home");
  loginPanel.classList.toggle("hidden",!requiresLogin);
  document.querySelector("#home-actions-panel").classList.toggle("hidden",requiresLogin);
  document.querySelector("#enter-multiplayer").disabled=requiresLogin;
  document.querySelector("#enter-online-world").disabled=requiresLogin;
  document.querySelector("#edit-profiles").disabled=requiresLogin;
  document.querySelector("#profile-label").textContent=`账号实例 · ${next.profileId}`;
  document.querySelector("#account-status").textContent=next.loginInProgress?"正在登录":next.loggedIn?"账号已登录":"账号未登录";
  document.querySelector("#status-dot").className=`status-dot ${next.loggedIn?"online":"offline"}`;
  const username=next.account?.username||"—";
  const points=next.account?.points??"—";
  const level=next.account?.level;
  const levelReady=level!=null&&Number.isFinite(Number(level));
  const multiplayerEligible=levelReady&&Number(level)>=2;
  document.querySelector("#platform-username").textContent=username;
  document.querySelector("#platform-points").textContent=points;
  document.querySelector("#platform-level").textContent=levelReady?`${level} 级`:next.loggedIn?"获取中":"—";
  const levelWarning=document.querySelector("#level-warning");
  levelWarning.classList.toggle("hidden",!next.loggedIn||multiplayerEligible);
  levelWarning.textContent=levelReady?`当前账号为 ${level} 级，联机功能要求至少达到 2 级。`:"正在读取账号等级；完成前暂时不能创建或加入房间。";
  document.querySelector("#platform-name").value=next.account?.username||"";
  renderCharacterProfiles(next);
  const copy=labels[next.mode]||["工具界面",""];
  document.body.classList.toggle("work-selector-active",next.mode==="selector");
  document.querySelector("#work-selector-tip").classList.toggle("hidden",next.mode!=="selector");
  document.querySelector("#stage-title").textContent=copy[0];
  document.querySelector("#stage-subtitle").textContent=copy[1];
  document.querySelector("#stage-subtitle").classList.toggle("hidden",!copy[1]);
  const canSelectWork=Boolean(next.loggedIn&&!next.work&&!next.room&&next.mode!=="selector");
  slot.classList.toggle("select-work-empty",canSelectWork);
  slot.tabIndex=canSelectWork?0:-1;
  if(canSelectWork){slot.setAttribute("role","button");slot.setAttribute("aria-label","点击此处选择作品")}
  else{slot.removeAttribute("role");slot.removeAttribute("aria-label")}
  document.querySelector("#placeholder-title").textContent=canSelectWork?"点击此处选择作品":copy[0];
  document.querySelector("#placeholder-copy").textContent=copy[1];
  document.querySelector("#choose-work").disabled=!next.loggedIn||Boolean(next.room);
  document.querySelector("#choose-work").title=next.room?"房间开启期间不能更换作品":"";
  document.querySelector("#work-title").textContent=next.work?.title||"尚未选择";
  document.querySelector("#work-suffix").textContent=next.work?.suffix||"—";
  renderModelSelector(next);
  renderPluginPanel(next);
  renderWorkSettings(next);
  const conversationCard=document.querySelector("#conversation-card");
  const conversationList=document.querySelector("#conversation-list");
  const conversation=next.conversation||{};
  conversationCard.classList.toggle("hidden",!next.work);
  document.querySelector("#conversation-name").textContent=conversation.activeName||"请选择会话，或新建会话";
  conversationList.replaceChildren();
  if((conversation.items||[]).some(item=>item.id)&&!conversation.activeName){
    const prompt=document.createElement("option");prompt.value="";prompt.textContent="— 请选择一个平台会话 —";prompt.disabled=true;prompt.selected=true;conversationList.append(prompt);
  }
  for(const item of conversation.items||[]){
    const option=document.createElement("option");
    option.value=item.id||"";
    option.textContent=`${item.active?"● ":""}${item.name}`;
    option.disabled=!item.id;
    option.selected=Boolean(item.active);
    conversationList.append(option);
  }
  if(!conversationList.children.length){const option=document.createElement("option");option.value="";option.textContent="此作品暂无可读取的会话";conversationList.append(option)}
  const saveLocked=Boolean(next.room)||Boolean(next.conversationBusy)||!next.work;
  conversationList.disabled=saveLocked||!(conversation.items||[]).some(item=>item.id);
  const refreshButton=document.querySelector("#refresh-conversations");
  const newButton=document.querySelector("#new-conversation");
  refreshButton.disabled=Boolean(next.conversationBusy)||!next.work;
  newButton.disabled=Boolean(next.conversationBusy)||!next.work||Boolean(next.room);
  refreshButton.textContent=next.conversationOperation==="refresh"?"读取中…":"刷新会话";
  newButton.textContent=next.conversationOperation==="new"?"新建中…":"新建会话";
  const selectedConversationId=conversationList.value;
  for(const id of ["rename-conversation","delete-conversation"]){
    const button=document.querySelector(`#${id}`);
    button.disabled=saveLocked||!selectedConversationId;
    button.title=next.room?"请先退出房间再管理会话":"直接修改平台会话";
  }
  if(conversationRenameTarget&&(next.room||conversationRenameTarget.id!==selectedConversationId||conversationRenameTarget.work!==next.work?.suffix)){
    conversationRenameTarget=null;
    document.querySelector("#conversation-rename-form").classList.add("hidden");
  }
  document.querySelector("#save-conversation-rename").disabled=saveLocked;
  const conversationCount=`已读取 ${(conversation.items||[]).length} 个平台会话`;
  document.querySelector("#conversation-note").textContent=conversationCount;
  const adapterCard=document.querySelector("#prefix-adapter-card");
  const adapterButton=document.querySelector("#adapt-work-prefix");
  const adapterStatus=document.querySelector("#prefix-adapter-status");
  const adapterNote=document.querySelector("#prefix-adapter-note");
  const adapterSummaryState=document.querySelector("#prefix-adapter-summary-state");
  const adapter=next.prefixAdapter;
  adapterButton.disabled=!next.work||Boolean(next.room)||Boolean(next.conversationBusy)||adapter?.status==="adapting";
  adapterButton.title=!next.work?"选择作品后即可使用":next.room?"请在创建或加入房间之前完成适配":"";
  adapterSummaryState.className=!next.work?"":adapter?.status==="error"?"error":adapter?.status==="adapting"?"running":adapter?.status==="ready"?"active":"";
  adapterSummaryState.textContent=!next.work?"等待选择作品":adapter?.status==="adapting"?"适配中":adapter?.status==="ready"?"当前对话已适配":adapter?.status==="error"?"适配失败":adapter?.needsUpdate?"需重新适配":"待适配";
  if(next.work&&["adapting","error"].includes(adapter?.status))adapterCard.open=true;
  adapterButton.textContent=!next.work?"请先选择作品":adapter?.status==="adapting"?"正在进行适配":adapter?.status==="ready"?"重新适配并替换":"一键适配联机前置词";
  if(!next.work){
    adapterStatus.textContent="请先选择作品";
    adapterNote.textContent="选择作品后可读取已有会话并生成专属联机前置词。此操作需要消耗积分。";
  }else if(adapter?.status==="adapting"){
    adapterStatus.textContent="正在进行适配";
    adapterNote.textContent="";
  }else if(adapter?.status==="ready"){
    adapterStatus.textContent="当前对话已适配";
    adapterNote.textContent="适配前置词写入会话配置，不修改作品的全局前置词。";
  }else if(adapter?.status==="error"){
    adapterStatus.textContent="本次适配失败，原有结果未被替换";
    adapterNote.textContent=adapter.error||"请检查网络、积分和已有会话后重试。";
  }else if(adapter?.needsUpdate){
    adapterStatus.textContent="旧版适配规则需重新生成";
    adapterNote.textContent="当前使用新版通用前置词；更新适配器作品提示词后重新适配，将只替换名单和状态的格式规则。";
  }else{
    adapterStatus.textContent="当前对话尚未适配";
    adapterNote.textContent="需要消耗积分，并且当前作品至少已有一个包含 AI 回复的会话。只提交各会话最后一段 AI 回复用于分析。";
  }
  const gameVisibleModes=["loading-game","game","game-empty","guest-waiting","guest-syncing"];
  const presentationAllowed=next.backgroundPages?.gamePresentationAllowed!==false;
  if(!presentationAllowed&&hasGameFrame)resetGameFrame();
  const liveGame=Boolean(presentationAllowed&&next.backgroundPages?.liveGameView&&next.backgroundPages?.gameReady);
  const capturedGame=presentationAllowed&&gameVisibleModes.includes(next.mode)&&(liveGame||hasGameFrame);
  gameFrame.classList.toggle("hidden",!presentationAllowed||!gameVisibleModes.includes(next.mode)||!hasGameFrame);
  placeholder.classList.toggle("hidden",capturedGame);
  renderSurfaceButtons(next);
  const releaseReady=Boolean(next.releaseSecurity?.verified);
  submitLogin.disabled=automaticLoginActive||Boolean(next.loginInProgress)||!releaseReady||(!autoLoginInput.checked&&!next.domainSelected);
  submitLogin.textContent=automaticLoginActive?"自动登录中…":next.loginInProgress?"登录中…":"登录";
  document.querySelector("#google-login").disabled=Boolean(next.loginInProgress)||!releaseReady||!next.domainSelected;
  document.querySelector("#telegram-login").disabled=Boolean(next.loginInProgress)||!releaseReady||!next.domainSelected;
  document.querySelector("#refresh-domains").disabled=Boolean(next.originLocked);
  renderDomainNote(next);
  renderDomainList();
  const roomSetup=document.querySelector("#room-setup");
  const joinSetup=document.querySelector("#join-setup");
  const roomCard=document.querySelector("#room-status-card");
  const invitePanel=document.querySelector("#invite-link-panel");
  roomCard.classList.toggle("hidden",!next.room);
  document.querySelector("#create-room").disabled=Boolean(next.room)||(next.loggedIn&&!multiplayerEligible);
  document.querySelector("#join-room").disabled=Boolean(next.room)||(next.loggedIn&&!multiplayerEligible);
  document.querySelector("#create-room").title=next.loggedIn&&!multiplayerEligible?"联机功能需要账号达到 2 级":"";
  document.querySelector("#join-room").title=next.loggedIn&&!multiplayerEligible?"联机功能需要账号达到 2 级":"";
  if(next.room){
    roomSetup.classList.add("hidden");
    joinSetup.classList.add("hidden");
    document.querySelector("#room-status-label").textContent=next.room.role==="host"?"等待成员加入":next.room.status==="joining"?"正在加入":"已加入房间";
    document.querySelector("#room-id").textContent=next.room.status==="joining"?"正在加入":next.room.status==="join-error"?"加入房间失败":`房间 ${next.room.id}`;
    const round=next.room.round;
    const lastResultCopy=round?.lastResult?` · 上轮 ${round.lastResult.model||"未知模型"} / ${round.lastResult.points?.total??0} 积分`:"";
    const roundStage=round?.status==="processing-input"?" · 插件正在处理输入":round?.status==="generating"?" · 模型生成中":round?.status==="processing-output"?" · 插件正在处理输出":round?.status==="syncing"?round.resultAckTotal?` · 访客同步回执 ${round.resultAckCount}/${round.resultAckTotal}`:" · 等待房主开放下一轮":round?.error?` · 上次失败：${round.error}`:"";
    const roundCopy=round?` · 第 ${round.number} 轮 ${round.readyCount}/${round.totalCount} 已确认${roundStage}${lastResultCopy}`:"";
    const saveCopy=` · 会话：${next.room.save?.name||"新的对话"}`;
    const history=next.room.historySync;
    const historyCopy=next.room.role!=="guest"||!history||history.status==="ready"?"":history.status==="announcing"?" · 等待房主确认会话锚点":history.status==="error"?` · 会话锚定失败：${history.error||"未知错误"}`:" · 正在新建或恢复访客会话";
    const promptSync=next.room.promptSync;
    const promptCopy=next.room.role!=="host"||!promptSync?"":promptSync.status==="syncing"?" · 正在写入多人会话提示词":promptSync.status==="ready"?` · 多人提示词已同步（${promptSync.memberCount} 人）`:promptSync.status==="error"?` · 多人提示词失败：${promptSync.error||"未知错误"}`:" · 多人提示词将在首轮发送前写入";
    document.querySelector("#room-summary").textContent=next.room.error||`房主：${next.room.hostUsername} · ${next.room.work?.title||"已选作品"} · ${next.room.memberCount||1} 人${saveCopy}${historyCopy}${promptCopy}${roundCopy}`;
    invitePanel.classList.toggle("hidden",next.room.role!=="host"||!next.room.inviteUrl);
    document.querySelector("#room-invite-url").value=next.room.inviteUrl||"";
    document.querySelector("#leave-room").textContent=next.room.status==="join-error"?"退出并重新加入":next.room.role==="host"?"解散当前房间":"退出当前房间";
  }else{
    invitePanel.classList.add("hidden");
    document.querySelector("#room-invite-url").value="";
  }
  const tools=document.querySelector("#message-tools");
  const lastResult=next.room?.round?.lastResult;
  const showTools=next.room?.role==="host"&&Boolean(lastResult)&&!lastResult.deleted;
  tools.classList.toggle("hidden",!showTools);
  const operationLocked=next.messageOperationBusy||next.room?.round?.status!=="collecting"||Boolean(next.room?.round?.readyCount)||Boolean(lastResult?.deleted);
  for(const id of ["#refresh-latest","#edit-latest","#delete-latest"])document.querySelector(id).disabled=operationLocked;
  if(next.room?.round?.lastResult?.perspectiveSplit)document.querySelector("#edit-latest").disabled=true;
  document.querySelector("#edit-latest").title=next.room?.round?.lastResult?.perspectiveSplit?"独立视角记录请用刷新重新整理，以保留完整剧情原文":"";
  const editForm=document.querySelector("#message-edit-form");
  if(!showTools)editForm.classList.add("hidden");
  document.querySelector("#message-edit-value").disabled=operationLocked;
  document.querySelector("#confirm-message-edit").disabled=operationLocked;
  document.querySelector("#cancel-message-edit").disabled=Boolean(next.messageOperationBusy);
  const operation=next.room?.messageOperation;
  document.querySelector("#message-tool-note").textContent=operation?.status==="syncing"
    ? `${operation.action} 已写入房主，正在等待访客回执 ${operation.ackCount}/${operation.ackTotal}`
    : operation?.status==="error"
      ? `同步失败：${operation.error||"访客端操作失败"}`
      : operation?.status==="completed"
        ? "最近一次记录操作已在全体成员端完成。"
        : "仅房主可操作；访客会重试写入相同结果，刷新不会在访客端再次消耗积分。";
  const memberList=document.querySelector("#member-list");
  memberList.replaceChildren();
  const visibleMembers=(next.room?.members||[]).filter(member=>String(member.id)!==String(next.account?.accountId));
  if(visibleMembers.length){
    for(const member of visibleMembers){
      const card=document.createElement("div");
      card.className="member-card";
      const names=document.createElement("span");
      const display=document.createElement("b");
      const platform=document.createElement("small");
      display.textContent=member.displayName||"未命名玩家";
      platform.textContent=member.platformName?`平台：${member.platformName}`:"平台账号未知";
      const appearance=String(member.appearance||"").trim();
      names.append(display,platform);
      const actions=document.createElement("div");
      actions.className="member-actions";
      const badge=document.createElement("em");
      const ready=next.room.round?.readyNames?.includes(member.displayName);
      badge.textContent=member.historyStatus&&member.historyStatus!=="ready"?(member.historyStatus==="announcing"?"确认锚点中":"准备会话中"):ready?"本轮已确认":member.id===next.account?.accountId?"本机":"等待输入";
      actions.append(badge);
      if(next.room.role==="host"&&String(member.id)!==String(next.account?.accountId)){
        const remove=document.createElement("button");
        remove.type="button";remove.className="member-remove";remove.textContent="移出";
        const canRemove=next.room.round?.status==="collecting"&&!next.room.round?.readyCount&&next.room.promptSync?.status!=="syncing"&&!next.messageOperationBusy;
        remove.disabled=!canRemove;
        remove.title=canRemove?`将 ${member.displayName||member.platformName} 移出房间`:"本轮进行中，暂时不能移出成员";
        remove.addEventListener("click",async()=>{
          const confirmed=await confirmAction(`将“${member.displayName||member.platformName||"该成员"}”移出房间？`,{title:"移出成员",acceptText:"移出"});
          if(!confirmed)return;
          invoke(async()=>{const result=await api.removeRoomMember(member.id);toast(result.promptUpdated?"成员已移出房间":"成员已移出，提示词将在下一轮重新同步")}).catch(()=>{});
        });
        actions.append(remove);
      }
      card.append(names,actions);
      const appearanceKey=`${next.room.id}:${member.id}`;
      const details=document.createElement("details");details.className="member-appearance";
      details.open=expandedMemberAppearances.has(appearanceKey);
      const summary=document.createElement("summary");summary.textContent=`外貌信息 · ${[...appearance].length} 字`;
      const info=document.createElement("p");info.textContent=appearance||"尚未填写外貌信息";
      details.append(summary,info);
      details.addEventListener("toggle",()=>{if(!details.isConnected)return;if(details.open)expandedMemberAppearances.add(appearanceKey);else expandedMemberAppearances.delete(appearanceKey)});
      card.append(details);
      memberList.append(card);
    }
  }else{
    const empty=document.createElement("div");empty.className="empty-small";empty.textContent=next.room?"等待其他成员加入":"成员将在认证后显示在这里";memberList.append(empty);
  }
  renderRoomChat(next);
  const roundButton=document.querySelector("#submit-round");
  const roundInput=document.querySelector("#round-input");
  const ownMember=next.room?.members?.find(member=>member.id===next.account?.accountId);
  const ownReady=Boolean(ownMember&&next.room?.round?.readyNames?.includes(ownMember.displayName));
  const roundStatus=next.room?.round?.status;
  const historyReady=next.room?.role!=="guest"||next.room?.historySync?.status==="ready";
  roundButton.disabled=!next.room||next.room.status!=="waiting"||roundStatus!=="collecting"||ownReady||!historyReady;
  roundInput.disabled=!next.room||next.room.status!=="waiting"||roundStatus!=="collecting"||ownReady||!historyReady;
  roundButton.textContent=!historyReady?"正在准备会话锚点":ownReady?"本轮已确认":roundStatus==="processing-input"?"插件处理输入中":roundStatus==="generating"?"房主生成中":roundStatus==="processing-output"?"插件处理输出中":roundStatus==="syncing"?"同步记录中":roundStatus==="error"?"同步失败":"确认本轮输入";
  const flowStatus=document.querySelector("#round-flow-status");
  const flowCopy=activeConversationFlow(next);
  flowStatus.textContent=flowCopy;
  flowStatus.classList.toggle("hidden",!flowCopy);
  syncSurfaceBounds();
}

document.querySelector("#enter-multiplayer").addEventListener("click",()=>{if(!state?.loggedIn){toast("请先登录风月账号");return}showPage("multiplayer")});
document.querySelector("#enter-online-world").addEventListener("click",async()=>{
  if(!state?.loggedIn){toast("请先登录风月账号");return}
  onlineWorldInLibrary=true;showPage("online-world");
  try{renderOnlineWorldCards(await api.listOnlineWorldCards());renderOnlineWorld(await api.getOnlineWorldState())}catch(error){toast(friendlyError(error))}
});
document.querySelector("#online-world-import-card").addEventListener("click",()=>invoke(async()=>{
  const result=await api.importOnlineWorldCard();
  renderOnlineWorldCards(result);
  if(!result.canceled)toast(`已导入《${result.imported.title}》`);
}).catch(()=>{}));
document.querySelector("#online-world-detail").addEventListener("click",event=>{if(event.target===event.currentTarget)closeOnlineWorldDetails()});
document.addEventListener("keydown",event=>{if(event.key==="Escape"&&!document.querySelector("#online-world-detail").classList.contains("hidden"))closeOnlineWorldDetails()});
document.querySelector("#online-world-profile").addEventListener("change",renderOnlineWorldProfileChoices);
document.querySelector("#online-world-back").addEventListener("click",()=>{closeOnlineWorldDetails();showPage("home")});
document.querySelector("#online-world-open-form").addEventListener("submit",async event=>{
  event.preventDefault();
  const card=onlineWorldGalleryCards().find(item=>item.cardId===selectedOnlineWorldCardId);
  const profile=selectedOnlineWorldProfile();
  if(!card||!profile){toast("请先选择游戏卡和角色设定");return}
  if(card.demo){toast("这张展示游戏卡尚未附带可运行程序");return}
  onlineWorldEnteredProfileId=profile.id;
  const button=document.querySelector("#online-world-open");button.disabled=true;button.textContent="正在开始…";
  renderOnlineWorldProfileChoices();
  try{
    const next=await api.openOnlineWorld({cardId:card.cardId,characterProfileId:profile.id,displayName:profile.displayName||state?.account?.username||"玩家",orientation:"any"});
    closeOnlineWorldDetails();
    onlineWorldInLibrary=!next?.initialized&&!next?.isServerOwner;renderOnlineWorld(next);
  }catch(error){onlineWorldEnteredProfileId=null;renderOnlineWorld({...onlineWorldState,status:"error",error:friendlyError(error)});toast(friendlyError(error))}
  finally{button.textContent="开始游戏";renderOnlineWorldProfileChoices()}
});
document.querySelector("#online-world-export-card").addEventListener("click",()=>invoke(async()=>{
  const result=await api.exportOnlineWorldCard();
  renderOnlineWorldCards(await api.listOnlineWorldCards());
  if(!result.canceled)toast("完整游戏卡已导出，包含伴生作品创作页配置快照");
}).catch(()=>{}));
document.querySelector("#online-world-initialize").addEventListener("click",async()=>{
  if(!await confirmAction("这会以伴生作品作者作为服主，在评论区写入赛季控制记录和第一份地图快照。",{title:"服主开服",acceptText:"立即开服"}))return;
  invoke(async()=>{const next=await api.initializeOnlineWorld();onlineWorldInLibrary=false;renderOnlineWorld(next);toast("开服成功，在线赛季已经启动")}).catch(()=>{});
});
document.querySelector("#online-world-activate-program").addEventListener("click",async()=>{
  if(!await confirmAction("这会重新读取作品详细介绍，并用作者密钥签名启用其中的游戏程序包。",{title:"启用详情程序",acceptText:"签名启用"}))return;
  invoke(async()=>{renderOnlineWorld(await api.activateOnlineWorldProgram());toast("详情程序已经签名启用")}).catch(()=>{});
});
document.querySelector("#online-world-migrate").addEventListener("click",async()=>{
  if(!await confirmAction("这会导出当前作品配置、创建同配置的新作品并搬迁赛季账本；所有回读校验成功后，才会在旧作品评论区发布签名重置指令。",{title:"重置并迁移在线游戏卡",acceptText:"建立迁移作品"}))return;
  invoke(async()=>{const result=await api.migrateOnlineWorld();await api.copyText(result.url);toast(result.redirectPublished?"迁移配置已回读验证，地址已复制；发布新作品后即可完成切换":`迁移草稿地址已复制；${result.importError||"请在创作页补全配置"}`)}).catch(()=>{});
});
window.addEventListener("message",async event=>{
  if(event.source!==onlineWorldFrame.contentWindow||event.data?.source!=="fyow-grid-conquest")return;
  if(event.data.type==="ready"){
    onlineWorldFrameReady=true;
    if(!onlineWorldState)try{onlineWorldState=await api.getOnlineWorldState()}catch{}
    postOnlineWorldState();return;
  }
  if(event.data.type==="library"){
    onlineWorldInLibrary=true;closeOnlineWorldDetails();renderOnlineWorld(onlineWorldState);return;
  }
  if(event.data.type==="admin"){
    const command={...(event.data.command||{})};
    try{
      if(command.type==="open-server"){
        if(!await confirmAction("这会以伴生作品作者账号作为服主，在评论区发布赛季控制记录与第一份覆盖快照。",{title:"服主开服",acceptText:"立即开服"}))return;
        const next=await api.initializeOnlineWorld();onlineWorldInLibrary=false;renderOnlineWorld(next);
        onlineWorldFrame.contentWindow?.postMessage({source:"fengyue-host",type:"result",result:{admin:true,state:next}} ,"*");toast("开服成功");return;
      }
      if(command.type==="migrate-server"){
        if(!await confirmAction("这会复制伴生作品配置与公共地图，建立新作品，并在旧评论区发布作者签名的搬迁指令。",{title:"搬迁并重置服务器",acceptText:"开始搬迁"}))return;
        const result=await api.migrateOnlineWorld();await api.copyText(result.url);renderOnlineWorld(await api.getOnlineWorldState());
        onlineWorldFrame.contentWindow?.postMessage({source:"fengyue-host",type:"result",result:{admin:true,migration:result}},"*");
        toast(result.redirectPublished?"迁移完成，新作品地址已复制":"迁移草稿已建立，地址已复制");return;
      }
      const target=onlineWorldState?.world?.players?.[command.targetAccountId]||onlineWorldState?.world?.bans?.[command.targetAccountId];
      if(!target)throw new Error("请选择已存在的玩家");
      const label=`${target.displayName||command.targetAccountId}（风月账号 ${target.accountName||command.targetAccountId}）`;
      const copy=command.type==="player-reset"
        ? {text:`重置 ${label} 的玩家数据？该玩家会被移出本局，下次进入需要重新完成开局流程。`,title:"重置玩家数据",acceptText:"确认重置"}
        : command.type==="player-ban"
          ? {text:`封禁 ${label}？封禁记录会上传评论区，其所有游戏操作将被其他客户端忽略。`,title:"封禁玩家",acceptText:"确认封禁"}
          : {text:`解除 ${label} 的封禁？解除记录同样会由作者签名并上传评论区。`,title:"解除封禁",acceptText:"确认解封"};
      if(!await confirmAction(copy.text,{title:copy.title,acceptText:copy.acceptText}))return;
      const result=await api.administerOnlineWorld(command);
      if(result?.state)renderOnlineWorld(result.state);
      onlineWorldFrame.contentWindow?.postMessage({source:"fengyue-host",type:"result",result:{...result,admin:true}},"*");
      toast(command.type==="player-reset"?"玩家数据已重置":command.type==="player-ban"?"玩家已封禁":"玩家已解除封禁");
    }catch(error){onlineWorldFrame.contentWindow?.postMessage({source:"fengyue-host",type:"error",message:friendlyError(error)},"*")}
    return;
  }
  if(event.data.type==="direct"){
    try{
      const result=await api.sendOnlineWorldDirect(event.data.message||{});
      onlineWorldFrame.contentWindow?.postMessage({source:"fengyue-host",type:"result",result:{...result,direct:true}},"*");
    }catch(error){onlineWorldFrame.contentWindow?.postMessage({source:"fengyue-host",type:"error",message:friendlyError(error)},"*")}
    return;
  }
  if(event.data.type!=="intent")return;
  const intent={...(event.data.intent||{})};
  if(intent.type==="join"){
    const profile=(state?.characterProfiles?.items||[]).find(item=>item.id===intent.characterProfileId)||selectedOnlineWorldProfile();
    if(!profile){onlineWorldFrame.contentWindow?.postMessage({source:"fengyue-host",type:"error",message:"请选择角色设定"},"*");return}
    onlineWorldEnteredProfileId=profile.id;
    intent.characterProfileId=profile.id;
    intent.displayName=profile?.displayName||state?.account?.username||"玩家";
  }
  try{
    const result=await api.submitOnlineWorldIntent(intent);
    if(result?.state)renderOnlineWorld(result.state);
    onlineWorldFrame.contentWindow?.postMessage({source:"fengyue-host",type:"result",result},"*");
  }catch(error){onlineWorldFrame.contentWindow?.postMessage({source:"fengyue-host",type:"error",message:friendlyError(error)},"*")}
});
settingsToggle.addEventListener("click",()=>invoke(()=>setSettingsOpen(!settingsOpen)).catch(()=>{}));
document.querySelector("#settings-close").addEventListener("click",()=>invoke(()=>setSettingsOpen(false)).catch(()=>{}));
document.querySelectorAll("[data-theme-choice]").forEach(button=>button.addEventListener("click",()=>{uiTheme=applyUiTheme(button.dataset.themeChoice)}));
authorLinkButtons.forEach(button=>button.addEventListener("click",()=>{
  if(button.disabled)return;
  invoke(()=>api.openAuthorLink(button.dataset.authorLink)).catch(()=>{});
}));
document.querySelector("#settings-refresh-domains").addEventListener("click",()=>refreshDomains(true).catch(error=>toast(friendlyError(error))));
document.querySelector("#settings-logout").addEventListener("click",async()=>{
  if(!state?.loggedIn)return;
  const confirmed=await confirmAction("将退出当前节点的账号并返回登录界面，本机保存的账号密码不会被删除。",{title:"登出账号",acceptText:"确认登出"});
  if(!confirmed)return;
  invoke(async()=>{const next=await api.logout();render(next);await setSettingsOpen(false);showPage("home");toast("已退出当前账号")}).catch(()=>{});
});
document.addEventListener("pointerdown",event=>{
  if(!settingsOpen||settingsPopover.contains(event.target)||settingsToggle.contains(event.target))return;
  void setSettingsOpen(false).catch(error=>toast(friendlyError(error)));
});
document.querySelector("#edit-profiles").addEventListener("click",()=>{if(!state?.loggedIn){toast("请先登录风月账号");return}fillProfileEditor(currentCharacterProfile());showPage("profiles")});
document.querySelector("#profiles-back").addEventListener("click",()=>showPage("home"));
document.querySelector("#back-home").addEventListener("click",()=>invoke(async()=>{
  if(state?.room){
    const isHost=state.room.role==="host";
    const confirmed=await confirmAction(
      isHost?"返回主页将解散当前房间，所有访客都会收到解散通知并退出房间。":"返回主页将退出当前房间。",
      {title:"返回主页",acceptText:isHost?"解散并返回":"退出并返回"}
    );
    if(!confirmed)return;
    await api.leaveRoom();
    document.querySelector("#join-room-password").value="";
    toast(isHost?"房间已解散":"已退出当前房间");
  }
  await api.hidePlatform();
  showPage("home");
}).catch(()=>{}));
for(const id of ["#profile-editor-label","#profile-editor-name","#profile-editor-basic-info","#profile-editor-appearance"])document.querySelector(id).addEventListener("input",()=>{profileEditorDirty=true});
document.querySelector("#profiles-list").addEventListener("change",event=>{const profile=state?.characterProfiles?.items?.find(item=>item.id===event.currentTarget.value);if(profile)fillProfileEditor(profile)});
document.querySelector("#profile-new").addEventListener("click",()=>invoke(async()=>{profileEditorDirty=false;profileEditorId=null;await api.createCharacterProfile();toast("已创建新的本地角色设定")}).catch(()=>{}));
document.querySelector("#profile-save").addEventListener("click",()=>invoke(async()=>{const profile={id:profileEditorId,label:document.querySelector("#profile-editor-label").value,displayName:document.querySelector("#profile-editor-name").value,basicInfo:document.querySelector("#profile-editor-basic-info").value,appearance:document.querySelector("#profile-editor-appearance").value};profileEditorDirty=false;await api.saveCharacterProfile(profile);toast("角色设定已长期保存并设为当前")}).catch(()=>{profileEditorDirty=true}));
document.querySelector("#profile-delete").addEventListener("click",async()=>{if(!profileEditorId)return;if(!await confirmAction("确定删除这个本地角色设定吗？",{title:"删除角色设定",acceptText:"删除"}))return;invoke(async()=>{profileEditorDirty=false;await api.deleteCharacterProfile(profileEditorId);profileEditorId=null;toast("角色设定已删除")}).catch(()=>{})});
document.querySelector("#active-character-profile").addEventListener("change",event=>invoke(async()=>{await api.selectCharacterProfile(event.currentTarget.value);toast("已切换联机角色设定")}).catch(()=>{}));
document.querySelectorAll("[data-tab]").forEach(button=>button.addEventListener("click",()=>activateSidebarTab(button.dataset.tab)));
async function submitCredentials({automatic=autoLoginInput.checked}={}){
  const payload={account:accountInput.value,password:passwordInput.value,remember:rememberInput.checked,autoLogin:autoLoginInput.checked};
  if(automatic){
    rememberInput.checked=true;
    payload.remember=true;
    payload.autoLogin=true;
    automaticLoginActive=true;
    if(state)render(state);
  }
  try{
    if(automatic)await api.autoLogin(payload);
    else await api.login(payload);
    passwordInput.value="";
    toast(automatic?"已使用当前延迟最低的可用节点登录":"登录成功");
  }finally{
    if(automatic){automaticLoginActive=false;if(state)render(state)}
  }
}
loginForm.addEventListener("submit",event=>{event.preventDefault();invoke(()=>submitCredentials()).catch(()=>{})});
autoLoginInput.addEventListener("change",()=>{if(autoLoginInput.checked)rememberInput.checked=true;if(state)render(state)});
rememberInput.addEventListener("change",()=>{if(!rememberInput.checked)autoLoginInput.checked=false;if(state)render(state)});
officialNoticeOpen.addEventListener("click",()=>invoke(()=>api.openOfficialReleasePage()).catch(()=>{}));
officialNoticeAction.addEventListener("click",()=>{
  if(officialNoticeCard.dataset.mode==="announcement"){officialNoticeOverlay.classList.add("hidden");return}
  void api.quitApp();
});
document.querySelector("#google-login").addEventListener("click",()=>invoke(async()=>{await api.oauthLogin("google");toast("请在 Google 认证窗口中完成登录")}).catch(()=>{}));
document.querySelector("#telegram-login").addEventListener("click",()=>invoke(async()=>{await api.oauthLogin("telegram");toast("请在 Telegram 认证窗口中完成登录")}).catch(()=>{}));
document.querySelector("#clear-credentials").addEventListener("click",()=>invoke(async()=>{await api.clearCredentials();accountInput.value="";passwordInput.value="";rememberInput.checked=false;autoLoginInput.checked=false;toast("已清除这个实例保存的账号和密码")}).catch(()=>{}));
document.querySelector("#refresh-domains").addEventListener("click",()=>refreshDomains(true).catch(error=>toast(error?.message||String(error))));
document.querySelector("#choose-work").addEventListener("click",()=>state?.room?toast("房间开启期间不能更换作品；退出房间后会恢复"):invoke(()=>api.chooseWork()).catch(()=>{}));
slot.addEventListener("click",()=>{if(slot.classList.contains("select-work-empty"))invoke(()=>api.chooseWork()).catch(()=>{})});
slot.addEventListener("keydown",event=>{if(slot.classList.contains("select-work-empty")&&["Enter"," "].includes(event.key)){event.preventDefault();invoke(()=>api.chooseWork()).catch(()=>{})}});
document.querySelector("#refresh-work-settings").addEventListener("click",()=>invoke(async()=>{
  if(workSettingsDirty||memorySettingsDirty)throw new Error("有未保存的设置，请先保存再刷新");
  await api.refreshWorkSettings();
}).catch(()=>{}));
document.querySelector("#work-memory-count").addEventListener("input",()=>{memorySettingsDirty=true});
for(const id of ["work-global-prompt","work-global-prefix","work-global-postfix","work-global-extra"])document.getElementById(id).addEventListener("input",()=>{workSettingsDirty=true});
document.querySelector("#save-work-memory").addEventListener("click",()=>invoke(async()=>{
  const memoryCount=Number(document.querySelector("#work-memory-count").value);
  if(!Number.isSafeInteger(memoryCount)||memoryCount<0)throw new Error("记忆消息数量必须是非负整数");
  await api.updateWorkSettings({appId:workSettingsAppId,memoryCount});
  memorySettingsDirty=false;toast("记忆设定已保存");
}).catch(()=>{}));
document.querySelector("#save-work-global").addEventListener("click",()=>invoke(async()=>{
  let extra;
  try{extra=JSON.parse(document.querySelector("#work-global-extra").value)}catch{throw new Error("其他配置字段不是有效 JSON")}
  if(!extra||typeof extra!=="object"||Array.isArray(extra))throw new Error("其他配置字段必须是 JSON 对象");
  const global={...extra,pre_prompt:document.querySelector("#work-global-prompt").value,pre_text:document.querySelector("#work-global-prefix").value,post_text:document.querySelector("#work-global-postfix").value};
  await api.updateWorkSettings({appId:workSettingsAppId,expectedGlobal:workSettingsSnapshot,global});
  workSettingsDirty=false;if(state)renderWorkSettings(state);toast("全局配置已保存");
}).catch(()=>{}));
const perspectiveToggle=document.querySelector("#perspective-split-enabled");
perspectiveToggle.closest(".plugin-summary-toggle").addEventListener("click",event=>event.stopPropagation());
perspectiveToggle.addEventListener("change",()=>{
  const enabled=perspectiveToggle.checked;
  perspectiveToggle.disabled=true;
  invoke(async()=>{const result=await api.updatePluginSettings("perspective-split",{enabled});toast(enabled?(result?.prefixSync?.status==="deferred"?"已启用，选择作品后将在开局时写入前置词":"独立视角已启用，前置词已写入并确认"):"已停用，仅移除了独立视角前置词")}).catch(()=>{if(state)renderPerspectivePlugin(state)});
});
document.querySelector("#perspective-split-words").addEventListener("input",()=>{perspectiveEditorDirty=true});
document.querySelector("#save-perspective-split").addEventListener("click",()=>invoke(async()=>{
  const wordsPerPlayer=Number(document.querySelector("#perspective-split-words").value);
  if(!Number.isInteger(wordsPerPlayer)||wordsPerPlayer<100||wordsPerPlayer>10000)throw new Error("每人目标字数须为 100 到 10000 的整数");
  await api.updatePluginSettings("perspective-split",{settings:{wordsPerPlayer}});
  perspectiveEditorDirty=false;toast("字数已保存，启用时自动写入前置词");
}).catch(()=>{}));
document.querySelector("#refresh-conversations").addEventListener("click",()=>invoke(async()=>{await api.refreshConversations();toast("平台会话列表已刷新")}).catch(()=>{}));
document.querySelector("#conversation-list").addEventListener("change",event=>{const conversationId=event.currentTarget.value;if(!conversationId)return;invoke(async()=>{await api.selectConversation(conversationId);toast("已切换并长期锚定此平台会话")}).catch(()=>{})});
document.querySelector("#new-conversation").addEventListener("click",()=>invoke(async()=>{await api.newConversation();toast("已新建会话")}).catch(()=>{}));
document.querySelector("#rename-conversation").addEventListener("click",()=>{
  const id=document.querySelector("#conversation-list").value;
  const item=state?.conversation?.items?.find(item=>item.id===id);
  if(!item||state?.room)return;
  conversationRenameTarget={id,work:state.work.suffix};
  document.querySelector("#conversation-rename-value").value=item.name;
  document.querySelector("#conversation-rename-form").classList.remove("hidden");
  document.querySelector("#conversation-rename-value").focus();
});
document.querySelector("#cancel-conversation-rename").addEventListener("click",()=>{
  conversationRenameTarget=null;document.querySelector("#conversation-rename-form").classList.add("hidden");
});
document.querySelector("#conversation-rename-form").addEventListener("submit",event=>{
  event.preventDefault();const target=conversationRenameTarget;if(!target)return;
  invoke(async()=>{
    await api.renameConversation(target.id,document.querySelector("#conversation-rename-value").value);
    conversationRenameTarget=null;document.querySelector("#conversation-rename-form").classList.add("hidden");toast("平台会话已重命名");
  }).catch(()=>{});
});
document.querySelector("#delete-conversation").addEventListener("click",async()=>{
  const id=document.querySelector("#conversation-list").value;
  const item=state?.conversation?.items?.find(item=>item.id===id);
  const work=state?.work?.suffix;
  if(!item||state?.room)return;
  if(!await confirmAction(`删除平台会话“${item.name}”？其中的对话记录也将被删除，无法撤销。`,{title:"删除平台会话",acceptText:"删除"}))return;
  if(state?.work?.suffix!==work||state?.room)return;
  invoke(async()=>{await api.deleteConversation(id);toast("平台会话已删除")}).catch(()=>{});
});
document.querySelector("#adapt-work-prefix").addEventListener("click",async()=>{
  if(!state?.work){toast("请先选择需要适配的作品");return}
  if(state?.room){toast("请在创建或加入房间之前完成适配");return}
  const confirmed=await confirmAction("这将为当前对话生成专属适配前置词，写入会话配置，不修改作品的全局前置词。将消耗少量积分，重复使用会替换旧的适配规则，是否继续？",{title:"多人格式适配",acceptText:"继续"});
  if(!confirmed)return;
  invoke(async()=>{const result=await api.adaptWorkPrefix();toast(`联机前置词适配完成：分析 ${result.sampleCount} 个会话，消耗 ${result.points?.total??0} 积分`)}).catch(()=>{});
});
for(const id of ["#effect-judge-context","#effect-judge-degrees","#effect-judge-faces","#effect-judge-style-preset","#effect-judge-style"]){
  document.querySelector(id).addEventListener("input",()=>{pluginEditorDirty=true});
}
document.querySelector("#effect-judge-faces").addEventListener("input",event=>{
  const dieFaces=Math.max(6,Math.min(20,Number(event.currentTarget.value)||10));
  const degrees=document.querySelector("#effect-judge-degrees");
  degrees.max=String(dieFaces-2);
  if(Number(degrees.value)>dieFaces-2)degrees.value=String(dieFaces-2);
});
const effectJudgeToggle=document.querySelector("#effect-judge-enabled");
effectJudgeToggle.closest(".plugin-summary-toggle").addEventListener("click",event=>event.stopPropagation());
effectJudgeToggle.addEventListener("change",()=>{
  const enabled=effectJudgeToggle.checked;
  effectJudgeToggle.disabled=true;
  const summaryState=document.querySelector("#effect-judge-summary-state");
  summaryState.className="running";
  summaryState.textContent="保存中";
  invoke(async()=>{
    await api.updatePluginSettings("effect-judge",{enabled});
    const available=Boolean(state?.plugins?.definitions?.find(item=>item.id==="effect-judge")?.contextAvailable);
    toast(enabled?(available?"效果判定已启用，将在全员确认后执行":"效果判定已启用；当前无上文，首轮会跳过并在历史输出可读后生效"):"效果判定已停用");
  }).catch(()=>{if(state)renderPluginPanel(state)});
});
document.querySelector("#save-effect-judge").addEventListener("click",()=>invoke(async()=>{
  const dieFaces=Number(document.querySelector("#effect-judge-faces").value);
  const degreeCount=Number(document.querySelector("#effect-judge-degrees").value);
  const previousOutputs=Number(document.querySelector("#effect-judge-context").value);
  if(!Number.isInteger(previousOutputs)||previousOutputs<1||previousOutputs>20)throw new Error("读取输出数量 n 必须是 1 到 20 的整数");
  if(!Number.isInteger(dieFaces)||dieFaces<6||dieFaces>20)throw new Error("骰子面值 y 必须是 6 到 20 的整数");
  if(!Number.isInteger(degreeCount)||degreeCount<4||degreeCount>dieFaces-2)throw new Error(`程度数量 x 必须是 4 到 ${dieFaces-2} 的整数`);
  const payload={
    enabled:document.querySelector("#effect-judge-enabled").checked,
    settings:{
      previousOutputs,
      degreeCount,
      dieFaces,
      stylePreset:document.querySelector("#effect-judge-style-preset").value,
      stylePrompt:document.querySelector("#effect-judge-style").value
    }
  };
  await api.updatePluginSettings("effect-judge",payload);
  pluginEditorDirty=false;
  toast(payload.enabled?"效果判定已启用，将在全员确认后执行":"效果判定已停用");
}).catch(()=>{}));
document.querySelector("#refresh-latest").addEventListener("click",async()=>{if(!await confirmAction("刷新会调用房主平台模型并可能消耗积分，确定继续吗？",{title:"刷新上一条回复",acceptText:"确认刷新"}))return;invoke(async()=>{await api.runMessageOperation("refresh","");toast("回复已刷新，正在同步给访客")}).catch(()=>{})});
document.querySelector("#edit-latest").addEventListener("click",()=>{document.querySelector("#message-edit-value").value=state?.room?.round?.lastResult?.output||"";document.querySelector("#message-edit-form").classList.remove("hidden");document.querySelector("#message-edit-value").focus()});
document.querySelector("#cancel-message-edit").addEventListener("click",()=>document.querySelector("#message-edit-form").classList.add("hidden"));
document.querySelector("#confirm-message-edit").addEventListener("click",event=>invoke(async()=>{const button=event.currentTarget;button.disabled=true;try{await api.runMessageOperation("edit",document.querySelector("#message-edit-value").value);document.querySelector("#message-edit-form").classList.add("hidden");toast("房主平台回复已由脚本编辑，正在同步给访客")}finally{button.disabled=false}}).catch(()=>{}));
document.addEventListener("keydown",event=>{
  if(event.key!=="Escape")return;
  if(settingsOpen)void setSettingsOpen(false).catch(error=>toast(friendlyError(error)));
});
document.querySelector("#delete-latest").addEventListener("click",async()=>{if(!await confirmAction("确定删除最近一条 AI 回复并同步删除所有访客端的对应回复吗？",{title:"删除上一条回复",acceptText:"删除"}))return;invoke(async()=>{await api.runMessageOperation("delete","");toast("回复已删除，正在同步给访客")}).catch(()=>{})});
document.querySelector("#show-intro").addEventListener("click",()=>state?.work?invoke(()=>api.showIntro()).catch(()=>{}):toast("请先选择作品"));
document.querySelector("#show-game").addEventListener("click",()=>{conversationAttentionKey=null;renderSurfaceButtons();invoke(()=>api.showGame()).catch(()=>{})});
slot.addEventListener("wheel",event=>{
  if(!["loading-game","game","game-empty","guest-waiting","guest-syncing"].includes(state?.mode)||gameFrame.classList.contains("hidden"))return;
  event.preventDefault();
  const unit=event.deltaMode===1?16:event.deltaMode===2?Math.max(200,slot.clientHeight):1;
  pendingGameScroll+=event.deltaY*unit;
  if(gameScrollTimer)return;
  gameScrollTimer=setTimeout(()=>{
    const amount=pendingGameScroll;
    pendingGameScroll=0;
    gameScrollTimer=null;
    api.scrollGame(amount).catch(error=>toast(friendlyError(error)));
  },24);
},{passive:false});
gameFrame.tabIndex=0;
gameFrame.draggable=false;
gameFrame.addEventListener("dragstart",event=>event.preventDefault());
gameFrame.addEventListener("pointermove",event=>{
  if(state?.mode!=="game")return;
  const point=gamePoint(event);if(!point)return;
  pendingPointerMove={type:"move",...point,buttons:event.buttons};
  if(pointerMoveTimer)return;
  pointerMoveTimer=setTimeout(()=>{
    const payload=pendingPointerMove;pendingPointerMove=null;pointerMoveTimer=null;
    if(payload)enqueueGameInput(()=>api.gamePointer(payload)).catch(()=>{});
  },32);
});
gameFrame.addEventListener("pointerdown",event=>{
  if(state?.mode!=="game")return;
  const point=gamePoint(event);if(!point)return;
  event.preventDefault();gameFrame.focus();gameFrame.setPointerCapture?.(event.pointerId);
  const button=event.button===2?"right":event.button===1?"middle":"left";
  enqueueGameInput(()=>api.gamePointer({type:"down",...point,button,buttons:event.buttons,clickCount:event.detail||1})).catch(()=>{});
});
gameFrame.addEventListener("pointerup",event=>{
  if(state?.mode!=="game")return;
  const point=gamePoint(event);if(!point)return;
  event.preventDefault();
  const button=event.button===2?"right":event.button===1?"middle":"left";
  enqueueGameInput(()=>api.gamePointer({type:"up",...point,button,buttons:event.buttons,clickCount:event.detail||1})).catch(()=>{});
  gameFrame.releasePointerCapture?.(event.pointerId);
});
gameFrame.addEventListener("contextmenu",event=>event.preventDefault());
gameFrame.addEventListener("keydown",event=>{
  if(state?.mode!=="game")return;
  const modified=event.ctrlKey||event.altKey||event.metaKey;
  const text=!modified&&event.key.length===1?event.key:"";
  const supported=text||["Backspace","Delete","Enter","Tab","Escape","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","PageUp","PageDown"].includes(event.key)||modified;
  if(!supported)return;
  event.preventDefault();
  enqueueGameInput(()=>api.gameKey(text?{text}:{key:event.key,code:event.code,ctrlKey:event.ctrlKey,altKey:event.altKey,shiftKey:event.shiftKey,metaKey:event.metaKey})).catch(()=>{});
});
document.querySelector("#new-instance").addEventListener("click",()=>invoke(async()=>{const requested=document.querySelector("#new-profile").value.trim();const id=await api.newInstance(requested);toast(`已启动隔离账号实例：${id}`)}).catch(()=>{}));
document.querySelector("#create-room").addEventListener("click",()=>{if(!state?.loggedIn){toast("请先在软件内登录账号");return}if(!state?.work){toast("创建房间前必须先选择作品");invoke(()=>api.chooseWork()).catch(()=>{});return}if(state?.room){toast(`房间 ${state.room.id} 已经创建`);return}if(!state?.conversation?.activeName){toast("请先明确选择一个平台会话，或点击“新建会话”");document.querySelector("#conversation-list").focus();return}document.querySelector("#room-setup").classList.remove("hidden");document.querySelector("#room-password").focus()});
document.querySelector("#cancel-create-room").addEventListener("click",()=>{document.querySelector("#room-password").value="";document.querySelector("#room-setup").classList.add("hidden")});
document.querySelector("#confirm-create-room").addEventListener("click",event=>invoke(async()=>{const button=event.currentTarget;button.disabled=true;button.textContent="正在生成房间链接…";try{const password=document.querySelector("#room-password").value;const displayName=document.querySelector("#display-name").value.trim();const basicInfo=document.querySelector("#profile-basic-info").value.trim();const appearance=document.querySelector("#profile-appearance").value.trim();const room=await api.createRoom({password,displayName,basicInfo,appearance});document.querySelector("#room-password").value="";document.querySelector("#room-setup").classList.add("hidden");toast(`房间 ${room.id} 已创建，请将邀请链接发送给成员`)}finally{button.disabled=false;button.textContent="创建并生成链接"}}).catch(()=>{}));
document.querySelector("#join-room").addEventListener("click",()=>{if(!state?.loggedIn){toast("请先在软件内登录账号");return}if(state?.room){toast(state.room.status==="joining"?"正在加入房间":`当前已经在房间 ${state.room.id}`);return}document.querySelector("#room-setup").classList.add("hidden");document.querySelector("#join-setup").classList.remove("hidden");document.querySelector("#join-invite-url").focus()});
document.querySelector("#cancel-join-room").addEventListener("click",()=>{document.querySelector("#join-invite-url").value="";document.querySelector("#join-room-password").value="";document.querySelector("#join-setup").classList.add("hidden")});
document.querySelector("#confirm-join-room").addEventListener("click",event=>invoke(async()=>{const button=event.currentTarget;button.disabled=true;button.textContent="正在加入…";try{const inviteUrl=document.querySelector("#join-invite-url").value.trim();const password=document.querySelector("#join-room-password").value;const displayName=document.querySelector("#display-name").value.trim();const basicInfo=document.querySelector("#profile-basic-info").value.trim();const appearance=document.querySelector("#profile-appearance").value.trim();const room=await api.joinRoom({inviteUrl,password,displayName,basicInfo,appearance});document.querySelector("#join-room-password").value="";document.querySelector("#join-setup").classList.add("hidden");toast(`已加入 ${room.hostUsername} 的房间`)}finally{button.disabled=false;button.textContent="加入房间"}}).catch(()=>{}));
document.querySelector("#copy-invite-link").addEventListener("click",()=>invoke(async()=>{const value=document.querySelector("#room-invite-url").value;if(!value)throw new Error("邀请链接尚未生成");await api.copyText(value);toast("邀请链接已复制")}).catch(()=>{}));
document.querySelector("#leave-room").addEventListener("click",()=>invoke(async()=>{
  const isHost=state?.room?.role==="host";
  if(isHost&&!await confirmAction("解散房间后，所有访客都会收到通知并自动退出。",{title:"解散当前房间",acceptText:"确认解散"}))return;
  await api.leaveRoom();
  document.querySelector("#join-room-password").value="";
  toast(isHost?"房间已解散":"已退出当前房间，可以重新创建或加入");
}).catch(()=>{}));
document.querySelector("#room-chat-form").addEventListener("submit",event=>{event.preventDefault();invoke(async()=>{const input=document.querySelector("#room-chat-input");const text=input.value;await api.sendRoomChat(text);input.value=""}).catch(()=>{})});
document.querySelector("#room-chat-input").addEventListener("keydown",event=>{if(event.key!=="Enter"||event.shiftKey||event.isComposing)return;event.preventDefault();document.querySelector("#room-chat-form").requestSubmit()});
document.querySelector("#submit-round").addEventListener("click",()=>invoke(async()=>{const input=document.querySelector("#round-input");await api.submitRound(input.value);input.value="";toast("本轮输入已确认，等待其他成员")}).catch(()=>{}));
document.querySelector("#copy-logs").addEventListener("click",()=>invoke(async()=>{const entries=orderedSessionLogs();if(!entries.length)throw new Error("当前还没有日志");await api.copyText(entries.map(entry=>JSON.stringify(entry)).join("\n"));toast(`已复制 ${entries.length} 条本次运行日志`)}).catch(()=>{}));
window.addEventListener("resize",syncSurfaceBounds);
new ResizeObserver(syncSurfaceBounds).observe(slot);
api.onState(next=>{const previous=state;consumeStateEffects(next,previous);render(next);if(next.roundCompleted)toast("本轮结果已同步，对话界面已经开放");if(next.roundError)toast(next.roundError);if(next.workLoadError)toast(next.workLoadError);if(next.introUnavailable)toast("平台预览页尚未返回作品介绍视窗");if(next.protocolError)toast(`会话同步重试中：${next.protocolError}`);if(next.messageOperationCompleted)toast("记录操作已在全体成员端完成");if(next.messageOperationError)toast(`记录同步失败：${next.messageOperationError}`);if(next.hostModelChanged)toast("房主已更换平台模型");if(next.roomChatError)toast(next.roomChatError);if(next.appUpdateChanged&&next.appUpdate?.status==="ready")toast(next.appUpdate.message);if(next.appUpdateChanged&&next.appUpdate?.status==="error"&&next.releaseSecurity?.verified)toast(next.appUpdate.message)});
api.onGameFrame(frame=>{if(frame?.reset){resetGameFrame();return}if(!frame?.bytes||state?.backgroundPages?.gamePresentationAllowed===false)return;pendingGameFrame=frame;void drainGameFrames()});
api.onOnlineWorldState(next=>renderOnlineWorld(next));
api.onLog(entry=>{if(state?.isAdmin)receiveSessionLog(entry)});
api.getAppVersion().then(version=>{appVersion.textContent=`v${version}`}).catch(()=>{});
api.getReleaseChannel().then(applyReleaseIdentity).catch(applyReleaseIdentity);
showStartupOfficialNotice();
Promise.all([api.getState(),api.loadCredentials(),api.listDomainCandidates(),api.getAuthorInfo().catch(()=>null)]).then(async([initial,saved,candidates,authorInfo])=>{
  if(saved){accountInput.value=saved.account||"";passwordInput.value=saved.password||"";rememberInput.checked=true;autoLoginInput.checked=Boolean(saved.autoLogin)}
  renderAuthorInfo(authorInfo);domainDirectory=candidates;lastObservedResultKey=roundResultKey(initial);render(initial);renderDomainList();
  await refreshDomains(false);
  if(saved?.autoLogin&&!initial.loggedIn)await submitCredentials({automatic:true});
}).catch(error=>toast(friendlyError(error)));
