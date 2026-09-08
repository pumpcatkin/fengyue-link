// Explicitly authorized live QA. Credentials stay in process memory; no user
// browser profile is read. Only newly-created QA conversations may be changed.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'release-cache', '0.10.7-live');
fs.mkdirSync(outputDir, { recursive: true });
app.setPath('userData', path.join(outputDir, 'isolated-runtime'));
const credentials = { account: process.env.FYMP_QA_ACCOUNT, password: process.env.FYMP_QA_PASSWORD, remember: false };
delete process.env.FYMP_QA_ACCOUNT;
delete process.env.FYMP_QA_PASSWORD;
const origin = process.env.FYMP_QA_ORIGIN || 'https://staging.aiero.cc';
const source = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
const loaded = new Module(path.join(root, 'electron/live-backend.cjs'), module);
loaded.filename = path.join(root, 'electron/live-backend.cjs');
loaded.paths = Module._nodeModulePaths(path.join(root, 'electron'));
loaded._compile(source.slice(0, source.indexOf('let mainWindow;')) + '\nmodule.exports = { AccountBackend };', loaded.filename);
const { AccountBackend } = loaded.exports;
const appId = '0f357d8b-6170-4a22-afa7-72fef3490890';
const mode = process.argv.find(value => value.startsWith('--run='))?.slice(6) || 'inspect';
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  const backend = new AccountBackend(window, 'termination-qa');
  for (const key of ['statusTimer','accountTimer','heartbeatTimer','chatTimer','roomTimer','gameFrameTimer','gameWakeTimer','introWakeTimer']) clearInterval(backend[key]);
  backend.emit = () => {};
  for (const name of ['platformGoApi','platformChatApi']) {
    const original=backend[name].bind(backend);
    backend[name]=async (...args)=>{try{return await original(...args);}catch(error){console.log(JSON.stringify({stage:'api-error',api:name,path:args[0],method:args[1]?.method||'GET',error:error.message}));throw error;}};
  }
  backend.appendSessionLog = (category, detail) => {
    if (detail.error && !category.includes('login')) console.log(JSON.stringify({ category, event: detail.event, error: detail.error }));
  };
  try {
    if (mode === 'logout-test-session') {
      backend.origin = origin;
      await backend.logout({ emit: false });
      await backend.platformSession.clearStorageData({ origin, storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
      await backend.platformSession.clearCache();
      console.log(JSON.stringify({ stage: 'qa-local-login-cleared', origin, partition: backend.partition }));
      return;
    }
    if (!credentials.account || !credentials.password) throw new Error('Live QA credentials are required in the environment');
    backend.origin = origin;
    backend.domainSelected = true;
    await backend.networkReady;
    await backend.login(credentials);
    credentials.password = '';
    console.log(JSON.stringify({ stage: 'authenticated', username: backend.account.username, origin }));
    backend.work = { suffix: `/zh/explore/installed/${appId}`, url: `${origin}/zh/explore/installed/${appId}`, title: '终止测试' };
    const models = await backend.refreshPlatformModels();
    if (models.error) throw new Error(models.error);
    const items = models.items.map(item => backend.modelPublicValue(item));
    fs.writeFileSync(path.join(outputDir, 'models.json'), JSON.stringify(items, null, 2));
    console.log(JSON.stringify({ stage: 'models', count: items.length }));
    if (mode === 'seed-stream') {
      const result=await backend.anchor.webContents.executeJavaScript(`(${liveStopTest.toString()})(${JSON.stringify({appId,series:[{family:models.selected.family,provider:models.selected.provider,model:models.selected.model}],repetitions:1})})`,true);
      fs.writeFileSync(path.join(outputDir,'stream-seed.json'),JSON.stringify(result,null,2));
      console.log(JSON.stringify({stage:'stream-seed',result}));
      if(result[0]?.conversationId)await backend.platformChatApi(`/installed-apps/${appId}/conversations/${result[0].conversationId}/name`,{method:'POST',body:{name:'FYMP终止测试-stream-seed'}});
    }
    if (mode === 'seed-series') {
      const series=JSON.parse(fs.readFileSync(path.join(outputDir,'series.json'),'utf8'));
      const result=fs.existsSync(path.join(outputDir,'series-bootstrap-result.json'))?JSON.parse(fs.readFileSync(path.join(outputDir,'series-bootstrap-result.json'),'utf8')):[];
      for(const spec of series.created){
        if(result.some(item=>item.family===spec.family&&item.conversationId&&item.stable))continue;
        const next=await backend.anchor.webContents.executeJavaScript(`(${liveStopTest.toString()})(${JSON.stringify({appId,series:[{...spec,conversationId:undefined}],repetitions:1})})`,true);
        result.push(...next);
        fs.writeFileSync(path.join(outputDir,'series-bootstrap-result.json'),JSON.stringify(result,null,2));
        console.log(JSON.stringify({stage:'seed-attempt',family:spec.family,stable:next[0]?.stable,error:next[0]?.serverError||next[0]?.error}));
      }
      for(const item of result){
        if(!item.conversationId||!item.stable)continue;
        const spec=series.created.find(spec=>spec.family===item.family);spec.conversationId=item.conversationId;
        fs.writeFileSync(path.join(outputDir,'series.json'),JSON.stringify(series,null,2));
        await backend.platformChatApi(`/installed-apps/${appId}/conversations/${spec.conversationId}/name`,{method:'POST',body:{name:spec.name}});
      }
      if(series.created.some(spec=>!spec.conversationId))throw new Error('Some QA seeds are not ready');
      console.log(JSON.stringify({stage:'series-seeded',result:result.map(item=>({family:item.family,conversationId:item.conversationId,actualModel:item.actualModel,characters:item.characters,usage:item.usage,stable:item.stable}))}));
    }
    if (mode === 'test-series-verified') {
      const series=JSON.parse(fs.readFileSync(path.join(outputDir,'series.json'),'utf8'));
      const original=backend.normalizeModelPayload(await backend.platformGoApi(`/apps/config?app_id=${appId}`));
      fs.writeFileSync(path.join(outputDir,'global-model-backup.json'),JSON.stringify({appId,model:original.model},null,2));
      const results=[];
      try{
        // This platform selects the app's global model even when a conversation
        // model is saved. Serialize model changes, and verify actual SSE models.
        for(const spec of series.created){
          await backend.platformGoApi('/apps/config',{method:'POST',body:{app_id:appId,model:{...original.model,provider:spec.provider,name:spec.model,completion_params:{...original.model?.completion_params,max_tokens:256}}}});
          const result=await backend.anchor.webContents.executeJavaScript(`(${liveStopTest.toString()})(${JSON.stringify({appId,series:[spec],repetitions:3})})`,true);
          results.push(...result);
          fs.writeFileSync(path.join(outputDir,'verified-series-result.json'),JSON.stringify(results,null,2));
          console.log(JSON.stringify({stage:'verified-series',family:spec.family,result:result.map(item=>({actualModel:item.actualModel,taskMs:item.taskMs,endedMs:item.endedMs,stopAckMs:item.stopAckMs,characters:item.characters,stable:item.stable,error:item.error||item.serverError,usage:item.usage}))}));
        }
      }finally{
        await backend.platformGoApi('/apps/config',{method:'POST',body:{app_id:appId,model:original.model}});
        const restored=backend.normalizeModelPayload(await backend.platformGoApi(`/apps/config?app_id=${appId}`));
        if(restored.model?.provider!==original.model.provider||restored.model?.name!==original.model.name)throw new Error('Test app global model restoration failed');
        console.log(JSON.stringify({stage:'global-model-restored',model:restored.model.name,provider:restored.model.provider}));
      }
    }
    if (mode === 'native-regression') {
      const spec=JSON.parse(fs.readFileSync(path.join(outputDir,'series.json'),'utf8')).created.find(item=>item.family==='grok');
      const original=backend.normalizeModelPayload(await backend.platformGoApi(`/apps/config?app_id=${appId}`));
      try {
        await backend.platformGoApi('/apps/config',{method:'POST',body:{app_id:appId,model:{...original.model,provider:spec.provider,name:spec.model}}});
        await backend.setPlatformConversationId(spec.conversationId);
        const key='native-regression-'+Date.now();
        backend.conversation={...backend.conversation,activeId:spec.conversationId,sessionKey:key,activeName:spec.name,items:[{id:spec.conversationId,name:spec.name}]};
        backend.room={id:key,role:'guest',save:{key,conversationId:spec.conversationId,name:spec.name},members:[],profile:{id:backend.account.accountId},round:backend.newRound(1)};
        const results=[];
        for(let round=1;round<=2;round++){
          const input=JSON.stringify({Users:[{'user-name':'软件回归测试',input:`访客同步回归 ${key} ${round}，请列出常见植物。`}]});
          backend.room.round=backend.newRound(round);backend.room.round.status='generating';
          const prepared=await backend.prepareGuestRoundInput({round,input});
          console.log(JSON.stringify({stage:'native-prepared',round,mode:prepared.terminationMode,messageId:prepared.messageId,trace:prepared.trace}));
          backend.room.round.status='syncing';
          const output='<section class="qa"><h3>同步测试</h3>\r\n'+('完整正文 &amp; 格式保留。'.repeat(180))+'\r\n</section>';
          const synced=await backend.syncGuestRoundResultWithRetries({round,input,output},{maxAttempts:2});
          results.push({round,terminationMode:prepared.terminationMode,messageId:prepared.messageId,conversationId:synced.conversation.activeId,outputLength:output.length,synced:true});
          fs.writeFileSync(path.join(outputDir,'native-result.json'),JSON.stringify(results,null,2));
          console.log(JSON.stringify({stage:'native-synced',round,outputLength:output.length}));
        }
      }finally{
        await backend.platformGoApi('/apps/config',{method:'POST',body:{app_id:appId,model:original.model}});
        console.log(JSON.stringify({stage:'global-model-restored',model:original.model.name}));
      }
    }
    if (mode === 'inspect') {
      const payload=await backend.platformChatApi(`/installed-apps/${appId}/conversations?limit=100`);
      const rows=Array.isArray(payload.data)?payload.data:payload.data?.data||[];
      console.log(JSON.stringify({stage:'qa-conversations',keys:Object.keys(payload),count:rows.length,rowKeys:Object.keys(rows[0]||{}),qa:rows.filter(row=>String(row.name||row.conversation_name||'').startsWith('FYMP')).map(row=>({id:row.id,name:row.name||row.conversation_name}))}));
      console.log(JSON.stringify({stage:'info',value:await backend.platformChatApi('/installed-apps/messages/import/info')}));
    }
    if (mode === 'bootstrap' || mode === 'prepare-series') {
      const info = await backend.platformChatApi('/installed-apps/messages/import/info');
      console.log(JSON.stringify({ stage: 'import-info', info }));
      const uploaded = await backend.anchor.webContents.executeJavaScript(`(async () => {
        const data = new FormData();
        data.append('file', new File(['[USER]:FYMP disposable termination QA bootstrap\\n#-------------------------------------------#\\n[AI]:QA placeholder\\n#===========================================#\\n'], 'fymp-termination-qa.txt', {type:'text/plain'}));
        const response = await fetch('/go/api/file/upload?biz=chat_message_history', {method:'POST',credentials:'include',headers:{Authorization:'Bearer '+localStorage.getItem('console_token')},body:data});
        const payload = await response.json();
        if (!response.ok) throw new Error('QA upload failed: '+response.status);
        return payload;
      })()`, true);
      const url = uploaded?.data?.url || uploaded?.url;
      if (!url) throw new Error('QA upload did not return a file URL');
      const specs = mode === 'bootstrap' ? [{family:'bootstrap'}] : ['gemini','deepseek','gpt','claude','grok','other'].map(family => items.filter(item => item.family === family && item.successRate > 0).sort((a,b) => Number(a.priceCoefficient)-Number(b.priceCoefficient) || b.successRate-a.successRate)[0]);
      const created = [];
      for (const spec of specs) {
        const name = `FYMP终止测试-${spec.family}-${Date.now()}`;
        const imported = await backend.platformChatApi(`/installed-apps/${appId}/messages/import`, {method:'POST',body:{conversation_name:name,file_url:url}});
        created.push({name,...spec});
        fs.writeFileSync(path.join(outputDir, mode === 'bootstrap' ? 'bootstrap.json' : 'series.json'), JSON.stringify({ appId, origin, created }, null, 2));
        console.log(JSON.stringify({ stage:'imported', name, family:spec.family }));
      }
    }
    if (mode === 'prepare-series' || mode === 'test-series') {
      const series = JSON.parse(fs.readFileSync(path.join(outputDir,'series.json'),'utf8'));
      for (const spec of series.created) {
        for (let attempt=0;attempt<20 && !spec.conversationId;attempt++) {
          const payload=await backend.platformChatApi(`/installed-apps/${appId}/conversations?limit=100`);
          const rows=payload?.data?.data || payload?.data?.conversations || payload?.data || [];
          if (!Array.isArray(rows)) throw new Error('Unexpected conversation-list envelope: '+Object.keys(payload));
          spec.conversationId=rows.find(row=>row.name===spec.name)?.id;
          if (!spec.conversationId && attempt === 1 && mode === 'test-series') {
            // The import queue may stall; branch only our completed disposable
            // bootstrap, never a user's story conversation or a shared archive.
            const seed=rows.find(row=>row.id==='126de3a5-21b8-4f24-8be3-6b781e098240' && row.name==='FYMP终止测试-1788192320175');
            if(seed){
              const history=await backend.platformChatApi(`/installed-apps/${appId}/messages?conversation_id=${seed.id}&limit=5&page=1&paging_query_sort=desc`);
              const messages=Array.isArray(history.data)?history.data:history.data?.data||[];
              const last=messages.find(message=>message.query==='FYMP disposable termination QA bootstrap');
              if(!last)throw new Error('QA bootstrap message identity mismatch');
              const branch=backend.normalizeModelPayload(await backend.platformGoApi('/messages/branch/create',{method:'POST',body:{app_id:appId,conversation_id:seed.id,end_message_id:last.id,end_message_created_at:last.created_at,branch_type:1,is_create_conversation:true,is_include_custom_config:false}}));
              spec.conversationId=branch.conversation_id;
              if(!spec.conversationId)throw new Error('Private QA branch returned no conversation id');
              fs.writeFileSync(path.join(outputDir,'series.json'),JSON.stringify(series,null,2));
              await backend.platformChatApi(`/installed-apps/${appId}/conversations/${spec.conversationId}/name`,{method:'POST',body:{name:spec.name}});
            }
          }
          if (!spec.conversationId) await new Promise(resolve=>setTimeout(resolve,500));
        }
        if (!spec.conversationId) throw new Error('QA import is not ready: '+spec.name);
        const original=await backend.readPlatformConversationConfig(appId,spec.conversationId);
        const model={...(original.model||{}),provider:spec.provider,name:spec.model,completion_params:{...(original.model?.completion_params||{}),max_tokens:256,temperature:0.2}};
        await backend.platformGoApi('/apps/config',{method:'POST',body:{app_id:appId,conversation_id:spec.conversationId,is_global:false,model,pre_prompt:'这是软件终止生成能力测试。只按输入输出普通文本。',pre_text:'',post_text:'',sent_message_count:0}});
        const checked=await backend.readPlatformConversationConfig(appId,spec.conversationId);
        if (checked.model?.name!==spec.model || checked.model?.provider!==spec.provider) throw new Error('Test model did not persist');
        console.log(JSON.stringify({stage:'series-ready',family:spec.family,model:spec.model,provider:spec.provider}));
      }
      fs.writeFileSync(path.join(outputDir,'series.json'),JSON.stringify(series,null,2));
      if (mode === 'test-series') {
        const result=await backend.anchor.webContents.executeJavaScript(`(${liveStopTest.toString()})(${JSON.stringify({appId,series:series.created,concurrency:2})})`,true);
        fs.writeFileSync(path.join(outputDir,'parallel-result.json'),JSON.stringify(result,null,2));
        console.log(JSON.stringify({stage:'parallel-result',result:result.map(item=>({family:item.family,model:item.actualModel,endedMs:item.endedMs,stopAckMs:item.stopAckMs,characters:item.characters,stable:item.stable,error:item.error||item.serverError,usage:item.usage}))}));
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ stage: 'error', error: error.message }));
    process.exitCode = 1;
  } finally {
    credentials.password = '';
    backend.destroying = true;
    for (const item of BrowserWindow.getAllWindows()) item.destroy();
    app.exit(process.exitCode || 0);
  }
});

async function liveStopTest({appId,series,repetitions=3,concurrency=series.length}) {
  const headers={'Content-Type':'application/json',Authorization:'Bearer '+localStorage.getItem('console_token'),'X-Language':'zh-Hans'};
  const results=[];
  for (let repetition=1;repetition<=repetitions;repetition++) {
    for(let offset=0;offset<series.length;offset+=concurrency){
    const round=await Promise.all(series.slice(offset,offset+concurrency).map(async spec=>{
      const started=Date.now(), controller=new AbortController();
      const query='软件停止测试 '+repetition+' '+Date.now()+'-'+Math.random().toString(36).slice(2,8)+'：请逐条列出 100 种普通植物的名称，每行一个。';
      const result={family:spec.family,provider:spec.provider,model:spec.model,conversationId:spec.conversationId,repetition,events:[],stopAttempts:[],characters:0};
      let taskId=null,stopPromise=null;
      const timer=setTimeout(()=>controller.abort(),45000);
      const stop=async()=>{
        for(let n=0;n<3;n++){
          const response=await fetch('/go/api/apps/chat-stop',{method:'POST',credentials:'include',headers,body:JSON.stringify({task_id:taskId})});
          const data=await response.json();result.stopAttempts.push({atMs:Date.now()-started,status:response.status,code:data.code,message:data.msg||data.message});
          if(response.ok&&(data.code===0||data.code===100000||data.result==='success')){result.stopAckMs=Date.now()-started;break;}
          await new Promise(resolve=>setTimeout(resolve,200));
        }
      };
      try{
        const response=await fetch('/go/api/apps/chat-messages',{method:'POST',credentials:'include',headers,signal:controller.signal,body:JSON.stringify({app_id:appId,conversation_id:spec.conversationId,inputs:{},query,response_mode:'streaming'})});
        result.httpStatus=response.status;
        const reader=response.body.getReader(), decoder=new TextDecoder();let buffer='';
        while(true){
          const chunk=await reader.read();if(chunk.done){result.endedMs=Date.now()-started;break;}
          buffer+=decoder.decode(chunk.value,{stream:true});let newline;
          while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);if(!line.startsWith('data:'))continue;
            let data;try{data=JSON.parse(line.slice(5).trim());}catch{continue;}
            result.events.push({event:data.event,atMs:Date.now()-started,answerLength:typeof data.answer==='string'?data.answer.length:0,keys:Object.keys(data)});
            if(data.task_id&&!taskId){taskId=data.task_id;result.taskMs=Date.now()-started;stopPromise=stop();}
            if(data.message_id)result.messageId=data.message_id;
            if(data.conversation_id)result.conversationId=data.conversation_id;
            if(data.model_id)result.actualModel=data.model_id;
            if(data.metadata?.usage)result.usage=data.metadata.usage;
            if(typeof data.answer==='string')result.characters+=data.answer.length;
            if(data.event==='error'||data.status>=400)result.serverError=data.message||data.msg;
          }
        }
        if(stopPromise)await stopPromise;
      }catch(error){result.error=error.message;}finally{clearTimeout(timer);}
      const samples=[];
      for(let n=0;n<3;n++){
        await new Promise(resolve=>setTimeout(resolve,700));
        const response=await fetch('/console/api/installed-apps/'+appId+'/messages?conversation_id='+result.conversationId+'&limit=5&page=1&paging_query_sort=desc',{headers,credentials:'include'});
        const payload=await response.json();const rows=Array.isArray(payload.data)?payload.data:payload.data?.data||[];
        const record=rows.find(item=>item.id===result.messageId)||rows.find(item=>item.query===query);
        if(record){result.messageId=record.id;samples.push({atMs:Date.now()-started,length:record.answer?.length||0,answerPoints:record.answer_points,messagePoints:record.message_points,model:record.model_id});}
      }
      result.samples=samples;result.stable=samples.length===3&&samples.every(sample=>sample.length===samples[0].length);
      return result;
    }));results.push(...round);
    }
  }
  return results;
}
