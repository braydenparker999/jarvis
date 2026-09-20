import {createSharedApi} from './shared-api.js';
import {createDirectApi} from './direct-api.js';
const direct=createDirectApi(),legacy=createSharedApi();
async function refresh(){
 const button=document.getElementById('refresh'),status=document.getElementById('reader-status');button.disabled=true;status.textContent='Loading…';
 try{
  let data,notice;
  try{data=await direct('/shared/state');notice=data.publisher.ok?'Shared inbox loaded · publications connected':'Shared inbox loaded · publication sync delayed: '+(data.publisher.error||'Retry pending');}
  catch(e){data=await legacy('/shared/state');notice='Current inbox loaded · publication upgrade not ready: '+e.message;}
  document.getElementById('inbox').textContent=JSON.stringify(data,null,2);status.textContent=notice;
 }
 catch(e){status.textContent=e.message;}finally{button.disabled=false;}
}
document.getElementById('refresh').onclick=refresh;refresh();
