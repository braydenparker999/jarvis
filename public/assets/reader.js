import {API_ORIGIN} from './config.js';
async function refresh(){
 const button=document.getElementById('refresh'),status=document.getElementById('reader-status');button.disabled=true;status.textContent='Loading…';
 try{const r=await fetch(API_ORIGIN+'/shared/state',{cache:'no-store',signal:AbortSignal.timeout(15000)});const data=await r.json();if(!r.ok||!Array.isArray(data.unanswered))throw Error(data.error||'Shared inbox unavailable');document.getElementById('inbox').textContent=JSON.stringify(data,null,2);status.textContent='Shared inbox loaded';}
 catch(e){status.textContent=e.message;}finally{button.disabled=false;}
}
document.getElementById('refresh').onclick=refresh;refresh();
