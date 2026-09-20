// GitHub is used only to prove the owner's identity during connector setup.
// No repository scope, phone key, browser storage or GitHub token passthrough.
export const OWNER_ID = 183016859;
const COOKIE = '__Host-jarvis_oauth';
const headers = {'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const redirect = (url,cookie) => new Response(null,{status:302,headers:{...headers,Location:url,...(cookie?{'Set-Cookie':cookie}:{})}});
const html = body => new Response(body,{headers:{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
const cookieValue = r => r.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
const setCookie = v => `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;

export async function ownerAuthorization(request,env,registry,{ISSUER,RESOURCE,CALLBACK,SCOPES,random,hash,challenge,error,bounded}) {
  const url=new URL(request.url),path=url.pathname;
  if(!['/oauth/authorize','/oauth/start','/oauth/github/callback'].includes(path))return null;
  if(!env.GITHUB_CLIENT_ID||!env.GITHUB_CLIENT_SECRET)return error('Owner sign-in is not configured',503);
  if(path==='/oauth/authorize'&&request.method==='GET') {
    const p=url.searchParams,client=await registry({op:'get',key:'client:'+p.get('client_id')});
    const scope=p.get('scope')||SCOPES.join(' ');
    if(!client.value||p.get('redirect_uri')!==CALLBACK||p.get('response_type')!=='code'||p.get('code_challenge_method')!=='S256'||!/^[-\w]{43}$/.test(p.get('code_challenge')||'')||p.get('resource')!==RESOURCE||!p.get('state')||p.get('state').length>2048||scope.split(' ').some(s=>!SCOPES.includes(s)))return error();
    const session=random();
    const saved=await registry({op:'put',key:'consent:'+await hash(session),expiresAt:Date.now()+600000,value:{...Object.fromEntries(p),scope}});
    if(saved.error)return error('temporarily_unavailable',503);
    // Explicit local consent prevents a previously approved GitHub app from
    // silently granting a new MCP client access.
    const response=html(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Jarvis</title><main><h1>Connect Jarvis to ChatGPT</h1><p>Allow ChatGPT to read the shared inbox, reply to messages and publish Daily Board briefings.</p><p>Only Brayden's GitHub account can approve this. Visitors to Jarvis do not need to sign in.</p><form method="post" action="/oauth/start"><input type="hidden" name="consent" value="${session}"><button>Approve and continue with GitHub</button></form></main>`);
    response.headers.set('Set-Cookie',setCookie(session));return response;
  }
  if(path==='/oauth/start'&&request.method==='POST') {
    if(request.headers.get('Origin')!==ISSUER)return error('origin_not_allowed',403);
    const form=new URLSearchParams(await bounded(request)),session=form.get('consent');
    if(!/^[a-f0-9]{64}$/.test(session||'')||cookieValue(request)!==session)return error('Invalid consent session',403);
    const approved=(await registry({op:'consume',key:'consent:'+await hash(session)})).value;
    if(!approved)return error('Consent session expired',400);
    const state=random(),verifier=random();
    const saved=await registry({op:'put',key:'github:'+await hash(state),expiresAt:Date.now()+600000,value:{approved,verifier,browserHash:await hash(session)}});
    if(saved.error)return error('temporarily_unavailable',503);
    const target=new URL('https://github.com/login/oauth/authorize');
    target.search=new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,redirect_uri:ISSUER+'/oauth/github/callback',state,code_challenge:await challenge(verifier),code_challenge_method:'S256',scope:'',allow_signup:'false'});
    return redirect(target.href);
  }
  if(path==='/oauth/github/callback'&&request.method==='GET') {
    const state=url.searchParams.get('state'),session=cookieValue(request);
    if(!/^[a-f0-9]{64}$/.test(state||'')||!/^[a-f0-9]{64}$/.test(session||'')||!url.searchParams.get('code'))return error('invalid_grant');
    const flow=(await registry({op:'consume',key:'github:'+await hash(state),match:{browserHash:await hash(session)}})).value;
    if(!flow)return error('invalid_grant');
    const tokenResponse=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,code:url.searchParams.get('code'),redirect_uri:ISSUER+'/oauth/github/callback',code_verifier:flow.verifier}),signal:AbortSignal.timeout(15000)});
    if(!tokenResponse.ok)return error('GitHub sign-in unavailable',502);
    const token=await tokenResponse.json();if(!token.access_token)return error('invalid_grant');
    const userResponse=await fetch('https://api.github.com/user',{headers:{Authorization:'Bearer '+token.access_token,Accept:'application/vnd.github+json','User-Agent':'Jarvis-owner-auth'},signal:AbortSignal.timeout(15000)});
    if(!userResponse.ok)return error('GitHub identity unavailable',502);
    const user=await userResponse.json();if(user.id!==OWNER_ID)return error('Only the Jarvis owner may connect an assistant',403);
    const code=random(),grantHash=random(),p=flow.approved;
    const grant={ownerId:OWNER_ID,hash:grantHash,client_id:p.client_id,redirect_uri:CALLBACK,challenge:p.code_challenge,resource:RESOURCE,scope:p.scope};
    const saved=await registry({op:'put',key:'grant:'+grantHash,value:{ownerId:OWNER_ID},expiresAt:null});
    if(saved.error)return error('temporarily_unavailable',503);
    const issued=await registry({op:'put',key:'code:'+await hash(code),value:grant,expiresAt:Date.now()+300000});
    if(issued.error)return error('temporarily_unavailable',503);
    const target=new URL(CALLBACK);target.search=new URLSearchParams({code,state:p.state,iss:ISSUER});
    return redirect(target.href,`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  }
  return error('method_not_allowed',405);
}
