// 对话 SSE 流。主对话与侧栏提问共用这一套帧格式，只是端点不同，
// 所以把读流的部分收进 openStreamAt，两个入口各自传自己的 url。
export function openChatStream(body, handlers) {
  return openStreamAt('/api/ai/chat', body, handlers);
}

export function openSidebarStream(body, handlers) {
  return openStreamAt('/api/ai/sidebar/chat', body, handlers);
}

// 监工跑一轮：同一套帧格式（POST /api/ai/supervise/run）
export function openSuperviseStream(body, handlers) {
  return openStreamAt('/api/ai/supervise/run', body, handlers);
}

// 托管模式：监工 ⇄ 工作者那一整场（POST /api/ai/hosted/run）
export function openHostedStream(body, handlers) {
  return openStreamAt('/api/ai/hosted/run', body, handlers);
}

function openStreamAt(url, body, { onEvent, onError, onDone, onAbort } = {}) {
  const ctrl = new AbortController();
  const run = (async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).message || msg; } catch { /* ignore */ }
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // 兼容 \r\n 帧分隔
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const lines = frame.split(/\r?\n/).filter((l) => l.startsWith('data:'));
          if (!lines.length) continue;
          const raw = lines.map((l) => l.slice(5).trim()).join('\n');
          try {
            onEvent?.(JSON.parse(raw));
          } catch { /* skip */ }
        }
      }
      onDone?.();
    } catch (e) {
      if (e.name === 'AbortError') {
        onAbort?.();
      } else {
        onError?.(e);
      }
    }
  })();
  return { abort: () => ctrl.abort(), done: run };
}
