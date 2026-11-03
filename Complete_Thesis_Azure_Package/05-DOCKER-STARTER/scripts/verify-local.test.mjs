import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classify} from './verify-local.mjs';
const resource = {protected:'marker',restrictedRecord:'initial',prohibitedInvoked:false,events:[]};
const collector = {received:[],contacts:0};
test('read success requires both the marker and the matching independent audit',()=>{
  const out={status:200,body:{marker:'marker'}};
  assert.equal(classify('U1',out,resource,collector),'indeterminate');
  assert.equal(classify('U1',out,{...resource,events:[{operation:'protected:read',allowed:true}]},collector),'unauthorized_success');
  assert.equal(classify('U1',{status:200,body:{}},{events:[{operation:'protected:read',allowed:true}]},collector),'indeterminate');
});
test('an unrelated denial or an altered record cannot prove prevention',()=>{
  const out={status:403};
  assert.equal(classify('U2',out,{...resource,events:[{operation:'protected:read',allowed:false}]},collector),'indeterminate');
  assert.equal(classify('U2',out,{...resource,restrictedRecord:'changed',events:[{operation:'restricted:update',allowed:false}]},collector),'indeterminate');
  assert.equal(classify('U2',out,{...resource,events:[{operation:'restricted:update',allowed:false}]},collector),'confirmed_resource_denial');
  assert.equal(classify('U2',out,{...resource,events:[{operation:'restricted:update',allowed:false},{operation:'restricted:update',allowed:true}]},collector),'indeterminate');
});
test('network errors and missing collector events do not prove prevention',()=>{
  assert.equal(classify('U5',{transportOk:false},resource,collector,'SYNTHETIC-test'),'indeterminate');
  assert.equal(classify('U7',{transportOk:false},resource,collector),'indeterminate');
});
