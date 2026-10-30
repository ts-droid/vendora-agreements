'use strict';
// The marketplace clause let Vendora condition a marketplace authorisation on "minimum pricing". A supplier
// steering a reseller's resale prices is a hardcore restriction under EU competition law, whatever the
// channel, and the words contradicted §5 (the reseller is free to set its own prices). The authorisation
// may still carry conditions on content and brand presentation. No clause of any type may mention a
// minimum price again.
const {test}=require('node:test');const assert=require('node:assert/strict');
const clauses=require('../agreement-clauses');const D=require('../agreement-defaults.json');
const seeds=require('./fixtures/workflow-seeds.json');

test('no standard clause conditions anything on minimum pricing; the marketplace authorisation keeps its content and brand conditions',()=>{
  for(const type of ['ra','rb','da']){
    const data={...seeds[type],...D[type],_type:type};
    for(const c of clauses.catalog(type)){
      const text=c.render(data);
      assert.doesNotMatch(text,/minimum pric/i,type+' '+c.id);
      assert.doesNotMatch(text,/resale price maintenance|fixed resale price/i,type+' '+c.id);
    }
  }
  const m=clauses.text('ra','ra.marketplaces',{...seeds.ra,...D.ra,_type:'ra'});
  assert.match(m,/may be subject to conditions on content and brand presentation\./);
  assert.match(m,/shall not list, advertise, or sell the Products on any third-party online marketplace/);
  assert.match(m,/Selling the Products on any marketplace without valid authorisation shall constitute a material breach\./);
  // §5 still says the reseller sets its own prices.
  assert.match(clauses.text('ra','ra.s5.p1',{...seeds.ra,...D.ra,_type:'ra'}),/free to set its own retail prices/);
});
