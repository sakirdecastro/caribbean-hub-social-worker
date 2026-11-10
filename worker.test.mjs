import {test} from 'node:test';import assert from 'node:assert/strict';
import {metaRequest,createWorker,resolveGoogleArticle} from './worker.mjs';
const credential='fixture-meta-token-never-real';
test('Meta requests restrict hosts/accounts and keep credentials out of URLs',()=>{
 const request=metaRequest({platform:'instagram',account:'government',reader_id:'17841400000000000',access_token:credential});const url=new URL(request.url);assert.equal(url.hostname,'graph.facebook.com');assert.match(url.searchParams.get('fields'),/business_discovery/);assert.ok(!request.url.includes(credential));assert.equal(request.headers.Authorization,'Bearer '+credential);
 const fb=metaRequest({platform:'facebook',account:'1234567890',access_token:credential});assert.match(new URL(fb.url).pathname,/published_posts$/);
 for(const account of ['https://localhost/','../private','name?token=x'])assert.throws(()=>metaRequest({platform:'instagram',account,reader_id:'1234567890',access_token:credential}));
});
test('the isolated worker claims and completes a leased job without forwarding Meta credentials to callbacks',async()=>{
 const calls=[];let claimed=false;
 const worker=createWorker({supabaseUrl:'https://fixture.supabase.co',anonKey:'public-fixture',workerToken:'worker-fixture',fetchImpl:async(url,options)=>{
  calls.push({url:String(url),options});
  if(String(url).includes('social_worker_claim')){const jobs=claimed?[]:[{request_id:-1,lease:'fixture-lease',platform:'facebook',account:'1234567890',access_token:credential}];claimed=true;return Response.json(jobs);}
  if(String(url).includes('graph.facebook.com'))return Response.json({data:[{message:'Public update'}]});
  return Response.json(true);
 }});
 await Promise.all([worker.poll(),worker.poll()]);assert.equal(calls.filter(c=>c.url.includes('graph.facebook.com')).length,1);
 const complete=calls.find(c=>c.url.includes('social_worker_complete'));const body=JSON.parse(complete.options.body);assert.equal(body.p_request_id,-1);assert.equal(body.p_lease,'fixture-lease');assert.equal(body.p_status,200);assert.ok(!complete.options.body.includes(credential));
});
test('Meta failures produce a generic failed job rather than leaking response/token data',async()=>{
 let first=true,completion;
 const worker=createWorker({supabaseUrl:'https://fixture.supabase.co',anonKey:'public',workerToken:'worker',fetchImpl:async(url,options)=>{
  if(String(url).includes('social_worker_claim')){if(!first)return Response.json([]);first=false;return Response.json([{request_id:-2,lease:'nonce',platform:'facebook',account:'1234567890',access_token:credential}]);}
  if(String(url).includes('graph.facebook.com'))throw Error('sensitive failure '+credential);
  if(String(url).includes('image_worker_claim'))return Response.json([]);
  completion=JSON.parse(options.body);return Response.json(true);
 }});await worker.poll();assert.equal(completion.p_status,599);assert.deepEqual(completion.p_body,{});assert.ok(!JSON.stringify(completion).includes(credential));
});

test('Google resolution stays on fixed endpoints and returns the publisher, never the generic image',async()=>{
 const calls=[];const resolved=await resolveGoogleArticle('https://news.google.com/rss/articles/ABC_123?oc=5',async(url,options)=>{calls.push({url:String(url),options});return calls.length===1?new Response('<div data-n-a-ts="1234" data-n-a-sg="public-signature"></div><meta property="og:image" content="google-logo">'):new Response(JSON.stringify([['wrb.fr','Fbv4je',JSON.stringify(['garturlres','https://publisher.example/story',1])]]));});
 assert.equal(resolved,'https://publisher.example/story');assert.equal(calls.length,2);assert.equal(new URL(calls[0].url).searchParams.get('hl'),'en-US');assert.equal(new URL(calls[0].url).searchParams.get('ceid'),'US:en');assert.ok(calls.every(c=>new URL(c.url).hostname==='news.google.com'));assert.equal(calls[1].options.method,'POST');assert.equal(calls[1].options.redirect,'error');
});
test('Google resolution rejects arbitrary targets, consent pages and insecure publisher results',async()=>{
 await assert.rejects(()=>resolveGoogleArticle('https://localhost/private',()=>{throw Error('must not fetch');}));
 await assert.rejects(()=>resolveGoogleArticle('https://news.google.com/rss/articles/ABC',async()=>new Response('Consent required')));
 let n=0;await assert.rejects(()=>resolveGoogleArticle('https://news.google.com/rss/articles/ABC',async()=>new Response(++n===1?'<div data-n-a-ts="123" data-n-a-sg="signature">':JSON.stringify([['wrb.fr','Fbv4je',JSON.stringify(['garturlres','http://publisher.example/story'])]]))));
});
