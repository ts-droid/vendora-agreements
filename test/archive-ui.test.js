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
});
