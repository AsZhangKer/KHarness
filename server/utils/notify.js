// Windows 系统通知回退通道：浏览器 Web Notification 未授权/不可用时，由本机弹一条系统气泡通知
// 文本通过环境变量传给 PowerShell，绝不拼进命令串（避免命令注入）
const { execFile } = require('child_process');

const PS = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$n = New-Object System.Windows.Forms.NotifyIcon",
  "$n.Icon = [System.Drawing.SystemIcons]::Information",
  "$n.BalloonTipIcon = 'Warning'",
  "$n.BalloonTipTitle = $env:KH_NOTIFY_TITLE",
  "$n.BalloonTipText = $env:KH_NOTIFY_BODY",
  "$n.Visible = $true",
  "$n.ShowBalloonTip(12000)",
  "Start-Sleep -Milliseconds 800",
  "$n.Dispose()"
].join('; ');

function notify(title, body) {
  const t = String(title || 'KHarness').substring(0, 120);
  const b = String(body || '').substring(0, 400);
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', PS], {
        windowsHide: true,
        timeout: 20000,
        env: { ...process.env, KH_NOTIFY_TITLE: t, KH_NOTIFY_BODY: b }
      }, (err) => resolve({ ok: !err, error: err ? String(err.message).substring(0, 200) : '' }));
      return;
    }
    const { cmd, args } = process.platform === 'darwin'
      ? { cmd: 'osascript', args: ['-e', `display notification ${JSON.stringify(b)} with title ${JSON.stringify(t)}`] }
      : { cmd: 'notify-send', args: ['-u', 'critical', t, b] };
    execFile(cmd, args, { timeout: 10000 }, (err) => resolve({ ok: !err, error: err ? String(err.message).substring(0, 200) : '' }));
  });
}

module.exports = { notify };
