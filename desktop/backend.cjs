const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
(async () => {
  try {
    // 桌面实例各自使用随机端口，避免多开时争用同一个端口记录。
    process.env.PORT='0';
    const { serverReady, server } = await import(pathToFileURL(path.join(process.env.SPIELKISTE_RESOURCE_ROOT,'dist/src/ui/server.js')).href);
    let port;
    try {port=await serverReady;}catch(error){
      if(error.code!=='EADDRINUSE')throw error;
      port=await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
    }
    process.parentPort.postMessage({ port });
  } catch (error) { process.parentPort.postMessage({error: error.stack || String(error)}); }
})();
