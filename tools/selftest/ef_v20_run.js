/* v20：附图缩略图 + 动效开关，1440×900 同源 iframe，量真实布局与 computed 值 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DIST = 'D:/1/kharness-NewUI-dev/client/dist/';
fs.copyFileSync(path.join(__dirname, 'ef_probe_v20.html'), DIST + '_p20' + Date.now() + '.html');
const file = fs.readdirSync(DIST).filter((f) => /^_p20\d+\.html$/.test(f)).sort().pop();
const URL = 'http://127.0.0.1:8421/' + file;
let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--user-data-dir=D:/tmp/ef_chrome_v5',
    '--window-size=1460,980', '--virtual-time-budget=45000', '--dump-dom', URL], { maxBuffer: 40 * 1024 * 1024 }).toString();
} catch (e) { console.log('CHROME FAIL', String(e.message).slice(0, 200)); }
fs.writeFileSync(path.join(__dirname, 'ef_probe_v20_full.html'), dom);
const m = dom.match(/PROBE(\{[\s\S]*?\})<\/div>/);
if (!m) { console.log('无读数；DOM 尾部：\n' + dom.slice(-1200)); process.exit(0); }
const j = JSON.parse(m[1].replace(/&quot;/g, '"'));
(j.diag.rows || []).forEach((r) => console.log(JSON.stringify(r)));
(j.diag.checks || []).forEach((c) => console.log((c.pass ? 'PASS ' : 'FAIL ') + c.n + ' [want ' + c.want + '] [got ' + c.got + ']'));
console.log('TOTAL', j.total, 'FAIL', j.fail);
try { fs.unlinkSync(DIST + file); } catch (e) {}
