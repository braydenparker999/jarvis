import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMessages, parseHistory, streamReply} from '../public/assets/quick-ai-core.js';

const sse = (text, {finish = true} = {}) => {
  const events = [ {choices:[{delta:{reasoning:'Private reasoning must not be displayed'}}]}, {choices:[{delta:{content:text}}]} ];
  if (finish) events.push({choices:[{delta:{},finish_reason:'stop'}]});
  return events.map(e => 'data: ' + JSON.stringify(e) + '\r\n\r\n').join('') + (finish ? 'data: [DONE]\r\n\r\n' : '');
};
const streamed = text => {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({start(controller) { for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1)); controller.close(); }}));
};
test('streams UTF-8 across byte and CRLF boundaries; ignores reasoning', async () => {
  const updates = [];
  const result = await streamReply({key:'test',messages:[{role:'user',content:'Hi'}],onText:t=>updates.push(t),fetcher:async(url, init)=>{
    assert.equal(url,'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(init.headers.Authorization,'Bearer test');
    const body = JSON.parse(init.body); assert.equal(body.stream,true); assert.equal(body.reasoning_effort,'low');
    return streamed(sse('¡Hola! 👋'));
  }});
  assert.deepEqual(updates,['¡Hola! 👋']); assert.equal(result.content,'¡Hola! 👋');
});
test('preserves partial response and fails on a truncated stream', async () => {
  let text = '';
  await assert.rejects(streamReply({key:'test',messages:[],onText:t=>text=t,fetcher:async()=>streamed(sse('Partial',{finish:false}))}),/before the reply finished/);
  assert.equal(text,'Partial');
});
test('free limit is actionable and does not automatically retry', async () => {
  let calls = 0;
  await assert.rejects(streamReply({key:'test',messages:[],onText:()=>{},fetcher:async()=>{calls++;return new Response('',{status:429});}}),/free usage limit/);
  assert.equal(calls,1);
});
test('abort signal reaches fetch and cancellation propagates', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(streamReply({key:'test',messages:[],signal:controller.signal,onText:()=>{},fetcher:async(url,init)=>{assert.equal(init.signal,controller.signal);init.signal.throwIfAborted();}}),{name:'AbortError'});
});
test('context keeps recent complete turns together and excludes interrupted assistant text', () => {
  const messages = [
    {role:'user',content:'x'.repeat(5000)}, {role:'assistant',content:'y'.repeat(5000),status:'complete'},
    {role:'user',content:'Latest'}, {role:'assistant',content:'Partial',status:'interrupted'},
    {role:'user',content:'Follow-up'}
  ];
  assert.deepEqual(buildMessages(messages).slice(1),[{role:'user',content:'Latest'},{role:'user',content:'Follow-up'}]);
});
test('reloaded in-flight replies become interrupted and drafts survive', () => {
  const s = parseHistory(JSON.stringify({version:1,active:'a',chats:[{id:'a',title:'Hi',draft:'Unsent',messages:[{role:'assistant',content:'Partial',status:'streaming'}]}]}));
  assert.equal(s.chats[0].messages[0].status,'interrupted'); assert.equal(s.chats[0].draft,'Unsent');
  assert.throws(()=>parseHistory('{bad')); assert.throws(()=>parseHistory('{"version":2,"chats":[]}'));
});
test('provider response length limit is surfaced', async () => {
  const result = await streamReply({key:'test',messages:[],onText:()=>{},fetcher:async()=>streamed(sse('Answer').replace('"stop"','"length"'))});
  assert.equal(result.truncated,true);
});
test('missing keys fail before network access', async () => {
  await assert.rejects(streamReply({key:'',messages:[],onText:()=>{},fetcher:()=>{throw new Error('Should not fetch');}}),/not been configured/);
});
