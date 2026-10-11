'use strict';
// Entirely fictional data. Never copy the user's real sign table into this file.
const header = 'sign,formation,play,record_type,sign_raw,parent_sign,branch';
const records = [
  ['12345','TRIPS RIGHT','INSIDE ZONE','normal','12345','',''],
  ['23456','DOUBLES LEFT','MESH','normal','23456','',''],
  ['34567','BUNCH RIGHT','FLOOD','normal','34567','',''],
  ['52647','STACK RIGHT','SLANT / FLAT','normal','52647','',''],
  ['01010','TEST PARENT','','cwm_parent','01010','',''],
  ['11010','TEST CHILD ONE','TEST PLAY ONE','cwm_choice','01010(11)','01010','1'],
  ['21010','TEST CHILD TWO','TEST PLAY TWO','cwm_choice','01010(22)','01010','2']
];
const escape = v => /[",\r\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v;
const csv = (rows = records) => '\uFEFF'+header+'\r\n'+rows.map(r=>r.map(escape).join(',')).join('\r\n')+'\r\n';
module.exports = {header, records, csv};
