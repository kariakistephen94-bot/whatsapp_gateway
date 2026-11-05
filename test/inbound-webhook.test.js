import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboundForwarder} from '../src/inbound-webhook.js';
const env={WEBHOOK_URL:'http://127.0.0.1:5678/webhook/example',WEBHOOK_SECRET:'inbound-secret-0123456789',API_KEY:'other-key'};
test('inbound forwarding is disabled until configured and requires its own authentication',()=>{
 assert.equal(createInboundForwarder({}),null);
 assert.throws(()=>createInboundForwarder({...env,WEBHOOK_SECRET:''}),/valid WEBHOOK_SECRET/);
 assert.throws(()=>createInboundForwarder({...env,API_KEY:env.WEBHOOK_SECRET}),/valid WEBHOOK_SECRET/);
 assert.throws(()=>createInboundForwarder({...env,WEBHOOK_URL:'http://external.example/hook'}),/HTTPS/);
});
test('forwarding preserves the incoming payload, sets the correct header and cannot follow redirects',async()=>{
 const message={id:'abc',from:'2349138314501@s.whatsapp.net',text:'Hello'};
 const forward=createInboundForwarder(env,async(url,options)=>{
  assert.equal(url,env.WEBHOOK_URL);assert.equal(options.headers['X-Helios-Key'],env.WEBHOOK_SECRET);
  assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),message);
  return {ok:true,status:200};
 });
 assert.deepEqual(await forward(message),{accepted:true});
});
test('HTTP rejection and connection errors are reported without leaking message bodies or keys',async()=>{
 const forward=createInboundForwarder(env,async()=>({ok:false,status:403}));
 await assert.rejects(forward({text:'private'}),/^Error: Inbound webhook HTTP 403$/);
 const broken=createInboundForwarder(env,async()=>{throw new Error(env.WEBHOOK_SECRET)});
 await assert.rejects(broken({}),/^Error: Inbound webhook connection failed$/);
});
