import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createConversationFixture,launchQualifiedBrowser,openConversationPage,closeConversationHarness,assertBrowserContained,assertNoPrivatePersistence,conversationMenu,RELAY_URL,OWNER_KEY,SITE} from './helpers/relay-conversation-browser-fixture.js';
// Frontend contract fixtures only. These do not qualify the pending MCP delivery route.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=','base64');
const pdf=Buffer.from('%PDF-1.4\n% Synthetic assistant file\n%%EOF\n');
test('incoming private file rows preserve text, search filenames, preview images and download documents safely',{timeout:120000},async t=>{
 const browser=await launchQualifiedBrowser(t);if(!browser)return;const h=createConversationFixture(t),pages=[];
 try{const owner=await h.pair(await h.oauth()),phone=await openConversationPage(browser,h,{owner,clock:false,width:320,height:568});pages.push(phone);const page=phone.page,original=crypto.randomUUID(),reply=crypto.randomUUID(),delivery=crypto.randomUUID();
  const files=[{id:crypto.randomUUID(),name:'Synthetic illustration.png',mimeType:'image/png',bytes:png},{id:crypto.randomUUID(),name:'Synthetic report.pdf',mimeType:'application/pdf',bytes:pdf}];
  const common={visibility:'private',author_authenticated:true,principal:'github:183016859',authentication_source:'owner-oauth-mcp'};
  const messages=[{...common,id:original,role:'user',body:'Synthetic report request',sequence:1,createdAt:'2026-10-10T18:00:00Z'},{...common,id:reply,role:'assistant',kind:'reply',replyTo:original,body:'Accepted text reply stays visible.',sequence:2,createdAt:'2026-10-10T18:00:01Z'},{...common,id:delivery,role:'assistant',replyTo:original,body:'',sequence:3,createdAt:'2026-10-10T18:00:02Z',attachments:files.map(({bytes,...item})=>({...item,messageId:delivery,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),state:'linked',visibility:'private',createdAt:'2026-10-10T18:00:02Z'}))}];
  phone.rule(r=>r.method==='GET'&&r.path==='/relay/owner/messages',async()=>Response.json({messages,nextCursor:null},{headers:{'Access-Control-Allow-Origin':SITE}}),100);
  phone.rule(r=>r.method==='GET'&&r.path==='/relay/owner/attachments/content',async({record})=>{assert.equal(record.headers.authorization,'Bearer '+owner.device_token);const url=new URL(record.url);assert.equal(url.searchParams.get('message_id'),delivery);const file=files.find(f=>f.id===url.searchParams.get('attachment_id'));assert.ok(file);return new Response(file.bytes,{headers:{'Content-Type':file.mimeType,'Access-Control-Allow-Origin':SITE}});},100);
  await page.goto(RELAY_URL);await page.getByRole('button',{name:'Download Synthetic report.pdf',exact:true}).waitFor();assert.equal(await page.getByText('Accepted text reply stays visible.',{exact:true}).count(),1);assert.equal(await page.locator(`[data-message-id="${delivery}"] .message-actions:visible`).count(),0);
  await conversationMenu(page,'Search messages');await page.locator('#relay-owner-search').fill('report.pdf');await page.getByRole('button',{name:'Download Synthetic report.pdf',exact:true}).waitFor();assert.equal(await page.locator('[data-message-id]').count(),1);await page.locator('#relay-owner-search').fill('');
  await page.getByRole('button',{name:'Preview Synthetic illustration.png',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.relay-linked-preview')?.naturalWidth===1);assert.equal(await page.locator('iframe,embed,object').count(),0);assert.equal(await page.getByRole('button',{name:'Preview Synthetic report.pdf',exact:true}).count(),0);
  const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download Synthetic report.pdf',exact:true}).click();const downloaded=await downloading;assert.deepEqual(await readFile(await downloaded.path()),pdf);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await conversationMenu(page,'Public chat');assert.equal(await page.locator('.relay-linked-attachment,.relay-linked-preview').count(),0);await conversationMenu(page,'Owner chat');await page.getByRole('button',{name:'Download Synthetic report.pdf',exact:true}).waitFor();
  await page.evaluate(key=>{localStorage.removeItem(key);dispatchEvent(new StorageEvent('storage',{key,newValue:null,storageArea:localStorage}));},OWNER_KEY);await page.waitForFunction(()=>!document.querySelector('.relay-linked-attachment'));await assertNoPrivatePersistence(page,files.map(f=>f.name));assertBrowserContained(phone);
 }finally{await closeConversationHarness(browser,h,pages);}
});
