import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';

export function metaRequest(job){
 const account=String(job.account||''),reader=String(job.reader_id||'');
 const url=new URL('https://graph.facebook.com/v24.0/');
 if(job.platform==='instagram'){
  if(!/^[a-zA-Z0-9._]{1,30}$/.test(account)||!/^\d{5,40}$/.test(reader))throw Error('invalid_account');
  url.pathname+=reader;url.searchParams.set('fields',`business_discovery.username(${account}){id,username,name,media.limit(50){id,caption,permalink,timestamp,media_type,media_url,thumbnail_url}}`);
 }else if(job.platform==='facebook'){
  if(!/^\d{5,40}$/.test(account))throw Error('invalid_account');
  url.pathname+=account+'/published_posts';url.searchParams.set('fields','id,message,created_time,permalink_url,full_picture,is_published');url.searchParams.set('limit','50');
 }else throw Error('invalid_platform');
 if(typeof job.access_token!=='string'||job.access_token.length<16||/[\r\n]/.test(job.access_token))throw Error('invalid_credential');
 return {url:url.href,headers:{Authorization:'Bearer '+job.access_token,Accept:'application/json'}};
}
export function createWorker({supabaseUrl,anonKey,workerToken,fetchImpl=fetch}){
 const base=new URL(supabaseUrl);if(base.protocol!=='https:')throw Error('HTTPS required');
 let running,lastPoll=0;
 async function rpc(name,args){
  const response=await fetchImpl(new URL('/rest/v1/rpc/'+name,base),{method:'POST',headers:{apikey:anonKey,...(anonKey.split('.').length===3?{Authorization:'Bearer '+anonKey}:{}),'Content-Type':'application/json'},body:JSON.stringify({p_worker_token:workerToken,...args}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('backend_'+response.status);
  return response.json();
 }
 async function drain(){
  // Credentials are returned only over HTTPS to this authenticated worker.
  for(let batch=0;batch<10;batch++){
   const jobs=await rpc('social_worker_claim',{});if(!Array.isArray(jobs)||jobs.length===0)return;
   for(const job of jobs){
    let status=599,body={};
    try{const request=metaRequest(job);const result=await fetchImpl(request.url,{headers:request.headers,redirect:'error',signal:AbortSignal.timeout(15000)});status=result.status;const text=await result.text();if(Buffer.byteLength(text)>2000000)throw Error('oversize');body=JSON.parse(text);}catch{status=599;body={};}
    // Never log credentials, Meta responses, URLs or request bodies.
    await rpc('social_worker_complete',{p_request_id:job.request_id,p_lease:job.lease,p_status:status,p_body:body});
   }
  }
 }
 return {poll(){if(!running&&Date.now()-lastPoll<3000)return Promise.resolve();if(!running){lastPoll=Date.now();running=drain().catch(()=>{console.error('Social import attempt failed; a leased job can retry.');}).finally(()=>{running=undefined;});}return running;}};
}
export function serve(worker,{port=Number(process.env.PORT||10000)}={}){
 const server=createServer((req,res)=>{
  const path=(req.url||'').split('?')[0];
  if((req.method==='GET'||req.method==='HEAD')&&(path==='/'||path==='/health')){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({status:'ok',service:'caribbean-hub-social-import',version:1}));return;}
  if((req.method==='GET'||req.method==='POST')&&path==='/wake'){res.writeHead(202,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"accepted":true}');void worker.poll();return;}
  res.writeHead(404);res.end();
 });
 server.listen(port,'0.0.0.0');void worker.poll();
 const timer=setInterval(()=>void worker.poll(),30000);timer.unref();
 const stop=()=>{clearInterval(timer);server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),20000).unref();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const {SUPABASE_URL,SUPABASE_ANON_KEY,WORKER_TOKEN}=process.env;
 if(!SUPABASE_URL||!SUPABASE_ANON_KEY||!WORKER_TOKEN)throw Error('Required worker configuration is missing');
 serve(createWorker({supabaseUrl:SUPABASE_URL,anonKey:SUPABASE_ANON_KEY,workerToken:WORKER_TOKEN}));
}
