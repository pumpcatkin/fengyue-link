"use strict";

const { app } = require("electron");
const { testGameInBrowser } = require("../electron/game-harness-browser.cjs");

const modelTasks = {
  schema: "fyow.model-tasks/1",
  tasks: [{
    taskId: "story.generate",
    version: 1,
    prompt: "根据玩家选择生成一段简短剧情。只返回符合输出 Schema 的 JSON。",
    inputSchema: {
      type: "object",
      properties: { choice: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["choice"],
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: 1000 } },
      required: ["text"],
      additionalProperties: false
    }
  }]
};

const tests = {
  modelFixtures: {
    "story.generate": {
      output: { text: "你踏入了发光的森林。" },
      usage: { input: 2, output: 3, total: 5, source: "harness-fixture", remainingPoints: 995 }
    }
  },
  scenarios: [{
    name: "通用模型生成、积分展示和恢复",
    steps: [
      { action: "click", selector: "#generate" },
      { action: "assert", selector: "#story", includes: "发光的森林" },
      { action: "assert", selector: "#usage", includes: "输入 2 · 输出 3 · 总计 5" },
      { action: "assert", selector: "#usage", includes: "来源 harness-fixture · 剩余 995" },
      { action: "click", selector: "#advance" },
      { action: "assert", selector: "#progress", includes: "进度 2" }
    ],
    terminal: { selector: "#status", includes: "完成" },
    restart: { action: "click", selector: "#restart" },
    reset: { selector: "#progress", includes: "进度 0" },
    resumed: { selector: "#story", includes: "发光的森林" },
    persisted: { selector: "#status", includes: "待生成" }
  }]
};

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="fyow-runtime" content="standalone/1"><title>通用模型测试</title></head><body>
<main><h1>通用模型测试</h1><p id="status">等待宿主</p><p id="progress">进度 0</p><p id="story">尚未生成</p><p id="usage">尚无消耗</p>
<button id="generate" disabled>生成剧情</button><button id="advance" disabled>继续</button><button id="restart" disabled>重新开始</button></main>
<script>
const SOURCE="fyow-game-card",SAVE_PROTOCOL="fyow-host/1",MODEL_PROTOCOL="fyow-host/2";
let state={version:1,step:0,text:"",usage:null},loaded=false,pendingSave=null,lastSentAt=0,revision=0,savedRevision=0,pendingRevision=0,timer=null;
const pendingModels=new Map(),$=id=>document.getElementById(id);
function sendSave(type,data={}){parent.postMessage({source:SOURCE,protocol:SAVE_PROTOCOL,type,...data},"*")}
function render(){$("status").textContent=state.step>=2?"完成":state.text?"已生成":"待生成";$("progress").textContent="进度 "+state.step;$("story").textContent=state.text||"尚未生成";$("usage").textContent=state.usage?"输入 "+state.usage.input+" · 输出 "+state.usage.output+" · 总计 "+state.usage.total+" 积分 · 来源 "+state.usage.source+" · 剩余 "+state.usage.remainingPoints:"尚无消耗";$("generate").disabled=!loaded;$("advance").disabled=!loaded||!state.text;$("restart").disabled=!loaded}
function flush(){clearTimeout(timer);if(pendingSave||savedRevision===revision)return;const wait=100-(Date.now()-lastSentAt);if(wait>0){timer=setTimeout(flush,wait);return}pendingSave=crypto.randomUUID();pendingRevision=revision;lastSentAt=Date.now();sendSave("game-save",{requestId:pendingSave,data:state})}
function save(){revision++;clearTimeout(timer);timer=setTimeout(flush,150)}
function runModel(taskId,input){const requestId=crypto.randomUUID(),idempotencyKey=crypto.randomUUID();return new Promise((resolve,reject)=>{pendingModels.set(requestId,{resolve,reject});parent.postMessage({source:SOURCE,protocol:MODEL_PROTOCOL,kind:"request",method:"model.run",requestId,params:{taskId,idempotencyKey,input}},"*")})}
$("generate").onclick=async()=>{try{$("status").textContent="生成中";const result=await runModel("story.generate",{choice:"进入森林"});state={...state,step:1,text:result.output.text,usage:result.usage};render();save()}catch(error){$("status").textContent="生成失败："+error.message}};
$("advance").onclick=()=>{state.step=2;render();save()};
$("restart").onclick=()=>{state={version:1,step:0,text:"",usage:null};render();save()};
addEventListener("message",event=>{if(event.source!==parent||event.data?.source!=="fengyue-host")return;const data=event.data;
if(data.protocol===SAVE_PROTOCOL&&data.type==="state"&&!loaded){const saved=data.state?.gameSave;if(saved?.version===1)state=saved;loaded=true;render()}
if(data.protocol===SAVE_PROTOCOL&&data.requestId===pendingSave&&["result","error"].includes(data.type)){if(data.type==="result")savedRevision=pendingRevision;pendingSave=null;flush()}
if(data.protocol===MODEL_PROTOCOL&&data.kind==="result"){const pending=pendingModels.get(data.requestId);if(!pending)return;pendingModels.delete(data.requestId);data.ok?pending.resolve(data.result):pending.reject(new Error(data.error?.message||"模型调用失败"))}});
sendSave("ready",{capabilities:["flush-save/1","model-run/1"]});
</script></body></html>`;

app.whenReady().then(async () => {
  try {
    const result = await testGameInBrowser(html, tests, undefined, { modelTasks, timeoutMs: 30000 });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
