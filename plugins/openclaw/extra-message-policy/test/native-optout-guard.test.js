import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createNativeOptOutGuard} from '../native-optout-guard.js';
test('native opt-out guard preserves exact account binding for shared agents',()=>{
 const guard=createNativeOptOutGuard({public:['400'],other:[]},{shared:['public','other']});
 const ctx={agentId:'shared',sessionKey:'agent:shared:discord:channel:200'};
 const message=account=>({role:'user',senderId:'400',idempotencyKey:'channel-user:v1:'+createHash('sha256').update(JSON.stringify(['discord',account,'channel:200','500'])).digest('hex'),__openclaw:{transport:{messageId:'500'}}});
 assert.deepEqual(guard({message:message('public')},ctx),{block:true});
 assert.equal(guard({message:message('other')},ctx),undefined);
 assert.equal(guard({message:{...message('public'),role:'assistant'}},ctx),undefined);
});
