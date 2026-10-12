/**
 * #271 连接层：一套自己的 undici Agent（空闲连接我们比上游先放手）+ 按代理地址缓存的 ProxyAgent。
 *
 * 这里只钉接线与缓存形状；**"半死连接真的少了"是靠行为量出来的**，
 * 见 `_tmp_kh77/keepalive_ab_probe.js`（本地服务器空闲 2 秒就悄悄掐掉、同时回 `Keep-Alive: timeout=30`，
 * 拿 undici 默认 Agent 与 netclient 那份各跑一次对比）。
 */
import { describe, it, expect } from 'vitest';

const undici = require('undici');
const netclient = require('../utils/netclient');

describe('netclient：连接策略只有一个来源', () => {
  it('install() 幂等，并且装的就是我们自己那个 Agent（不显式传 dispatcher 的请求也走它）', () => {
    const a = netclient.install();
    expect(a).toBe(netclient.directAgent);
    expect(netclient.install()).toBe(a);
    expect(undici.getGlobalDispatcher()).toBe(a);
  });

  it('空闲上限被钉住：上游说 timeout=300 也不算数（keepAliveMaxTimeout 默认是 600 秒，那才是半死连接的来源）', () => {
    const o = netclient.clientOptions();
    expect(o.keepAliveTimeout).toBe(3000);
    expect(o.keepAliveMaxTimeout).toBeLessThan(10000);
    expect(netclient.KEEP_ALIVE_MAX_MS).toBe(o.keepAliveMaxTimeout);
  });

  it('同一个代理地址复用同一个 ProxyAgent（以前每次请求 new 一个、从不关闭 = 每提供商攒一套池子）', () => {
    const url = 'http://127.0.0.1:7890';
    const first = netclient.proxyAgentFor(url);
    expect(netclient.proxyAgentFor(url)).toBe(first);
    expect(netclient.proxyAgentFor('http://127.0.0.1:10809')).not.toBe(first);
  });
});
