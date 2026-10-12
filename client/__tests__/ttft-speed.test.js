/**
 * 第七十一轮立起来的两格读数，第七十七轮续3 改过一次口径（他重新拍的）：
 *   首字 = **按下发送 → 上游第一个包**（思考/正文/工具调用谁先到算谁），记一次就不再改；
 *   服务端 done 帧的 ttft_ms 起点是「本机后端把请求发出去」，少了按下发送到后端那一段（实测 8ms 对 39ms），
 *   所以只允许在客户端没量到时兜底，不许再覆盖。
 *   第七十一轮那版「首字只认服务端 ttft_ms」的口径到此作废，行为用例见 perf-per-chat-round77.test.js。
 *
 * 这里守的是接线：三条产物路径都算「已经出字」、读数缺失显示「—」而不是 0.0s、
 * 速度分母只用生成时长、思考与正文都算产出。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../src');
const store = fs.readFileSync(path.join(SRC, 'features/chat/chatStore.js'), 'utf8');
const composer = fs.readFileSync(path.join(SRC, 'features/chat/ChatComposer.vue'), 'utf8');
const bar = fs.readFileSync(path.join(SRC, 'ui/WindowBar.vue'), 'utf8');

describe('首字：客户端那把表是权威，服务端 ttft_ms 只兜底', () => {
  it('done 帧不再无条件覆盖，只在没量到时才用服务端的', () => {
    expect(store).toMatch(/if \(!p\.firstTokenMs && evt\.ttft_ms > 0\) p\.firstTokenMs = evt\.ttft_ms;/);
    expect(store).not.toMatch(/if \(evt\.ttft_ms > 0\) state\.firstTokenMs = evt\.ttft_ms;/);
  });
  it('临时读数：没有锚点什么都不写（写 0 = 屏幕上那个坏掉的 0.0s），记过就不许重记', () => {
    const fn = store.slice(store.indexOf('function markFirstToken'), store.indexOf('function startSpeedTicker'));
    expect(fn).toMatch(/if \(!at\) return;/);
    expect(fn).toMatch(/if \(p\.firstTokenMs\) return;/);
    // 旧的「拿不到锚点就 Date.now() - Date.now()」写法不许回来
    expect(store).not.toMatch(/reply\._startedAt \|\| Date\.now\(\)/);
  });
  it('正文、思考、工具调用三条路都算「已经出字」', () => {
    const first = store.indexOf("} else if (t === 'delta')");
    const seg = store.slice(first, store.indexOf("} else if (t === 'compress')"));
    expect(seg).toMatch(/markArtifact\(p\);\s*\n\s*markFirstToken\(p, reply\);/);
    const tool = store.slice(store.indexOf("} else if (t === 'tool')"), store.indexOf("} else if (t === 'tool_result')"));
    expect(tool).toMatch(/markArtifact\(p\);\s*\n\s*markFirstToken\(p, reply\);/);
  });
  it('<1s 显示毫秒，没读数显示「—」', () => {
    expect(composer).toMatch(/if \(!ms\) return '—';/);
    expect(composer).toMatch(/ms < 1000 \? `\$\{Math\.round\(ms\)\}ms`/);
    expect(composer).not.toMatch(/\/ 1000\)\.toFixed\(1\) \+ 's'/);
  });
});

describe('tok/s：0.2 秒一刷、窗口 2 秒、收尾不含工具时间', () => {
  it('tick 200ms，窗口 2000ms', () => {
    expect(store).toMatch(/const SPEED_TICK_MS = 200;/);
    expect(store).toMatch(/const SPEED_WINDOW_MS = 2000;/);
    expect(store).toMatch(/\}, SPEED_TICK_MS\);/);
    expect(store).not.toMatch(/}, 2000\);/);
  });
  it('甩样本的条件是「比窗口老」，不许写反成「还在窗口内就甩」（secs 会恒等于一个 tick，实时值永远刷不出来）', () => {
    expect(store).toMatch(/while \(p\.samples\.length > 2 && now - p\.samples\[1\]\.t > SPEED_WINDOW_MS\) p\.samples\.shift\(\);/);
    expect(store).not.toMatch(/now - p\.samples\[1\]\.t <= SPEED_WINDOW_MS/);
  });
  it('速度分母只用生成时长（gen_ms 或本地累计），不许再拿整回合 latency 凑', () => {
    const done = store.slice(store.indexOf('} else if (t === \'done\')'), store.indexOf('if (evt.usage) {'));
    expect(done).toMatch(/evt\.gen_ms > 0 \? evt\.gen_ms \/ 1000 : genSeconds\(p\)/);
    expect(done).not.toMatch(/evt\.latency_ms \/ 1000/);
  });
  it('生成时段按「产物之间没有大空档」划分，工具执行那截不计入', () => {
    expect(store).toMatch(/const GEN_GAP_MS = 1500;/);
    expect(store).toMatch(/if \(!p\.segStart \|\| now - p\.segLast > GEN_GAP_MS\)/);
  });
  it('思考与正文都算进产出（同一把尺，两边都加进那一桶）', () => {
    const seg = store.slice(store.indexOf("} else if (t === 'delta')"), store.indexOf("} else if (t === 'compress')"));
    expect(seg).toMatch(/p\.streamTokens \+= estTok\(evt\.text\);/);
    expect(seg).toMatch(/p\.streamTokens \+= estTok\(rt\);/);
  });
});

describe('顶栏「检查更新」：最新发行版 + 当前版本号', () => {
  it('菜单里有一项打开 GitHub 发行页', () => {
    expect(bar).toMatch(/const RELEASES_URL = 'https:\/\/github\.com\/AsZhangKer\/KHarness\/releases';/);
    expect(bar).toMatch(/\{ label: '最新发行版', run: openReleases \}/);
    expect(bar).toMatch(/window\.open\(RELEASES_URL, '_blank', 'noopener'\)/);
  });
  it('底部那行版本号来自后端，不许写死', () => {
    expect(bar).toMatch(/当前版本 \$\{appVer\.value \|\| '读取中…'\}/);
    expect(bar).toMatch(/settingsApi\.appInfo\(\)/);
    expect(bar).toMatch(/\{ label: `当前版本 .*`, disabled: true \}/);
    // 「(空)」那个占位不许回来
    expect(bar).not.toMatch(/label: '\(空\)'/);
  });
});
