const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  try {
    const { serverReady } = await import(pathToFileURL(path.join(process.env.SPIELKISTE_RESOURCE_ROOT,'dist/src/ui/server.js')).href);
    process.parentPort.postMessage({ port:await serverReady });
  } catch (error) { process.parentPort.postMessage({error: error.stack || String(error)}); }
})();
