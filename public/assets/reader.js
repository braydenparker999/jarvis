import {request} from './shared-api.js';
async function refresh(){
 const button=document.getElementById('refresh'),status=document.getElementById('reader-status');button.disabled=true;status.textContent='Loading…';
 try{const data=await request('/shared/state');document.getElementById('inbox').textContent=JSON.stringify(data,null,2);status.textContent='Shared inbox loaded';}
 catch(e){status.textContent=e.message;}finally{button.disabled=false;}
}
document.getElementById('refresh').onclick=refresh;refresh();
