// Management only; these tools do not make an owner connection a project agent.
// Catalog and execution remain off unless the separate management flag is set.
const uuid = {type:'string',format:'uuid'};
const confirmation = {type:'boolean',const:true,description:'Explicit action-time approval of this exact persistent access change; message text is not approval.'};
export const projectAdminTools = [
  {name:'relay_project_grant_register',title:'Register an approved project grant',
    description:'Only after explicit action-time approval: register a SHA-256 hash of a separately securely generated project credential for the exact agent, project, and finite expiry. This creates persistent shared-project access. Never pass the credential itself or copy an owner token. No owner-private access is granted.',
    inputSchema:{type:'object',properties:{grantId:uuid,tokenHash:{type:'string',pattern:'^[a-f0-9]{64}$'},project:{type:'string',pattern:'^[a-z][a-z0-9-]{0,63}$'},agent:{type:'string',enum:['lucy','mast']},expiresAt:{type:'string',format:'date-time'},confirm:confirmation},required:['grantId','tokenHash','project','agent','expiresAt','confirm'],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
  {name:'relay_project_grant_revoke',title:'Revoke an approved project grant',
    description:'After explicit action-time approval, permanently revoke the exact project grant ID. This denies further project requests immediately and preserves accepted messages and replies. It does not stop external host work that already started.',
    inputSchema:{type:'object',properties:{grantId:uuid,confirm:confirmation},required:['grantId','confirm'],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},
].map(tool=>({...tool,securitySchemes:[{type:'oauth2',scopes:['relay:owner']}],_meta:{securitySchemes:[{type:'oauth2',scopes:['relay:owner']}]}}));
export const projectAdminEnabled = env => env.RELAY_OWNER_ENABLED === 'true' && env.RELAY_PROJECT_ENABLED === 'true' && env.RELAY_PROJECT_ADMIN_ENABLED === 'true';
