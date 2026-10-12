/**
 * 「保存设置把没读的字段冲成默认值」这一类事故不许再犯（第六十九轮补，他真机撞上）：
 * 默认上下文窗口原本是 1000000，点一次「保存上游设置」之后变成 0。
 *
 * 根因不在服务端 —— 在服务端那五个数字项的**前端初值**：`ref(360)/ref(0)/ref(16)/ref(80)`。
 * 只要 loadAll 里那段没跑成（接口失败、或回填前就点了保存），payload 就把这几个
 * 「看着像默认」的数原样写回去；而 `Number(x) || 0` 还顺手把「清空输入框」也变成 0。
 * 0 在 default_context_limit 上是**有意义的具体值**（不限），根本不能当兜底。
 *
 * 服务端本身没问题：PUT 只动请求体里出现过的键（当场验过：单独 PUT default_context_limit
 * 之后，cmd_timeout_seconds / rl_retry_max 等一概没动）。所以修法全在前端：没读到 = null = 不提交。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../src');
const s = fs.readFileSync(path.join(SRC, 'features/settings/SettingsPage.vue'), 'utf8');
const save = s.slice(s.indexOf('async function saveUpstream'), s.indexOf('async function setApproval'));

describe('数字项没读到就不许提交', () => {
  it('五个数字项的初值必须是 null（不许再拿 360 / 0 / 16 / 80 冒充真值）', () => {
    for (const n of ['cmdTimeout', 'defaultContext', 'compressThreshold', 'rlRetryMax', 'gwRetryMax']) {
      expect(new RegExp(`const ${n} = ref\\(null\\)`).test(s)).toBe(true);
    }
    expect(s).toMatch(/const upstreamReady = ref\(false\)/);
  });

  it('保存只带「确实有值」的项，一个都没有就不发请求', () => {
    expect(save).toMatch(/const payload = \{\};/);
    expect(save).toMatch(/val !== null && val !== undefined && String\(val\)\.trim\(\) !== ''/);
    expect(save).toMatch(/if \(!Object\.keys\(payload\)\.length\)/);
    // 老写法一律不许回来
    expect(save).not.toMatch(/Number\(defaultContext\.value\) \|\| 0/);
    expect(save).not.toMatch(/Number\(compressThreshold\.value\) \|\| 80/);
  });

  it('没读到之前那颗保存键是灰的（不让人对着空框点保存）', () => {
    expect(s).toMatch(/:disabled="!upstreamReady"/);
    expect(s).toMatch(/upstreamReady\.value = true;/);
  });

  it('空着的输入框要说清楚「空 = 不提交」，不是「空 = 0」', () => {
    const ph = s.match(/:placeholder="txt\('settings\.unsetPlaceholder'\)"/g) || [];
    expect(ph.length).toBeGreaterThanOrEqual(5);
    // 三处 localStorage 镜像写入都必须带「值是 null 就不写」的护栏（写在守卫里才算过，光看有 setItem 不算）
    const guarded = s.match(/if \(\w+\.value !== null\) localStorage\.setItem\('nu_(cmd_timeout|ctx|rl)'/g) || [];
    expect(guarded.length).toBe(3);
  });
});
