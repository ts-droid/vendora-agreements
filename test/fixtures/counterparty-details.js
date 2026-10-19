'use strict';
function fixture(type='ra') {
  const supplier=type==='da';
  const name=supplier?'Extracted Supplier Ltd':'Extracted Customer AB';
  const role=supplier?'supplier':'customer';
  const party=`The ${role} is ${name}.`;
  const fields=[
    ['name',name,party],
    ['reg','CP-2026-002',`${name}: registration number CP-2026-002.`],
    ['vat','CPVAT002',`${name}: VAT ID CPVAT002.`],
    ['addr','Example Street 42',`${name}: registered address Example Street 42.`],
    ...(supplier?[
      ['eori','CPEORI002',`${name}: EORI number CPEORI002.`],
      ['contacts.fin.p.e','finance@supplier.example.test',`${name}: finance contact finance@supplier.example.test.`]
    ]:type==='ra'?[
      ['rcontacts.main.e','contact@customer.example.test',`${name}: main contact contact@customer.example.test.`]
    ]:[])
  ];
  return {raw:{party_name:name,role,ambiguous:false,party_evidence:party,source_ref:'Parties',note:'Synthetic test document, not live customer data.',fields:fields.map(([field,value,evidence])=>({field,value,evidence,source_ref:'Company details',confidence:'high'}))},doc:{kind:'text',filename:'synthetic-company.txt',data:[party,...fields.map(f=>f[2]),'Vendora Nordic AB; invoice@vendora.se; registration number 556843-5456.'].join('\n')}};
}
module.exports=fixture;
