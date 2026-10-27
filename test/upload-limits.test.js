'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const fs=require('node:fs');
const limits=require('../upload-limits');
const extract=require('../document-extract');
const aiDoc=require('../ai-document');
function pdf(size){const b=Buffer.alloc(size,32);b.write('%PDF-1.7\n');return b;}
function multipart(bytes){
  const req=Readable.from([Buffer.from('--TEST\r\nContent-Disposition: form-data; name="file"; filename="large.pdf"\r\nContent-Type: application/pdf\r\n\r\n'),bytes,Buffer.from('\r\n--TEST--\r\n')]);
  req.headers={'content-type':'multipart/form-data; boundary=TEST'};return req;
}
test('the browser and all server paths share one 50 MB limit',()=>{
  assert.equal(limits.MAX_FILE_BYTES,50*1024*1024);assert.equal(extract.MAX_BYTES,limits.MAX_FILE_BYTES);
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');assert.equal((html.match(/file.size>UploadLimits.MAX_FILE_BYTES/g)||[]).length,5);
  assert.doesNotMatch(html,/max (5|8|15) MB|up to (5|8|15) MB/i);
  assert.match(fs.readFileSync(require.resolve('../server'),'utf8'),/limit: uploadLimits.MAX_REVIEW_BODY_BYTES/);
});
test('multipart accepts exactly 50 MB, refuses one byte more and leaves the unpacked safety limit intact',async()=>{
  let bytes=pdf(limits.MAX_FILE_BYTES);let result=await extract.readRequest(multipart(bytes));assert.equal(result.ok,true);assert.equal(result.file.buffer.length,limits.MAX_FILE_BYTES);assert.equal(extract.sniff('large.pdf',result.file.buffer).ok,true);
  bytes=null;result=null;
  const oversized=await extract.readRequest(multipart(pdf(limits.MAX_FILE_BYTES+1)));assert.equal(oversized.status,413);assert.match(oversized.error,/50 MB/);
  assert.equal(extract.MAX_UNCOMPRESSED,50*1024*1024);assert.equal(extract.MAX_PARSERS,2);
});
test('PDF base64 limit measures decoded bytes including the exact boundary',()=>{
  let doc={kind:'pdf',data:pdf(limits.MAX_FILE_BYTES).toString('base64')};assert.equal(aiDoc.pdfBytes(doc).length,limits.MAX_FILE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({doc,ourText:'x'.repeat(400000)}))<limits.MAX_REVIEW_BODY_BYTES);
  doc=null;assert.throws(()=>aiDoc.pdfBytes({kind:'pdf',data:pdf(limits.MAX_FILE_BYTES+1).toString('base64')}),e=>e.status===413);
  assert.throws(()=>aiDoc.pdfBytes({kind:'pdf',data:'%%%'}),/valid base64 PDF/);
});
test('large PDF uses an expiring provider file and removes it after success or AI error',async()=>{
  const doc={kind:'pdf',filename:'large.pdf',data:pdf(limits.MAX_INLINE_PDF_BYTES+1).toString('base64')};
  for(const failure of [false,true]){
    const calls=[];const transport=async(url,opts)=>{calls.push({url,method:opts.method});if(opts.method==='POST'){assert.equal(opts.body.get('expires_in_seconds'),'3600');assert.equal(opts.body.get('file').size,limits.MAX_INLINE_PDF_BYTES+1);return {ok:true,json:async()=>({id:'file_test_123'})};}return {ok:true};};
    const run=aiDoc.withDocument(doc,async prepared=>{assert.equal(prepared.data,undefined);assert.equal(prepared._serverFileSource.file_id,'file_test_123');if(failure)throw new Error('mock AI failure');return 'reviewed';},{apiKey:'mock',fetch:transport});
    if(failure)await assert.rejects(run,/mock AI failure/);else assert.equal(await run,'reviewed');
    assert.deepEqual(calls.map(c=>c.method),['POST','DELETE']);
  }
});
test('small files cannot smuggle provider file IDs into an AI request',async()=>{
  for(const doc of [{kind:'pdf',data:pdf(100).toString('base64')},{kind:'text',data:'text'}])await aiDoc.withDocument({...doc,_serverFileSource:{type:'file',file_id:'file_someone_else'}},async actual=>{assert.equal(actual._serverFileSource,undefined);},{fetch:()=>{throw Error('unexpected external call');}});
});

test('HTTP raw attachment route accepts exactly 50 MB and returns JSON 413 above it',async()=>{
  const db=require('../db'),auth=require('../auth'),app=require('../server');
  const orig={query:db.query,enabled:db.enabled};db.enabled=true;
  db.query=async(sql,params)=>{
    if(/INSERT INTO agreement_files/.test(sql)){assert.equal(params[3],limits.MAX_FILE_BYTES);return {rows:[{id:1,size_bytes:params[3]}]};}
    if(/UPDATE agreements/.test(sql))return {rows:[{status_updated_at:'test'}]};
    return {rows:[{id:1,type:'ra',created_by:1,status:'draft',data:{_type:'ra'}}]};
  };
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const cookie=auth.COOKIE+'='+auth.signToken({id:1,email:'test@vendora.se',name:'Test'});
  try{
    const url='http://127.0.0.1:'+server.address().port+'/api/agreements/1/files';
    for(const extra of [0,1]){
      const r=await fetch(url,{method:'POST',headers:{cookie,'Content-Type':'application/pdf','X-Filename':'large.pdf'},body:pdf(limits.MAX_FILE_BYTES+extra)});const body=await r.json();assert.equal(r.status,extra?413:200,JSON.stringify(body));if(extra)assert.match(body.error,/50 MB/);
    }
  }finally{db.query=orig.query;db.enabled=orig.enabled;await new Promise(r=>server.close(r));}
});
