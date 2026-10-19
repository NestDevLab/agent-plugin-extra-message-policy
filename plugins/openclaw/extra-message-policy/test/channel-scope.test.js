import assert from 'node:assert/strict';
import test from 'node:test';
import { admitChannelScope, admittedRecallRecord, normalizeChannelScopes } from '../channel-scope.js';
const scopes = normalizeChannelScopes([{accountId:'public',guildId:'100',channelIds:['200','201'],agentIds:['isolated']}]);
const base = {accountId:'public',guildId:'100',channelId:'200',content:'local text'};
test('mandatory roots, native thread parents, excluded channels and unknown provenance', () => {
  assert.equal(admitChannelScope(scopes,base).allowed,true);
  assert.equal(admitChannelScope(scopes,{...base,channelId:'201'}).allowed,true);
  assert.equal(admitChannelScope(scopes,{...base,channelId:'300',parentChannelId:'201'}).allowed,true);
  for (const change of [{channelId:'999'},{channelId:'300',parentChannelId:'999'},{guildId:''},{accountId:'',agentId:'isolated'}]) {
    assert.equal(admitChannelScope(scopes,{...base,...change}).allowed,false,JSON.stringify(change));
  }
  assert.equal(admitChannelScope(scopes,{...base,guildId:'101'}).protected,false);
  assert.equal(admitChannelScope(scopes,{...base,accountId:'other'}).protected,false);
});
test('quote IDs, forwarded text/media and thread starter/history fail closed', () => {
  for (const change of [{replyToId:'1'},{replyToIdFull:'1'},{replyToIsQuote:true},{ReplyToBody:'quote'},{ThreadStarterBody:'starter'},{ThreadHistoryBody:'old'}, {content:'[Forwarded message from @x]\nsecret'}, {media:[{path:'/tmp/a'}]}, {originalMedia:[{}]}, {mediaStagingPending:true}, {MediaPaths:['/tmp/a']}]) {
    assert.equal(admitChannelScope(scopes,{...base,...change}).allowed,false,JSON.stringify(change));
  }
  assert.equal(admitChannelScope(scopes,{...base,media:[],originalMedia:[],mediaStagingPending:false,replyToIsQuote:false}).allowed,true);
});
test('provider channelId cannot hide native numeric transport conversation', () => {
  assert.equal(admitChannelScope(scopes,{content:'text',metadata:{guildId:'100'}},{accountId:'public',channelId:'discord',conversationId:'channel:200'}).allowed,true);
});
test('protected recall requires post-admission stamp and record provenance', () => {
  const ctx = {agentId:'isolated'};
  assert.equal(admittedRecallRecord({...base,channelScopeAdmission:1},scopes,ctx),true);
  for(const record of [base,{...base,channelScopeAdmission:1,channelId:'999'},{...base,channelScopeAdmission:1,accountId:'other'},{...base,channelScopeAdmission:1,ReplyToId:'x'}]) assert.equal(admittedRecallRecord(record,scopes,ctx),false);
  assert.equal(admittedRecallRecord(base,scopes,{accountId:'public',guildId:'101'}),true);
});
test('invalid mandatory config fails startup rather than silently dropping the scope', () => {
  for(const raw of [{},[{}],[{accountId:'x',guildId:'100',channelIds:[]}], [{accountId:'x',guildId:'100',channelIds:['200'],agentIds:'oops'}]]) assert.throws(()=>normalizeChannelScopes(raw));
});
test('later opt-out excludes even previously admitted raw records',()=>{
  assert.equal(admittedRecallRecord({...base,channelScopeAdmission:1,senderId:'400'},scopes,{agentId:'isolated'},{public:['400']}),false);
});
test('only positively identified direct contexts bypass guild admission',()=>{
 assert.equal(admitChannelScope(scopes,{accountId:'public',content:'DM'}, {ChatType:'direct'}).protected,false);
 assert.equal(admitChannelScope(scopes,{accountId:'public',content:'DM'}, {sessionKey:'agent:legacy:discord:direct:400'}).protected,false);
 assert.equal(admitChannelScope(scopes,{accountId:'public',content:'ambiguous',isGroup:false},{}).allowed,false);
 assert.equal(admitChannelScope(scopes,{accountId:'public',content:'ambiguous'},{agentId:'isolated',ChatType:'direct'}).allowed,false);
});
