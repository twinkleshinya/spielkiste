/** Deliberately classify gateway errors without echoing arbitrary proxy diagnostics. */
export function gatewayErrorInfo(body:unknown,status:number){
 const error=(body as any)?.error;
 const message=String(error?.message||'');
 const code=String(error?.code||error?.type||'').replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,80);
 if(code==='context_length_exceeded'||/input token count.*exceeds|context.{0,20}(?:length|limit|exceed)|too many tokens/i.test(message))return {code:'context_length_exceeded',reason:'请求内容超出模型上下文容量；请缩小单次分析内容后重试'};
 if(status===401||status===403)return {code:'authorization_rejected',reason:'网关授权无效或当前模型没有访问权限，请在 AI 连接中测试配置'};
 if(status===429)return {code:'rate_limited',reason:'网关额度或并发受限，请稍后点击继续重试'};
 if(status>=500)return {code:'upstream_unavailable',reason:'模型网关暂时不可用，请稍后点击继续重试'};
 return {code:code||`http_${status}`,reason:status===400?'网关拒绝了请求内容或参数；可查看错误代码后重试':'模型网关请求失败，请测试 AI 连接'};
}
export function modelGatewayError(label:string,body:unknown,status:number){const info=gatewayErrorInfo(body,status);return new Error(`${label}请求失败（HTTP ${status}；${info.code}）：${info.reason}。`);}
