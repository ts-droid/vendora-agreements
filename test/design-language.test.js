const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('the agreement app uses the Plaud License portal design language', function () {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(html, /family=Outfit/);
  assert.match(html, /--accent:#df3314/);
  assert.match(html, /--sans:"Outfit"/);
  assert.match(html, /class="topbar"/);
  assert.match(html, /class="brand-mark on-light"/);
  assert.match(html, /src="\/vendora-nordic\.png"/);
  assert.match(html, /class="brand-rule"/);
  assert.match(html, /\.tab\.active\{[^}]*var\(--accent\)/);
  assert.ok(fs.existsSync(path.join(root, 'vendora-nordic.png')));
  const route = server.indexOf("app.get('/vendora-nordic.png'");
  const catchAll = server.indexOf("app.get('*'");
  assert.ok(route > 0);
  assert.ok(catchAll > route);
  // The wider Saved agreements table stays in place with the redesign.
  assert.match(html, /\.shell\.archive-open\{max-width:1440px\}/);
  assert.match(html, /\.archive-scroll\{overflow-x:auto\}/);
});
