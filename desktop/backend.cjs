const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
(async () => {
  try {
    // One backend serves all project windows. Reuse its previous port when
    // available so browser-local edit drafts survive an application restart.
    const portFile=path.join(process.cwd(),'desktop-port.json');
    try {const previous=JSON.parse(await fs.readFile(portFile,'utf8')).port;if(Number.isInteger(previous)&&previous>1024&&previous<65536)process.env.PORT=String(previous);}catch{}
    const { serverReady, server } = await import(pathToFileURL(path.join(process.env.SPIELKISTE_RESOURCE_ROOT,'dist/src/ui/server.js')).href);
    let port;
    try {port=await serverReady;}catch(error){
      if(error.code!=='EADDRINUSE')throw error;
      port=await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
    }
    await fs.writeFile(portFile,JSON.stringify({port}));
    process.parentPort.postMessage({ port });
  } catch (error) { process.parentPort.postMessage({error: error.stack || String(error)}); }
})();
