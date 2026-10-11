'use strict';

// Pure local parsing/validation. No real sign data is bundled with this app.
(function (root) {
  const COLUMNS = ['sign', 'formation', 'play', 'record_type', 'sign_raw', 'parent_sign', 'branch'];
  const digitSign = value => /^[0-9]{5}$/.test(value);
  const fail = (row, reason) => { throw new Error(`CSV ${row}行目: ${reason}`); };

  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], value = '', quoted = false, closed = false, line = 1, rowLine = 1;
    function endRow() {
      row.push(value);
      // Ignore empty physical lines, not seven-column rows with missing values.
      if (row.length !== 1 || row[0].trim() !== '' || closed) rows.push({cells: row, line: rowLine});
      row = []; value = ''; closed = false;
    }
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { value += '"'; i++; }
          else { quoted = false; closed = true; }
        } else {
          value += c;
          if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line++;
        }
      } else if (c === ',') {
        row.push(value); value = ''; closed = false;
      } else if (c === '\r' || c === '\n') {
        endRow();
        if (c === '\r' && text[i + 1] === '\n') i++;
        line++; rowLine = line;
      } else if (c === '"' && !closed && value === '') {
        quoted = true;
      } else {
        if (closed || c === '"') fail(line, '引用符の形式が不正です。');
        value += c;
      }
    }
    if (quoted) fail(rowLine, '引用符が閉じられていません。');
    endRow();
    const header = rows.shift();
    if (!header || header.cells.length !== COLUMNS.length || header.cells.some((v, i) => v !== COLUMNS[i])) {
      throw new Error('CSVのヘッダーは sign,formation,play,record_type,sign_raw,parent_sign,branch の7列が必要です。');
    }
    return rows.map(({cells, line}) => {
      if (cells.length !== COLUMNS.length) fail(line, '列数が7列ではありません。');
      return {record: Object.fromEntries(COLUMNS.map((key, i) => [key, cells[i]])), line};
    });
  }

  function validateRows(records, lines) {
    if (!Array.isArray(records) || !records.length) throw new Error('CSVに対応表のデータがありません。');
    lines = lines || records.map((_, i) => i + 2);
    const bySign = new Map(), children = new Map();
    records.forEach((record, i) => {
      const line = lines[i];
      if (!record || COLUMNS.some(key => typeof record[key] !== 'string')) fail(line, '7列の文字列データが必要です。');
      if (!digitSign(record.sign)) fail(line, 'Signは半角数字5桁が必要です（先頭の0も必要）。');
      if (bySign.has(record.sign)) fail(line, 'Signが重複しています。');
      if (!record.formation.trim()) fail(line, 'Formationが空欄です。');
      // sign_raw is provenance, not an instruction or a second matching key.
      if (!/^[0-9]{5}(\([0-9]{2}\))?$/.test(record.sign_raw)) {
        fail(line, 'sign_rawは5桁、または5桁(2桁)が必要です。');
      }
      if (!['normal', 'cwm_parent', 'cwm_choice'].includes(record.record_type)) fail(line, 'record_typeが不正です。');
      if (record.record_type === 'cwm_choice') {
        if (!digitSign(record.parent_sign) || !['1', '2'].includes(record.branch)) fail(line, 'CWM子には親Signと枝番1・2が必要です。');
      } else if (record.parent_sign !== '' || record.branch !== '') {
        fail(line, '通常Sign・CWM親のparent_signとbranchは空欄にしてください。');
      }
      if (record.record_type === 'cwm_parent') {
        if (record.play !== '') fail(line, 'CWM親のPlayは空欄にしてください。');
        children.set(record.sign, new Map());
      } else if (!record.play.trim()) fail(line, '通常Sign・CWM子のPlayが空欄です。');
      bySign.set(record.sign, record);
    });
    records.forEach((record, i) => {
      if (record.record_type !== 'cwm_choice') return;
      const branches = children.get(record.parent_sign);
      if (!branches) fail(lines[i], 'CWM子の親Signが存在しないか、CWM親ではありません。');
      if (branches.has(record.branch)) fail(lines[i], '同じCWM親の枝番が重複しています。');
      if (record.sign !== record.branch + record.parent_sign.slice(1)) fail(lines[i], 'CWM子Signは枝番＋親Signの後ろ4桁と一致する必要があります。');
      branches.set(record.branch, record);
    });
    records.forEach((record, i) => {
      if (record.record_type === 'cwm_parent' && children.get(record.sign).size !== 2) fail(lines[i], 'CWM親には枝番1・2の両方が必要です。');
    });
    return {rows: records, bySign, children};
  }

  function parse(text) {
    const parsed = parseCSV(text);
    return validateRows(parsed.map(x => x.record), parsed.map(x => x.line));
  }

  function resolve(mapping, sign, branch = '') {
    const base = {formation: '', play: '', resolvedSign: '', parentSign: '', cwmBranch: ''};
    if (!sign) return {...base, lookupStatus: 'empty'};
    if (!mapping) return {...base, lookupStatus: 'not_loaded'};
    const row = mapping.bySign.get(sign);
    if (!row) return {...base, lookupStatus: 'unmatched'};
    if (row.record_type === 'cwm_parent') {
      const child = mapping.children.get(sign).get(branch);
      if (!child) return {...base, formation: row.formation, play: 'CWM（枝番未確定）', parentSign: sign, lookupStatus: 'cwm_pending'};
      return {...base, formation: child.formation, play: child.play, resolvedSign: child.sign, parentSign: sign, cwmBranch: branch, lookupStatus: 'cwm_resolved'};
    }
    return {...base, formation: row.formation, play: row.play, resolvedSign: sign,
      parentSign: row.parent_sign, cwmBranch: row.branch, lookupStatus: row.record_type === 'normal' ? 'matched' : 'cwm_resolved'};
  }

  const api = {COLUMNS, parseCSV, validateRows, parse, resolve};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SignLookup = api;
})(globalThis);
