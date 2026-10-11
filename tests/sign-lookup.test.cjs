'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parse, resolve, validateRows} = require('../sign-lookup.js');
const {header, records, csv} = require('./fixtures.cjs');
const clone = () => records.map(r=>[...r]);

test('UTF-8 BOM, CRLF/LF/CR, quoted commas/newlines/quotes and leading zeros are preserved', () => {
  const rows=clone();rows[0][1]='TEST, "日本語"\nFORMATION';
  const parsed=parse(csv(rows));
  assert.equal(parsed.rows.length,7);
  assert.equal(parsed.bySign.get('12345').formation,rows[0][1]);
  assert.equal(parsed.bySign.get('01010').sign,'01010');
  for(const newline of ['\n','\r'])assert.equal(parse(csv().replace(/\r\n/g,newline)).rows.length,7);
  assert.equal(parse(csv()+'\n\n').rows.length,7);
});

test('sign_raw is retained as provenance and never used to guess a normalized Sign', () => {
  const rows=clone();rows[0][4]='99999(88)';
  const mapping=parse(csv(rows));
  assert.equal(mapping.bySign.get('12345').sign_raw,'99999(88)');
  assert.equal(resolve(mapping,'99999').lookupStatus,'unmatched');
  assert.equal(resolve(mapping,'12345').play,'INSIDE ZONE');
});

test('CWM child Signs match branch + the last four parent digits for both branches', () => {
  const rows=clone();
  rows[4][0]='00042';rows[4][4]='00042';
  for(const [i,branch] of [[5,'1'],[6,'2']]){
    rows[i][0]=branch+'0042';rows[i][4]='00042('+branch+branch+')';rows[i][5]='00042';
  }
  const mapping=parse(csv(rows));
  for(const branch of ['1','2']){
    const sign=branch+'0042';
    assert.equal(resolve(mapping,'00042',branch).resolvedSign,sign);
    assert.deepEqual(resolve(mapping,'00042',branch),resolve(mapping,sign));
  }
});

const invalid = [
  ['wrong header',()=>csv().replace('record_type','type'),/ヘッダー/],
  ['extra header column',()=>csv().replace(header,header+',extra'),/ヘッダー/],
  ['missing column',()=>{const r=clone();r[0].pop();return csv(r);},/列数/],
  ['extra column',()=>{const r=clone();r[0].push('x');return csv(r);},/列数/],
  ['duplicate Sign',()=>csv([...clone(),records[0]]),/重複/],
  ['lost leading zero',()=>{const r=clone();r[4][0]='1010';return csv(r);},/半角数字5桁/],
  ['non-ASCII Sign',()=>{const r=clone();r[0][0]='１２３４５';return csv(r);},/半角数字5桁/],
  ['whitespace Sign',()=>{const r=clone();r[0][0]='12345 ';return csv(r);},/半角数字5桁/],
  ['unknown type',()=>{const r=clone();r[0][3]='cwm';return csv(r);},/record_type/],
  ['empty Formation',()=>{const r=clone();r[0][1]='';return csv(r);},/Formation/],
  ['empty normal Play',()=>{const r=clone();r[0][2]='';return csv(r);},/Play/],
  ['invalid raw provenance',()=>{const r=clone();r[0][4]='';return csv(r);},/sign_raw/],
  ['parent with Play',()=>{const r=clone();r[4][2]='guess';return csv(r);},/CWM親のPlay/],
  ['normal with parent/branch',()=>{const r=clone();r[0][5]='01010';return csv(r);},/空欄/],
  ['missing parent',()=>{const r=clone();r[5][5]='99999';return csv(r);},/親Signが存在/],
  ['normal used as parent',()=>{const r=clone();r[5][5]='12345';return csv(r);},/親Signが存在/],
  ['child used as parent',()=>{const r=clone();r[5][5]='21010';return csv(r);},/親Signが存在/],
  ['self-parent cycle',()=>{const r=clone();r[5][5]='11010';return csv(r);},/親Signが存在/],
  ['missing branch',()=>{const r=clone();r[5][6]='';return csv(r);},/枝番1・2/],
  ['out-of-range branch',()=>{const r=clone();r[5][6]='3';return csv(r);},/枝番1・2/],
  ['duplicate parent branch',()=>{const r=clone();r[6][6]='1';return csv(r);},/枝番が重複/],
  ['CWM child with incorrect parent suffix',()=>{const r=clone();r[5][0]='11011';return csv(r);},/CWM子Signは枝番＋親Signの後ろ4桁/],
  ['CWM child with incorrect branch prefix',()=>{const r=clone();r[6][0]='31010';return csv(r);},/CWM子Signは枝番＋親Signの後ろ4桁/],
  ['missing child',()=>csv(clone().slice(0,-1)),/両方が必要/],
  ['header only',()=>header,/データがありません/],
  ['empty document',()=>'',/ヘッダー/],
  ['empty quoted row',()=>csv()+'""\r\n',/列数/],
  ['all-empty seven-column row',()=>csv()+',,,,,,\r\n',/半角数字5桁/],
  ['unclosed quote',()=>header+'\n"12345',/引用符/],
  ['stray quote',()=>header+'\n12"345,F,P,normal,12345,,',/引用符/],
  ['characters after quote',()=>header+'\n"12345"x,F,P,normal,12345,,',/引用符/]
];
for(const [name,input,error] of invalid)test('rejects '+name,()=>assert.throws(()=>parse(input()),error));

test('normal, direct child, parent+branch, pending, unknown, blank and unloaded have explicit outcomes',()=>{
  const mapping=parse(csv());
  assert.equal(resolve(mapping,'12345').lookupStatus,'matched');
  const pending=resolve(mapping,'01010');
  assert.equal(pending.lookupStatus,'cwm_pending');assert.equal(pending.resolvedSign,'');assert.equal(pending.cwmBranch,'');assert.match(pending.play,/未確定/);
  const first=resolve(mapping,'01010','1');
  assert.equal(first.formation,'TEST CHILD ONE');assert.equal(first.play,'TEST PLAY ONE');assert.equal(first.resolvedSign,'11010');
  assert.deepEqual(first,resolve(mapping,'11010'));
  assert.equal(resolve(mapping,'01010','2').resolvedSign,'21010');
  assert.equal(resolve(mapping,'01010','3').lookupStatus,'cwm_pending');
  assert.equal(resolve(mapping,'99999').lookupStatus,'unmatched');
  assert.equal(resolve(null,'12345').lookupStatus,'not_loaded');
  assert.equal(resolve(mapping,'').lookupStatus,'empty');
});

test('restored malformed mappings are rejected',()=>{
  assert.throws(()=>validateRows(null),/データ/);
  assert.throws(()=>validateRows([{sign:12345}]),/文字列/);
});
