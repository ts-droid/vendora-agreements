'use strict';
// Counterparties often send their markup as a spreadsheet: one row per clause with the original
// wording and the requested change (BleeqUp, October 2026). The comparison step accepts .xlsx and
// turns each row into a block of "Header: value" lines the Contract Lawyer can read as comments.
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');const zlib=require('zlib');
const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));

// A minimal .xlsx: a zip (deflated entries, like Excel writes) of the three parts the reader uses.
function crc32(buf){let crc=0xFFFFFFFF;for(let i=0;i<buf.length;i++){let c=(crc^buf[i])&0xFF;for(let k=0;k<8;k++)c=c&1?(c>>>1)^0xEDB88320:c>>>1;crc=(crc>>>8)^c;}return (crc^0xFFFFFFFF)>>>0;}
function zip(entries){
  const locals=[],centrals=[];let off=0;
  for(const e of entries){
    const data=Buffer.from(e.data,'utf8'),comp=zlib.deflateRawSync(data),name=Buffer.from(e.name),crc=crc32(data);
    const lh=Buffer.alloc(30);lh.writeUInt32LE(0x04034b50,0);lh.writeUInt16LE(20,4);lh.writeUInt16LE(8,8);lh.writeUInt32LE(crc,14);lh.writeUInt32LE(comp.length,18);lh.writeUInt32LE(data.length,22);lh.writeUInt16LE(name.length,26);
    const ch=Buffer.alloc(46);ch.writeUInt32LE(0x02014b50,0);ch.writeUInt16LE(20,4);ch.writeUInt16LE(20,6);ch.writeUInt16LE(8,10);ch.writeUInt32LE(crc,16);ch.writeUInt32LE(comp.length,20);ch.writeUInt32LE(data.length,24);ch.writeUInt16LE(name.length,28);ch.writeUInt32LE(off,42);
    locals.push(lh,name,comp);centrals.push(ch,name);off+=lh.length+name.length+comp.length;
  }
  const cd=Buffer.concat(centrals),eocd=Buffer.alloc(22);eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(entries.length,8);eocd.writeUInt16LE(entries.length,10);eocd.writeUInt32LE(cd.length,12);eocd.writeUInt32LE(off,16);
  return Buffer.concat([...locals,cd,eocd]);
}
const strings=['Vendora × Example Contract Comment V1','No.','Clause','Original Clause content','Counterparty Comment',
  'Reduction of exclusive rights requires one hundred and eighty (180) days’ written notice.','Change the date 180 days into 90 days','Change 30 days into 5 work days &amp; notify by email'];
const sharedXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="8" uniqueCount="8">'
  +strings.map((s,i)=>i===6?'<si><r><t xml:space="preserve">Change the date </t></r><r><rPr><b/></rPr><t>180 days into 90 days</t></r></si>':'<si><t>'+s+'</t></si>').join('')+'</sst>';
const sheetXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
  +'<row r="1"><c r="A1" t="s"><v>0</v></c></row>'
  +'<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c><c r="C2" t="s"><v>3</v></c><c r="D2" t="s"><v>4</v></c><c r="E2" s="1"/></row>'
  +'<row r="3"><c r="A3"><v>1</v></c><c r="B3"><v>3</v></c><c r="C3" t="s"><v>5</v></c><c r="D3" t="s"><v>6</v></c></row>'
  +'<row r="4"/>'
  +'<row r="5"><c r="A5"><v>2</v></c><c r="B5"><v>8</v></c><c r="C5" t="inlineStr"><is><t>Inspect within thirty (30) calendar days_x000D_</t></is></c><c r="D5" t="s"><v>7</v></c><c r="E5" t="b"><v>1</v></c></row>'
  +'</sheetData></worksheet>';
const workbookXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Contract Comment" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>';
const fixture=zip([{name:'[Content_Types].xml',data:'<Types/>'},{name:'xl/workbook.xml',data:workbookXml},{name:'xl/sharedStrings.xml',data:sharedXml},{name:'xl/worksheets/sheet1.xml',data:sheetXml}]);
const expected=['## Contract Comment','Vendora × Example Contract Comment V1','',
  'No.: 1','Clause: 3','Original Clause content: Reduction of exclusive rights requires one hundred and eighty (180) days’ written notice.','Counterparty Comment: Change the date 180 days into 90 days','',
  'No.: 2','Clause: 8','Original Clause content: Inspect within thirty (30) calendar days','Counterparty Comment: Change 30 days into 5 work days & notify by email','E: TRUE'].join('\n');

test('browser: a spreadsheet of comments is read into text the comparison can use',{skip:!chrome?'Chrome unavailable':false,timeout:120000},async()=>{
  Object.assign(process.env,{DATABASE_URL:'',NODE_ENV:'test',ANTHROPIC_API_KEY:'',GOOGLE_SERVICE_ACCOUNT_JSON:'',SMTP_USER:'',SMTP_PASS:''});
  const app=require('../server');
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  let browser;
  try{
    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
    await page.setRequestInterception(true);page.on('request',r=>{/^https?:\/\/127\.0\.0\.1/.test(r.url())?r.continue():r.abort();});
    await page.goto(base+'/',{waitUntil:'networkidle0'});
    const b64=fixture.toString('base64');
    const text=await page.evaluate(async b64=>{const bin=atob(b64),u8=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);return xlsxToText(u8.buffer);},b64);
    assert.equal(text,expected);
    const read=await page.evaluate(async b64=>{const bin=atob(b64),u8=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);const f=new File([u8],'Vendora Contract comment V1.xlsx');const r=await readContractFile(f);return {kind:r.kind,filename:r.filename,start:r.data.slice(0,19)};},b64);
    assert.deepEqual(read,{kind:'text',filename:'Vendora Contract comment V1.xlsx',start:'## Contract Comment'});
    const refused=await page.evaluate(async()=>{try{await readContractFile(new File([new Uint8Array(100)],'notes.pptx'));return 'accepted';}catch(e){return e.message;}});
    assert.equal(refused,'Unsupported file type — use PDF, Word (.docx), Excel (.xlsx) or text.');
    assert.deepEqual(pageErrors,[]);
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
});

test('the comparison upload offers .xlsx',()=>{
  const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
  assert.match(html,/id='cr_file_"\+t\+"' accept='\.pdf,\.docx,\.xlsx,\.txt,\.md'/);
  assert.match(html,/PDF, Word \(\.docx\), Excel \(\.xlsx\) or text, up to 50 MB\. A spreadsheet of comments, one row per clause, works too\./);
  assert.match(html,/name\.endsWith\("\.xlsx"\)\) text=await xlsxToText\(/);
});
