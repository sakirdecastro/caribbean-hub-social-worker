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

// Google RSS does not include article images. Resolve only its fixed public
// endpoint here; publisher metadata remains with the existing bounded collector.
export async function resolveGoogleArticle(value,fetchImpl=fetch){
 const url=new URL(value);if(url.origin!=='https://news.google.com'||!/^\/rss\/articles\/[A-Za-z0-9_-]+$/.test(url.pathname))throw Error('invalid_google_article');
 const id=url.pathname.split('/').pop();
 const page=await fetchImpl(url.href,{redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!page.ok)throw Error('google_unavailable');const html=await page.text();if(html.length>2000000)throw Error('oversize');
 const signature=html.match(/data-n-a-sg="([^"<>]+)"/)?.[1],timestamp=html.match(/data-n-a-ts="([0-9]+)"/)?.[1];
 if(!signature||!timestamp)throw Error('google_resolution_unavailable');
 const args=['garturlreq',[['X','X',['X','X'],null,null,1,1,'US:en',null,1,null,null,null,null,null,0,1],'X','X',1,[1,1,1],1,1,null,0,0,null,0],id,Number(timestamp),signature];
 const response=await fetchImpl('https://news.google.com/_/DotsSplashUi/data/batchexecute',{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({'f.req':JSON.stringify([[['Fbv4je',JSON.stringify(args)]]])}),signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('google_resolution_unavailable');const text=await response.text();if(text.length>2000000)throw Error('oversize');
 for(const line of text.split('\n')){let rows;try{rows=JSON.parse(line);}catch{continue;}if(!Array.isArray(rows))continue;
  for(const row of rows){if(row?.[0]!=='wrb.fr'||row?.[1]!=='Fbv4je'||typeof row[2]!=='string')continue;const result=JSON.parse(row[2]);if(result?.[0]!=='garturlres')continue;const target=new URL(result[1]);if(target.protocol!=='https:'||target.username||target.password||target.port||target.hostname==='news.google.com')throw Error('invalid_publisher');return target.href;}
 }throw Error('google_resolution_unavailable');
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
   const jobs=await rpc('social_worker_claim',{});if(!Array.isArray(jobs)||jobs.length===0)break;
   for(const job of jobs){
    let status=599,body={};
    try{const request=metaRequest(job);const result=await fetchImpl(request.url,{headers:request.headers,redirect:'error',signal:AbortSignal.timeout(15000)});status=result.status;const text=await result.text();if(Buffer.byteLength(text)>2000000)throw Error('oversize');body=JSON.parse(text);}catch{status=599;body={};}
    // Never log credentials, Meta responses, URLs or request bodies.
    await rpc('social_worker_complete',{p_request_id:job.request_id,p_lease:job.lease,p_status:status,p_body:body});
   }
  }
  const images=await rpc('image_worker_claim',{});
  for(const job of (Array.isArray(images)?images:[])){
   let target=null;try{target=await resolveGoogleArticle(job.google_url,fetchImpl);}catch{/* Keep posts readable if upstream resolution fails. */}
   await rpc('image_worker_complete',{p_job_id:job.id,p_lease:job.lease,p_publisher_url:target});
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
