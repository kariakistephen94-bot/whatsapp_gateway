import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveInboundIdentity} from '../src/inbound-identity.js';
test('direct phone chats and provider alternate IDs resolve without guessing',async()=>{
 assert.equal((await resolveInboundIdentity({remoteJid:'2349138314501:2@s.whatsapp.net'})).from,'2349138314501@s.whatsapp.net');
 const result=await resolveInboundIdentity({remoteJid:'999999999@lid',remoteJidAlt:'2349138314501@s.whatsapp.net'});
 assert.equal(result.from,'2349138314501@s.whatsapp.net');assert.equal(result.source,'provider_alternate');
});
test('LID mapping resolves real provider mappings and preserves unknown identities',async()=>{
 const key={remoteJid:'999999999@lid'};
 assert.equal((await resolveInboundIdentity(key,{getPNForLID:async()=> '2349138314501@s.whatsapp.net'})).source,'provider_mapping');
 assert.deepEqual(await resolveInboundIdentity(key,{getPNForLID:async()=>null}),{from:key.remoteJid,resolved:false});
 assert.deepEqual(await resolveInboundIdentity(key,{getPNForLID:async()=>{throw new Error('unavailable')}}),{from:key.remoteJid,resolved:false});
});
test('group and broadcast chats cannot be mistaken for a phone contact',async()=>{
 let called=false;
 const result=await resolveInboundIdentity({remoteJid:'12345@g.us',participant:'999@lid',remoteJidAlt:'2349138314501@s.whatsapp.net'},{getPNForLID:async()=>{called=true}});
 assert.equal(result.from,'12345@g.us');assert.equal(result.resolved,false);assert.equal(called,false);
 assert.equal((await resolveInboundIdentity({remoteJid:'status@broadcast',remoteJidAlt:'2349138314501@s.whatsapp.net'})).resolved,false);
});
