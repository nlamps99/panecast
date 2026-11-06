import { createBrokerServer } from '../../../broker/src/server.mjs';
import { createTmuxRelay, RelaySession } from '../../../relay-tmux/src/server.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mobileTurn } from '../../../relay-tmux/src/hub/codex-history.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const directory=await mkdtemp(join(tmpdir(),'panecast-ui-'));
let counter=1;
const timers = new Set();
const pendingSteers = new Set();
const source={id:'qa-codex',name:'Codex 模拟器测试',type:'codex',enabled:true,access:'control',mode:'attach',status:'online',capabilities:{read:true,control:true,realtime:true,create:true,resume:true}};
const threads=new Map([
 ['qa-long',{id:'qa-long',name:'长会话回归测试',cwd:directory,status:{type:'notLoaded'},live:false}],
 ['qa-saved',{id:'qa-saved',name:'继续对话回归测试',cwd:directory,status:{type:'notLoaded'},live:false}],
 ['qa-active',{id:'qa-active',name:'追加指令回归测试',cwd:directory,status:{type:'active'},live:true}],
]);
const history=new Map([
 ['qa-long',Array.from({length:20},(_,n)=>({id:'turn-'+n,status:'completed',items:[{id:'user-'+n,type:'userMessage',content:[{type:'text',text:'请检查项目 第 '+n+' 轮'}]},...Array.from({length:80},(_,i)=>({id:`cmd-${n}-${i}`,type:'commandExecution',command:'检查输出',aggregatedOutput:('x'.repeat(120)+'\n').repeat(35)})),{id:'answer-'+n,type:'agentMessage',text:'第 '+n+' 轮已经完成。'}]}))],
 ['qa-saved',[{id:'saved-turn',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'检查保存的任务'}]},{id:'a',type:'agentMessage',text:'已有任务完成，可以继续。'}]}]],
 ['qa-active', [{id:'stale-active',status:'inProgress',items:[]},{id:'active-turn',status:'inProgress',items:[{id:'active-user',type:'userMessage',content:[{type:'text',text:'正在处理一个模拟任务'}]}]}]],
]);
async function mode(){return process.env.PANECAST_UI_RAW_HISTORY === '1' ? 'raw' : 'normalized';}
class Session extends RelaySession {
 async dispatch(method,p){
  if(method==='source.list')return{sources:[source]};
  if(method==='relay.info')return{backend:'hub'};
  if(method==='agent.threads')return{threads:[...threads.values()],next_cursor:null};
  if(method==='agent.projects')return{projects:[{id:'qa-project',name:'模拟器项目',cwd:directory}]};
  if(method==='agent.pending')return{requests:[]};
  if(method==='agent.create'){
   const thread={id:'new-'+(++counter),name:p.name||'新对话测试',cwd:directory,status:{type:'idle'},live:true};
   threads.set(thread.id,thread);history.set(thread.id,[]);return{thread};
  }
  if(method.startsWith('agent.')){
   const thread=threads.get(p.thread_id);if(!thread)throw new Error('unknown thread');
   if(method==='agent.subscribe')return{thread};
   if(method==='agent.resume'){thread.live=true;thread.status={type:'idle'};return{thread};}
   if(method==='agent.read'){
    let turns=history.get(thread.id);const normalized=(await mode())==='normalized';
    if(normalized)turns=turns.slice(-5).map(mobileTurn);
    const snapshot=structuredClone({thread,turns,next_cursor:null,active_turn_id:thread.status.type==='active'?'active-turn':null});
    if(pendingSteers.has(thread.id)) await delay(5000);
    return snapshot;
   }
   if(method==='agent.steer'){
    if(p.turn_id!=='active-turn')throw Object.assign(new Error('错误的活动任务'),{code:'turn_changed'});
    pendingSteers.add(thread.id);
    const message={id:'steered-'+(++counter),clientId:p.client_message_id,type:'userMessage',content:[{type:'text',text:p.text}]};
    const timer=setTimeout(()=>{
      timers.delete(timer);pendingSteers.delete(thread.id);
      const turn=history.get(thread.id).find(t=>t.id==='active-turn');
      turn.items.push(message,{id:'steer-answer',type:'agentMessage',text:'已按追加指令继续处理'});turn.status='completed';thread.status={type:'idle'};
      for(const session of relay.sessions.values())if(session.hello){
        for(const item of turn.items.slice(-2))session.send({type:'event',category:'agent',name:'item/completed',payload:{source_id:source.id,threadId:thread.id,turnId:turn.id,item}});
        session.send({type:'event',category:'agent',name:'turn/completed',payload:{source_id:source.id,threadId:thread.id,turn:{id:turn.id,status:'completed',items:[]}}});
      }
    },3500);timers.add(timer);
    return{turnId:'active-turn',delivery:{client_message_id:p.client_message_id,turn_id:'active-turn',state:'accepted',mode:'steer'}};
   }
   if(method==='agent.send'){
    const id=String(++counter);history.set(thread.id,[...history.get(thread.id),{id:'sent-'+id,status:'completed',items:[{id:'user-'+id,clientId:p.client_message_id,type:'userMessage',content:[{type:'text',text:p.text}]},{id:'reply-'+id,type:'agentMessage',text:'已收到模拟器消息'}]}]);return{delivery:{client_message_id:p.client_message_id,turn_id:'sent-'+id,state:'accepted',mode:'start'}};
   }
   if(method==='agent.archive'){threads.delete(thread.id);return{};}
  }
  if(method==='window.list')return{windows:[]};
  if(method==='workspace.list')return{workspaces:[]};
  return super.dispatch(method,p);
 }
}
const broker=await createBrokerServer({host:'127.0.0.1',port:4498,relayId:'qa-mac',relayToken:'qa-relay-only',pairingCode:'qa-pair-only',dataFile:join(directory,'devices.json'),logger:{error(){}}});await broker.listen();
const config={state_directory:join(directory,'hub'),broker:{url:'http://127.0.0.1:4498',relay_id:'qa-mac',relay_token:'qa-relay-only'}};
const relay=await createTmuxRelay(config,{backend:{},createSession:({send,close,notify})=>new Session({},config,send,close,notify)});await relay.start();
console.log('QA fixture ready on localhost:4498');
const stop=async()=>{for(const timer of timers)clearTimeout(timer);await relay.close();await broker.close();await rm(directory,{recursive:true,force:true});process.exit(0);};process.once('SIGTERM',stop);process.once('SIGINT',stop);
