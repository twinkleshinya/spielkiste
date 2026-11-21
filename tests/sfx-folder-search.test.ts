import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function testFolderKeywordSearch() {
  const {searchLocalFolders}=await import('../src/ui/LocalFolders.js') as any;
  assert.equal(typeof searchLocalFolders,'function','folder keyword search must be available');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'spielkiste-path-'));
  try {
    await fs.mkdir(path.join(root,'金属','Metal_Heavy'),{recursive:true});await fs.mkdir(path.join(root,'其他','风声'),{recursive:true});
    const result=await searchLocalFolders({path:root,query:'metal'});
    assert.deepEqual(result.folders.map((f:any)=>f.path),[path.join(root,'金属','Metal_Heavy')]);
    assert.equal((await searchLocalFolders({path:root,query:'金属'})).folders.length,2,'matching parent path applies to children');
    await assert.rejects(searchLocalFolders({path:'',query:'金属'}),/范围|目录/);
    const controller=new AbortController();controller.abort();await assert.rejects(searchLocalFolders({path:root,query:'金属',signal:controller.signal}));
    const limited=await searchLocalFolders({path:root,query:'其他',maxDirectories:1});assert.equal(limited.truncated,true);
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
