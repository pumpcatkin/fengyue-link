"use strict";
const { assertActive } = require("./auto-model-router.cjs");

// Route and multipart contract verified against the platform's shipped frontend.
// Upload success alone is not proof that a selected model can consume the file.
async function uploadHarnessText(backend, { name, content }, signal) {
  backend.assertToolLoggedIn();
  assertActive(signal);
  if (!/^[a-zA-Z0-9_-]{1,80}\.(txt|json|html)$/.test(name) || typeof content !== "string" || Buffer.byteLength(content) > 256000) throw new Error("仅上传 256KB 以内的项目文本附件");
  const anchor = await backend.ensureAnchor();
  const origin = backend.origin;
  const payload = await anchor.webContents.executeJavaScript(`(async()=>{
    if(location.origin!==${JSON.stringify(origin)})throw Error('账号节点已切换');
    const form=new FormData();form.append('file',new File([${JSON.stringify(content)}],${JSON.stringify(name)},{type:'text/plain'}));
    const headers={'X-Language':'zh-Hans','X-Timezone':Intl.DateTimeFormat().resolvedOptions().timeZone};
    const token=localStorage.getItem('console_token');if(token)headers.Authorization='Bearer '+token;
    const response=await fetch('/console/api/files/upload',{method:'POST',credentials:'include',headers,body:form,signal:AbortSignal.timeout(30000)});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw Error('模型文件上传失败 '+response.status+': '+String(body.message||body.msg||''));
    const id=body.id||body.data?.id;if(!id)throw Error('上传响应缺少文件 id');
    return {id,name:body.name||body.data?.name||${JSON.stringify(name)}};
  })()`, true);
  assertActive(signal);
  return { type: "document", transfer_method: "local_file", upload_file_id: String(payload.id) };
}
module.exports = { uploadHarnessText };
