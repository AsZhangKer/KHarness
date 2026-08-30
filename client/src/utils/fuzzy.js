// 模糊搜索：支持子序列匹配与编辑距离容错
export function fuzzyMatch(haystack, needle) {
  if (!needle) return true;
  const t = String(haystack).toLowerCase();
  const q = String(needle).toLowerCase().trim();
  if (!q) return true;
  if (t.includes(q)) return true;
  // 子序列匹配：q 的字符按顺序出现在 t 中（允许少量间隔）
  let ti = 0, qi = 0;
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) qi++;
    ti++;
  }
  if (qi === q.length) return true;
  // 对短查询，允许 1-2 编辑距离的单词级匹配
  if (q.length <= 8) {
    const words = t.split(/[\s\-_\/\.]+/);
    for (const w of words) {
      if (levenshtein(w, q) <= 1) return true;
      if (q.length >= 4 && levenshtein(w, q) <= 2) return true;
    }
  }
  return false;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3; // 早退
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

export function fuzzyFilter(list, query, fields) {
  if (!query || !String(query).trim()) return list;
  const q = String(query).trim();
  return list.filter(item =>
    fields.some(f => {
      const v = item[f];
      if (v == null) return false;
      return fuzzyMatch(String(v), q);
    })
  );
}
