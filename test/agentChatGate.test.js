import {test,mock,after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
mock.module('../src/db/pool.js',{defaultExport:{}});
mock.module('../src/services/redis.js',{namedExports:{redisClient:null}});
mock.module('../src/services/aiService.js',{namedExports:{getEmbedding:async()=>null}});
const {createAgentChatRouter,withSessionTurnClaim}=await import('../src/api/agentChat.js');
let sqlReads=0,embeds=0,completions=0;
const db={async query(){sqlReads++;return {rows:[]};},connect(){throw Error('Unexpected write');}};
const app=express();app.use(express.json());
app.use('/off',createAgentChatRouter({db,enabled:false}));
app.use('/on',createAgentChatRouter({db,enabled:true,embed:async()=>{embeds++;return null;},complete:async()=>{completions++;return 'bad';}}));
app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.status||500}));
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
after(()=>new Promise(resolve=>server.close(resolve)));
const base=`http://127.0.0.1:${server.address().port}`;
async function send(path,body,headers={}){
  const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',origin:'https://client.example',...headers},body:JSON.stringify(body)});
  await r.text();return r.status;
}
test('feature gate rejects without touching database or provider',async()=>{
  assert.equal(await send('/off',{sessionId:'one',message:'hi'},{'x-agent-token':'invalid'}),503);
  assert.equal(sqlReads,0);assert.equal(embeds,0);assert.equal(completions,0);
});
test('public ID, malformed credentials and caller ownership claims never authorize chat',async()=>{
  for(const [body,token,status] of [
    [{sessionId:'one',message:'hi'},'public-uuid',403],
    [{sessionId:'one',message:'hi',businessId:'victim'},'wct_'+'a'.repeat(43),400],
    [{sessionId:'one',message:'hi'},'wct_'+'a'.repeat(43),403],
  ]) assert.equal(await send('/on',body,{'x-agent-token':token}),status);
  assert.equal(embeds,0);assert.equal(completions,0);assert.equal(sqlReads,1);
});

test('turn claim completion waits for bounded cleanup retries',async()=>{
  let releases=0,workFinished=false;
  const claimDb={query:async(sql,params)=>{
    if(sql.startsWith('INSERT INTO agent_chat_turn_claims')) return {rows:[{claim_token:params[4]}]};
    if(sql.startsWith('DELETE FROM agent_chat_turn_claims')) {
      releases++;
      if(releases<3) throw Error('transient cleanup failure');
      return {rows:[]};
    }
    throw Error('Unexpected query');
  }};
  const result=await withSessionTurnClaim(claimDb,{
    business_id:'business',agent_id:'agent',deployment_id:'deployment',
  },'session',async()=>{workFinished=true;return 'reply ready';});
  assert.equal(workFinished,true);
  assert.equal(releases,3);
  assert.equal(result,'reply ready');
});

test('turn claim cleanup exhaustion rejects instead of reporting success',async()=>{
  let releases=0;
  const claimDb={query:async(sql,params)=>{
    if(sql.startsWith('INSERT INTO agent_chat_turn_claims')) return {rows:[{claim_token:params[4]}]};
    if(sql.startsWith('DELETE FROM agent_chat_turn_claims')) {
      releases++;
      throw Error('persistent cleanup failure');
    }
    throw Error('Unexpected query');
  }};
  await assert.rejects(
    withSessionTurnClaim(claimDb,{
      business_id:'business',agent_id:'agent',deployment_id:'deployment',
    },'session',async()=>({reply:'must not be emitted'})),
    /persistent cleanup failure/,
  );
  assert.equal(releases,3);
});
