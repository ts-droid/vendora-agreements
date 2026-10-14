const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('saved agreements table fits a desktop and the counterparty name opens the editor', function () {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /\.shell\.archive-open\{max-width:1440px\}/);
  assert.match(html, /\.archive-scroll\{overflow-x:auto\}/);
  assert.match(html, /shell\.classList\.toggle\("archive-open", n===3\)/);
  assert.match(html, /<th class='actions'>Actions<\/th>/);
  assert.match(html, /<button type='button' class='archive-name' onclick='archiveEdit\("\+id\+"\)'>/);
  assert.equal(html.indexOf('min-width:840px'), -1);
  const tableAt = html.indexOf("class='archive-table'");
  const table = html.slice(tableAt, html.indexOf('el.innerHTML = html', tableAt));
  assert.equal(table.indexOf('overflow-x:scroll'), -1);
  assert.match(table, /class='actions'/);
  assert.match(html, /\.archive-btn\{font-size:11px;line-height:normal;padding:3px 8px;border:2px outset #000;/);
  assert.match(html, /\.archive-btn-delete\{color:#c0392b\}/);
  assert.match(table, /class='archive-btn' onclick=\\"document\.getElementById\('ovFile_/);
  assert.match(table, /class='archive-btn' onclick='ovRemind/);
  assert.match(table, /class='archive-btn' onclick='archiveEdit/);
  assert.match(table, /class='archive-btn' onclick='archiveDownload/);
  assert.match(table, /class='archive-btn archive-btn-delete' onclick='archiveDelete/);
  assert.equal(table.indexOf("style='margin-right:6px;cursor:pointer'>&#9998; Edit"), -1);
});
