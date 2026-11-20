import {pathToFileURL} from 'node:url';

export function parseArgs(args) {
  const result={base:'http://127.0.0.1:4320',name:'标准音效预览',wait:true};
  for(let i=0;i<args.length;i++) {
    const key=args[i];
    if(key==='--help')result.help=true;
    else if(key==='--no-wait')result.wait=false;
    else if(['--video','--library','--music','--name','--inspect','--base'].includes(key)) {
      const value=args[++i];if(!value||value.startsWith('--'))throw new Error(`${key} 缺少参数`);
      result[key.slice(2)]=value;
    } else throw new Error(`未知参数 ${key}`);
  }
  const base=new URL(result.base);
  if(base.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(base.hostname)||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw new Error('--base 必须是本机 HTTP 服务地址');
  result.base=base.origin;
  if(!result.help&&!result.inspect&&(!result.video||!result.library))throw new Error('需要 --video 和 --library，或 --inspect 任务ID');
  if(result.inspect&&!/^[a-f\d-]{36}$/i.test(result.inspect))throw new Error('无效任务ID');
  return result;
}

export async function runWorkflow(options,output=console.log) {
  const request=async(route,body)=>{
    const response=await fetch(options.base+route,{signal:AbortSignal.timeout(30000),...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);return data;
  };
  const profile=await request('/api/sfx/workflow');
  if(profile.profile.id!=='reference-v6')throw new Error('服务不支持标准流程，请更新并重启本工具');
  const created=options.inspect?{runId:options.inspect}:await request('/api/sfx/runs',{workflowPreset:'reference-v6',reusePreserved:true,videoPath:options.video,libraryPath:options.library,musicLibraryPath:options.music,name:options.name});
  const id=created.runId,link=`${options.base}/sfx?run=${id}`;
  output(JSON.stringify({runId:id,workbench:link,submitted:!options.inspect,reused:created.reused===true}));
  if(!options.wait&&!options.inspect)return {runId:id,workbench:link};
  const started=Date.now();let previous='';
  for(;;) {
    const state=await request(`/api/sfx/runs/${id}/status`);
    const compact=JSON.stringify(state);if(compact!==previous){output(compact);previous=compact;}
    if(state.status==='failed')throw new Error(state.error||state.progress);
    if(!['analyzing','rendering'].includes(state.status)||options.inspect) {
      const report=await request(`/api/sfx/runs/${id}/export/workflow`);
      const result={runId:id,workbench:link,status:state.status,quality:report.quality,counts:report.counts,usage:report.usage,video:`${options.base}/api/sfx/runs/${id}/export/video`,placements:`${options.base}/api/sfx/runs/${id}/export/json`,workflow:`${options.base}/api/sfx/runs/${id}/export/workflow`};
      output(JSON.stringify(result));return result;
    }
    if(Date.now()-started>31*60000)throw new Error(`等待已结束，服务仍可继续；用 --inspect ${id} 查看，不要重复提交`);
    await new Promise(resolve=>setTimeout(resolve,3000));
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const options=parseArgs(process.argv.slice(2));
    if(options.help)console.log('node run.mjs --video <本机视频> --library <本机目录> [--music <目录>] [--name <名称>] [--no-wait]\nnode run.mjs --inspect <runId> [--base http://127.0.0.1:4320]');
    else await runWorkflow(options);
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
