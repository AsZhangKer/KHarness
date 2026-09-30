# KHarness Computer Use - coordinate/UIA engine daemon.
# Line-delimited JSON in on stdin, out on stdout. ASCII ONLY in this file:
# Windows PowerShell 5.1 decodes a BOM-less .ps1 with the ANSI codepage, so a single
# non-ASCII literal here breaks the parser on the user's machine (measured, round 42).
# Add-Type on PS 5.1 compiles C# 5: no string interpolation, no ?., no expression members.
# Coordinates are PHYSICAL PIXELS everywhere (the process is made DPI aware at startup),
# which is the same space the full-screen screenshot KHarness returns is drawn in --
# so "click the pixel you see in the image" stays true.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Win32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] d, int size);
  [DllImport("user32.dll")] public static extern ushort GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern short VkKeyScanW(char c);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint vk, uint mapType);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookExW(int idHook, HookProc lpfn, IntPtr hMod, uint tid);
  [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hhk, int n, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, System.Text.StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandleW(string name);

  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  public const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, MOVE = 0x0001, WHEEL = 0x0800;
  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left; public int top; public int right; public int bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public UIntPtr dwExtraInfo; }

  public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

  public static string Text(IntPtr h) {
    System.Text.StringBuilder sb = new System.Text.StringBuilder(512);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static string Cls(IntPtr h) {
    System.Text.StringBuilder sb = new System.Text.StringBuilder(256);
    GetClassNameW(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static string ExeOf(uint pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return "";
    System.Text.StringBuilder sb = new System.Text.StringBuilder(1024);
    uint size = (uint)sb.Capacity;
    if (!QueryFullProcessImageNameW(p, 0, sb, ref size)) return "";
    string full = sb.ToString();
    int i = full.LastIndexOf('\\');
    return i >= 0 ? full.Substring(i + 1) : full;
  }
}

public static class EnumWin {
  public delegate bool Proc(IntPtr h, IntPtr arg);
  [DllImport("user32.dll")] static extern bool EnumWindows(Proc cb, IntPtr arg);
  static Proc keep;
  static List<IntPtr> acc;
  public static IntPtr[] All() {
    acc = new List<IntPtr>();
    keep = delegate(IntPtr h, IntPtr a) { acc.Add(h); return true; };
    EnumWindows(keep, IntPtr.Zero);
    keep = null;
    return acc.ToArray();
  }
}

public static class Pipe {
  static BlockingCollection<string> inbox = new BlockingCollection<string>();
  static StreamWriter wr;
  static object gate = new object();

  public static void Start() {
    wr = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    wr.AutoFlush = true;
    Thread t = new Thread(new ThreadStart(Run));
    t.IsBackground = true;
    t.Start();
  }
  static void Run() {
    try {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        if (line.Trim().Length > 0) inbox.Add(line);
      }
    } catch { }
    inbox.Add("{\"cmd\":\"__eof__\"}");
  }
  public static string Poll() {
    string s;
    return inbox.TryTake(out s, 0) ? s : null;
  }
  public static void Say(string text) {
    lock (gate) { if (wr != null) wr.WriteLine(text); }
  }
}

// Emergency stop hotkey. Low-level hooks see input before any window does, which is the
// only way a mouse side button can cut the agent off while some other app has focus.
public static class Guard {
  static IntPtr khk = IntPtr.Zero, mhk = IntPtr.Zero;
  static Win32.HookProc kp, mp;
  static uint vk;
  static bool needCtrl, needAlt, needShift, needWin;
  static int xmButton;
  static bool down;
  static DateTime lastFire = DateTime.MinValue;

  const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
  const int WM_KEYDOWN = 0x0100, WM_SYSKEYDOWN = 0x0104, WM_XBUTTONDOWN = 0x020B;

  static bool Held(int k) { return (Win32.GetAsyncKeyState(k) & 0x8000) != 0; }
  static bool Mods() {
    bool c = Held(0x11), a = Held(0x12), s = Held(0x10), w = Held(0x5B) || Held(0x5C);
    return c == needCtrl && a == needAlt && s == needShift && w == needWin;
  }
  public static bool Active { get { return khk != IntPtr.Zero || mhk != IntPtr.Zero; } }

  public static string Start(string spec) {
    Stop();
    if (string.IsNullOrEmpty(spec)) return "no-spec";
    foreach (string raw in spec.ToLowerInvariant().Split('+')) {
      string p = raw.Trim();
      if (p.Length == 0) continue;
      if (p == "ctrl" || p == "control") needCtrl = true;
      else if (p == "alt" || p == "option") needAlt = true;
      else if (p == "shift") needShift = true;
      else if (p == "win" || p == "super" || p == "meta") needWin = true;
      else if (p == "xbutton1" || p == "mouse4" || p == "side1") xmButton = 1;
      else if (p == "xbutton2" || p == "mouse5" || p == "side2") xmButton = 2;
      else {
        vk = (uint)KeyByName(p);
        if (vk == 0) return "bad-key:" + p;
      }
    }
    if (vk == 0 && xmButton == 0) return "no-key";
    if (needCtrl || needAlt || needShift || needWin) {
      if (xmButton == 0 && vk != 0) {
        // A pure modifier+key accelerator is simpler and more reliable through the key hook,
        // but the modifier state read via GetAsyncKeyState is still required here.
      }
    }
    IntPtr mod = Win32.GetModuleHandleW(null);
    if (xmButton != 0) {
      mp = new Win32.HookProc(OnMouse);
      mhk = Win32.SetWindowsHookExW(WH_MOUSE_LL, mp, mod, 0);
      if (mhk == IntPtr.Zero) return "hook-failed";
    } else {
      kp = new Win32.HookProc(OnKey);
      khk = Win32.SetWindowsHookExW(WH_KEYBOARD_LL, kp, mod, 0);
      if (khk == IntPtr.Zero) return "hook-failed";
    }
    return "ok";
  }

  public static void Stop() {
    if (khk != IntPtr.Zero) { Win32.UnhookWindowsHookEx(khk); khk = IntPtr.Zero; }
    if (mhk != IntPtr.Zero) { Win32.UnhookWindowsHookEx(mhk); mhk = IntPtr.Zero; }
    kp = null; mp = null;
    needCtrl = needAlt = needShift = needWin = false; vk = 0; xmButton = 0; down = false;
  }

  static int KeyByName(string p) {
    switch (p) {
      case "esc": case "escape": return 0x1B;
      case "tab": return 0x09; case "enter": case "return": return 0x0D; case "space": return 0x20;
      case "backspace": return 0x08; case "delete": case "del": return 0x2E; case "insert": return 0x2D;
      case "home": return 0x24; case "end": return 0x23;
      case "pageup": case "pgup": return 0x21; case "pagedown": case "pgdn": return 0x22;
      case "up": return 0x26; case "down": return 0x27; case "left": return 0x25; case "right": return 0x28;
      case "printscreen": case "prtsc": return 0x2C;
      case "f1": return 0x70; case "f2": return 0x71; case "f3": return 0x72; case "f4": return 0x73;
      case "f5": return 0x74; case "f6": return 0x75; case "f7": return 0x76; case "f8": return 0x77;
      case "f9": return 0x78; case "f10": return 0x79; case "f11": return 0x7A; case "f12": return 0x7B;
      case "f13": return 0x7C; case "f14": return 0x7D; case "f15": return 0x7E; case "f16": return 0x7F;
    }
    if (p.Length == 1) {
      short s = Win32.VkKeyScanW(p[0]);
      return s < 0 ? 0 : (s & 0xFF);
    }
    return 0;
  }

  static IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam) {
    if (code == 0 && vk != 0) {
      int msg = (int)wParam;
      Win32.KBDLLHOOKSTRUCT k = (Win32.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Win32.KBDLLHOOKSTRUCT));
      if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
        if (k.vkCode == vk && !down && Mods()) { down = true; Fire(); return new IntPtr(1); }
      } else if (k.vkCode == vk) down = false;
    }
    return Win32.CallNextHookEx(khk, code, wParam, lParam);
  }

  static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam) {
    if (code == 0 && xmButton != 0 && (int)wParam == WM_XBUTTONDOWN) {
      Win32.MSLLHOOKSTRUCT m = (Win32.MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Win32.MSLLHOOKSTRUCT));
      if ((int)(m.mouseData >> 16) == xmButton && Mods()) { Fire(); return new IntPtr(1); }
    }
    return Win32.CallNextHookEx(mhk, code, wParam, lParam);
  }

  static void Fire() {
    DateTime now = DateTime.UtcNow;
    if ((now - lastFire).TotalMilliseconds < 600) return;
    lastFire = now;
    Pipe.Say("{\"ev\":\"hotkey\"}");
  }
}
'@ -ReferencedAssemblies @('System.Core')

# DPI awareness has to happen before any coordinate is read.
$dpi = 'none'
try {
  if ([Win32]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $dpi = 'per-monitor-v2' }
} catch { }
if ($dpi -eq 'none') { try { if ([Win32]::SetProcessDPIAware()) { $dpi = 'system' } } catch { } }

[Pipe]::Start()

$script:els = @{}          # ref -> UIA element (survives between calls, like netwright's refs)
$script:seq = 0

function To-Window([object]$h) { return [IntPtr]([Int64]$h) }

function Get-WindowInfo([IntPtr]$h) {
  $p = [uint32]0
  [void][Win32]::GetWindowThreadProcessId($h, [ref]$p)
  $r = New-Object Win32+RECT
  [void][Win32]::GetWindowRect($h, [ref]$r)
  return [pscustomobject]@{
    hwnd = [Int64]$h
    pid = [Int64]$p
    exe = [Win32]::ExeOf($p)
    title = [Win32]::Text($h)
    class = [Win32]::Cls($h)
    visible = [bool][Win32]::IsWindowVisible($h)
    minimized = [bool][Win32]::IsIconic($h)
    foreground = [bool]($h -eq [Win32]::GetForegroundWindow())
    x = [int]$r.left; y = [int]$r.top
    w = [int]($r.right - $r.left); h = [int]($r.bottom - $r.top)
  }
}

function Read-Std($obj, $name, $fallback) {
  if ($null -eq $obj) { return $fallback }
  $prop = $obj.PSObject.Properties[$name]
  if ($null -eq $prop -or $null -eq $prop.Value) { return $fallback }
  return $prop.Value
}

function Send-Mouse([uint32]$flags) {
  $i = New-Object Win32+INPUT
  $i.type = 0
  $i.u.mi.dx = 0
  $i.u.mi.dy = 0
  $i.u.mi.mouseData = [uint32]0
  $i.u.mi.dwFlags = $flags
  $i.u.mi.time = 0
  $i.u.mi.dwExtraInfo = [UIntPtr]::Zero
  [void][Win32]::SendInput(1, @($i), [System.Runtime.InteropServices.Marshal]::SizeOf([type]'Win32+INPUT'))
}

function Move-To([int]$x, [int]$y) {
  [void][Win32]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 12
}

$extKeys = @(0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x2C, 0x5B, 0x5C, 0x6F)

function Send-Key([int]$vk, [bool]$up) {
  $scan = [uint32][Win32]::MapVirtualKeyW([uint32]$vk, 0)
  $i = New-Object Win32+INPUT
  $i.type = 1
  $i.u.ki.wVk = [uint16]$vk
  $i.u.ki.wScan = [uint16]$scan
  $f = [uint32]0
  if ($up) { $f = $f -bor [Win32]::KEYEVENTF_KEYUP }
  if ($extKeys -contains $vk) { $f = $f -bor [Win32]::KEYEVENTF_EXTENDEDKEY }
  $i.u.ki.dwFlags = $f
  $i.u.ki.time = 0
  $i.u.ki.dwExtraInfo = [UIntPtr]::Zero
  [void][Win32]::SendInput(1, @($i), [System.Runtime.InteropServices.Marshal]::SizeOf([type]'Win32+INPUT'))
}

function Send-Unicode([char]$ch) {
  $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'Win32+INPUT')
  $i = New-Object Win32+INPUT
  $i.type = 1
  $i.u.ki.wVk = 0
  $i.u.ki.wScan = [uint16][int]$ch
  $i.u.ki.dwFlags = [Win32]::KEYEVENTF_UNICODE
  $i.u.ki.time = 0
  $i.u.ki.dwExtraInfo = [UIntPtr]::Zero
  $j = New-Object Win32+INPUT
  $j.type = 1
  $j.u.ki.wVk = 0
  $j.u.ki.wScan = [uint16][int]$ch
  $j.u.ki.dwFlags = ([Win32]::KEYEVENTF_UNICODE -bor [Win32]::KEYEVENTF_KEYUP)
  $j.u.ki.time = 0
  $j.u.ki.dwExtraInfo = [UIntPtr]::Zero
  [void][Win32]::SendInput(2, @($i, $j), $size)
}

$vkMap = @{
  'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'shift' = 0x10; 'win' = 0x5B; 'super' = 0x5B;
  'esc' = 0x1B; 'escape' = 0x1B; 'tab' = 0x09; 'enter' = 0x0D; 'return' = 0x0D; 'space' = 0x20;
  'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D; 'home' = 0x24; 'end' = 0x23;
  'pageup' = 0x21; 'pgup' = 0x21; 'pagedown' = 0x22; 'pgdn' = 0x22
  'up' = 0x26; 'down' = 0x27; 'left' = 0x25; 'right' = 0x28; 'prtsc' = 0x2C; 'printscreen' = 0x2C
  'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75
  'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
}

function Resolve-Vk([string]$token) {
  $t = $token.Trim().ToLowerInvariant()
  if ($t.Length -eq 0) { return $null }
  if ($vkMap.ContainsKey($t)) { return $vkMap[$t] }
  if ($t.Length -eq 1) {
    $s = [Win32]::VkKeyScanW($t[0])
    if ($s -lt 0) { return $null }
    return [int]($s -band 0xFF)
  }
  return $null
}

function Send-Combo([string]$combo) {
  $seq = @()
  foreach ($p in ($combo -split '\+')) {
    $v = Resolve-Vk ([String]$p)
    if ($null -eq $v) { throw ("unknown key " + $p) }
    $seq += [int]$v
  }
  if ($seq.Count -eq 0) { throw 'empty key combo' }
  foreach ($v in $seq) { Send-Key $v $false; Start-Sleep -Milliseconds 8 }
  $rev = @($seq); [Array]::Reverse($rev)
  foreach ($v in $rev) { Send-Key $v $true; Start-Sleep -Milliseconds 8 }
  return $seq
}

function Get-PatternState($el) {
  $out = @()
  $p = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) {
      $out += ([String]$p.Current.ToggleState).ToLowerInvariant()
    }
  } catch { }
  $p = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
      $out += ([String]$p.Current.ExpandCollapseState).ToLowerInvariant()
    }
  } catch { }
  $p = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
      if ($p.Current.IsSelected) { $out += 'selected' }
    }
  } catch { }
  return $out
}

function Get-ElementValue($el) {
  $p = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { return [String]$p.Value }
  } catch { }
  return ''
}

# One walk feeds both snapshot text and find results, so refs are assigned identically.
function Collect-Elements($root, [int]$maxNodes, [int]$maxDepth) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $list = New-Object System.Collections.Generic.List[object]
  $count = [int]0
  $script:els = @{}
  $script:seq = 0

  $walk = {
    param($el, $depth)
    if ($count -ge $maxNodes) { return }
    $script:seq++
    $ref = 'e' + $script:seq
    $script:els[$ref] = $el
    $name = ''
    try { $name = [String]$el.Current.Name } catch { }
    $ct = ''
    try { $ct = ([String]$el.Current.ControlType.ProgrammaticName) -replace 'ControlType\.', '' } catch { }
    $ct = $ct.ToLowerInvariant()
    $auto = ''
    try { $auto = [String]$el.Current.AutomationId } catch { }
    $enabled = $true
    try { $enabled = [bool]$el.Current.IsEnabled } catch { }
    $off = $false
    try { $off = [bool]$el.Current.IsOffscreen } catch { }
    $focus = $false
    try { $focus = [bool]$el.Current.HasKeyboardFocus } catch { }
    $cx = $null; $cy = $null; $w = 0; $h = 0; $rx = 0; $ry = 0
    try {
      $b = $el.Current.BoundingRectangle
      if (-not $b.IsEmpty) {
        $rx = [int]$b.X; $ry = [int]$b.Y; $w = [int]$b.Width; $h = [int]$b.Height
        $cx = [int]($b.X + $b.Width / 2); $cy = [int]($b.Y + $b.Height / 2)
      }
    } catch { }
    $states = @(Get-PatternState $el)
    $val = Get-ElementValue $el
    $keep = $true
    if ($off -and $depth -gt 0) { $keep = $false }
    if (-not $name) {
      if ($ct -eq 'pane' -or $ct -eq 'group' -or $ct -eq 'custom' -or $ct -eq 'image' -or $ct -eq 'text') { $keep = $false }
    }
    $node = [pscustomobject]@{
      ref = $ref; depth = $depth; keep = $keep; name = $name; control = $ct
      automation_id = $auto; x = $rx; y = $ry; w = $w; h = $h; cx = $cx; cy = $cy
      enabled = $enabled; offscreen = $off; focused = $focus; states = $states; value = $val
    }
    $list.Add($node) | Out-Null
    $child = $null
    try { $child = $walker.GetFirstChild($el) } catch { }
    while ($null -ne $child) {
      if ($count -ge $maxNodes) { break }
      $count++
      if ($depth + 1 -lt $maxDepth) { & $walk $child ($depth + 1) }
      $next = $null
      try { $next = $walker.GetNextSibling($child) } catch { }
      $child = $next
    }
  }
  $count++
  & $walk $root 0
  return $list
}

function Format-Snapshot($nodes) {
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($n in $nodes) {
    if (-not $n.keep) { continue }
    $indent = ('  ' * $n.depth)
    $label = if ($n.name) { '"' + $n.name + '"' } else { '(unnamed)' }
    $bits = @($indent, '-', ' ', $n.control, ' ', $label, ' [', $n.ref, ']')
    if ($n.automation_id) { $bits += (' #' + $n.automation_id) }
    if ($null -ne $n.cx) { $bits += (' @' + $n.cx + ',' + $n.cy) }
    $flags = @()
    if (-not $n.enabled) { $flags += 'disabled' }
    if ($n.focused) { $flags += 'focused' }
    foreach ($s in $n.states) { $flags += $s }
    if ($n.value) { $flags += ('value=' + $n.value) }
    if ($flags.Count) { $bits += (' ' + ($flags -join ' ')) }
    $lines.Add((-join $bits)) | Out-Null
  }
  return $lines
}

function Get-TargetElement($hwnd) {
  # Read-Std already unwrapped the property value, so the argument here is a plain number.
  # (Calling Read-Std on it a second time silently yielded 0, which made every snapshot
  # walk the desktop root instead of the requested window.)
  if ($null -eq $hwnd) { return [System.Windows.Automation.AutomationElement]::RootElement }
  $n = [Int64]0
  try { $n = [Int64]$hwnd } catch { $n = [Int64]0 }
  if ($n -eq 0) { return [System.Windows.Automation.AutomationElement]::RootElement }
  return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$n)
}

function Click-At([int]$x, [int]$y, [string]$button, [bool]$dbl) {
  Move-To $x $y
  $map = @{ left = @([Win32]::LEFTDOWN, [Win32]::LEFTUP); right = @([Win32]::RIGHTDOWN, [Win32]::RIGHTUP); middle = @([Win32]::MIDDLEDOWN, [Win32]::MIDDLEUP) }
  if (-not $map.ContainsKey($button)) { throw ("unknown button " + $button) }
  $pair = $map[$button]
  $times = if ($dbl) { 2 } else { 1 }
  for ($k = 0; $k -lt $times; $k++) {
    Send-Mouse ([uint32]$pair[0])
    Start-Sleep -Milliseconds 18
    Send-Mouse ([uint32]$pair[1])
    if ($k -lt $times - 1) { Start-Sleep -Milliseconds 45 }
  }
}

$running = $true
while ($running) {
  $line = [Pipe]::Poll()
  if ($null -eq $line) { Start-Sleep -Milliseconds 15; continue }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { [Pipe]::Say('{"id":0,"ok":false,"error":"bad json"}'); continue }
  $id = Read-Std $req 'id' 0
  $cmd = [String](Read-Std $req 'cmd' '')
  $a = Read-Std $req 'args' $null
  $res = [pscustomobject]@{ id = $id; ok = $true; data = $null; error = $null }
  try {
    switch ($cmd) {
      '__eof__' { $running = $false; break }
      'shutdown' { $res.data = @{ bye = $true }; $running = $false; break }
      'ping' { $res.data = @{ pong = $true; refs = $script:seq; dpi = $dpi }; break }
      'displays' {
        $list = @()
        $i = 0
        $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
        foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
          $list += [pscustomobject]@{ index = $i; name = $s.DeviceName; x = [int]$s.Bounds.X; y = [int]$s.Bounds.Y
            w = [int]$s.Bounds.Width; h = [int]$s.Bounds.Height; primary = [bool]$s.Primary
            work_x = [int]$s.WorkingArea.X; work_y = [int]$s.WorkingArea.Y
            work_w = [int]$s.WorkingArea.Width; work_h = [int]$s.WorkingArea.Height }
          $i++
        }
        $c = [System.Windows.Forms.Cursor]::Position
        $res.data = [pscustomobject]@{ list = $list; cursor = [pscustomobject]@{ x = [int]$c.X; y = [int]$c.Y }
          virtual = [pscustomobject]@{ x = [int]$vs.X; y = [int]$vs.Y; w = [int]$vs.Width; h = [int]$vs.Height } }
        break
      }
      'windows' {
        $rows = New-Object System.Collections.Generic.List[object]
        $fg = [Win32]::GetForegroundWindow()
        foreach ($h in [EnumWin]::All()) {
          if (-not [Win32]::IsWindowVisible($h)) { continue }
          $t = [Win32]::Text($h)
          $r = New-Object Win32+RECT
          [void][Win32]::GetWindowRect($h, [ref]$r)
          $w = [int]($r.right - $r.left); $hh = [int]($r.bottom - $r.top)
          $named = ($t -and $t.Trim().Length -gt 0 -and $w -gt 40 -and $hh -gt 40)
          if ($named -or ($h -eq $fg)) { $rows.Add((Get-WindowInfo $h)) | Out-Null }
          if ($rows.Count -ge 200) { break }
        }
        $fgNum = $fg.ToInt64()
        $arr = $rows.ToArray()
        $res.data = [pscustomobject]@{ list = $arr; foreground = $fgNum; count = $arr.Length }
        break
      }
      'foreground' {
        $h = [Win32]::GetForegroundWindow()
        $res.data = [pscustomobject]@{ window = if ($h -eq [IntPtr]::Zero) { $null } else { Get-WindowInfo $h } }
        break
      }
      'cursor_pos' {
        $p = New-Object Win32+POINT
        [void][Win32]::GetCursorPos([ref]$p)
        $res.data = [pscustomobject]@{ x = [int]$p.x; y = [int]$p.y }
        break
      }
      'activate' {
        $h = To-Window (Read-Std $a 'hwnd' 0)
        # Windows refuses SetForegroundWindow from a background process; a synthetic Alt tap buys the right.
        Send-Key 0x12 $false
        Send-Key 0x12 $true
        if ([Win32]::IsIconic($h)) { [void][Win32]::ShowWindow($h, 9) }
        [void][Win32]::BringWindowToTop($h)
        $ok = [Win32]::SetForegroundWindow($h)
        $res.data = [pscustomobject]@{ ok = [bool]$ok; now = [Int64][Win32]::GetForegroundWindow(); window = Get-WindowInfo ([Win32]::GetForegroundWindow()) }
        break
      }
      'window_state' {
        $h = To-Window (Read-Std $a 'hwnd' 0)
        $sw = 5
        switch ([String](Read-Std $a 'state' '')) {
          'minimize' { $sw = 6 } 'maximize' { $sw = 3 } 'restore' { $sw = 9 } 'hide' { $sw = 0 }
        }
        [void][Win32]::ShowWindow($h, $sw)
        $res.data = [pscustomobject]@{ shown = $sw; window = Get-WindowInfo $h }
        break
      }
      'close_window' {
        $h = To-Window (Read-Std $a 'hwnd' 0)
        [void][Win32]::PostMessageW($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
        $res.data = [pscustomobject]@{ posted = 'WM_CLOSE'; window = Get-WindowInfo $h }
        break
      }
      'move_window' {
        $h = To-Window (Read-Std $a 'hwnd' 0)
        $ok = [Win32]::MoveWindow($h, [int](Read-Std $a 'x' 0), [int](Read-Std $a 'y' 0), [int](Read-Std $a 'w' 100), [int](Read-Std $a 'h' 100), $true)
        $res.data = [pscustomobject]@{ ok = [bool]$ok; window = Get-WindowInfo $h }
        break
      }
      'snapshot' {
        $root = Get-TargetElement (Read-Std $a 'hwnd' $null)
        if ($null -eq $root) { throw 'no UI Automation element for that window: the app exposes no automation tree (use screenshot + coordinates)' }
        $maxNodes = [int](Read-Std $a 'max_nodes' 260)
        $maxDepth = [int](Read-Std $a 'max_depth' 26)
        $nodes = Collect-Elements $root $maxNodes $maxDepth
        $lines = Format-Snapshot $nodes
        $kept = @($nodes | Where-Object { $_.keep }).Count
        $res.data = [pscustomobject]@{ text = ($lines -join "`n"); lines = $lines.Count; nodes = $nodes.Count; kept = $kept; truncated = [bool]($nodes.Count -ge $maxNodes) }
        break
      }
      'find' {
        $root = Get-TargetElement (Read-Std $a 'hwnd' $null)
        if ($null -eq $root) { throw 'no UI Automation element for that window' }
        $want = ([String](Read-Std $a 'name' '')).Trim().ToLowerInvariant()
        $ct = ([String](Read-Std $a 'control' '')).Trim().ToLowerInvariant()
        $auto = ([String](Read-Std $a 'automation_id' '')).Trim()
        $nodes = Collect-Elements $root ([int](Read-Std $a 'max_nodes' 400)) 30
        $hits = New-Object System.Collections.Generic.List[object]
        foreach ($n in $nodes) {
          if ($n.offscreen) { continue }
          if ($ct -and $n.control -ne $ct) { continue }
          if ($auto -and $n.automation_id -ne $auto) { continue }
          if ($want -and ([String]$n.name).ToLowerInvariant().IndexOf($want) -lt 0) { continue }
          $hits.Add([pscustomobject]@{ ref = $n.ref; name = $n.name; control = $n.control; automation_id = $n.automation_id
            x = $n.cx; y = $n.cy; w = $n.w; h = $n.h; enabled = $n.enabled; states = $n.states }) | Out-Null
          if ($hits.Count -ge 40) { break }
        }
        $res.data = [pscustomobject]@{ list = $hits.ToArray(); scanned = $nodes.Count }
        break
      }
      'element_info' {
        $ref = [String](Read-Std $a 'ref' '')
        if (-not $script:els.ContainsKey($ref)) { throw ("stale ref " + $ref + " (take a new snapshot)")}
        $el = $script:els[$ref]
        $b = $el.Current.BoundingRectangle
        $res.data = [pscustomobject]@{
          ref = $ref; name = [String]$el.Current.Name
          control = (([String]$el.Current.ControlType.ProgrammaticName) -replace 'ControlType\.', '').ToLowerInvariant()
          automation_id = [String]$el.Current.AutomationId; class_name = [String]$el.Current.ClassName
          enabled = [bool]$el.Current.IsEnabled; offscreen = [bool]$el.Current.IsOffscreen
          value = (Get-ElementValue $el); states = @(Get-PatternState $el)
          x = [int]($b.X + $b.Width / 2); y = [int]($b.Y + $b.Height / 2)
        }
        break
      }
      'act' {
        $ref = [String](Read-Std $a 'ref' '')
        $op = [String](Read-Std $a 'op' 'invoke')
        if (-not $script:els.ContainsKey($ref)) { throw ("stale ref " + $ref + " (take a new snapshot)")}
        $el = $script:els[$ref]
        $did = ''
        $p = $null
        if ($op -eq 'invoke' -and $el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); $did = 'invoke' }
        $p = $null
        if (-not $did -and $op -eq 'toggle' -and $el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); $did = 'toggle' }
        $p = $null
        if (-not $did -and ($op -eq 'expand' -or $op -eq 'collapse') -and $el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
          if ($op -eq 'expand') { $p.Expand() } else { $p.Collapse() }
          $did = $op
        }
        $p = $null
        if (-not $did -and $op -eq 'select' -and $el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); $did = 'select' }
        $p = $null
        if (-not $did -and $op -eq 'set_value' -and $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $p.SetValue([String](Read-Std $a 'value' '')); $did = 'set_value' }
        $p = $null
        if (-not $did -and $op -eq 'focus' -and $el.TryGetCurrentPattern([System.Windows.Automation.FocusPattern]::Pattern, [ref]$p)) { $p.SetFocus(); $did = 'focus' }
        if (-not $did) {
          $b = $el.Current.BoundingRectangle
          if ($b.IsEmpty) { throw ("element " + $ref + " has no screen rectangle and supports no pattern for " + $op) }
          Click-At ([int]($b.X + $b.Width / 2)) ([int]($b.Y + $b.Height / 2)) 'left' $false
          $did = 'click-fallback'
        }
        $res.data = [pscustomobject]@{ did = $did; ref = $ref; op = $op }
        break
      }
      'click' {
        $x = $null; $y = $null
        $ref = [String](Read-Std $a 'ref' '')
        if ($ref) {
          if (-not $script:els.ContainsKey($ref)) { throw ("stale ref " + $ref + " (take a new snapshot)")}
          $b = $script:els[$ref].Current.BoundingRectangle
          if ($b.IsEmpty) { throw ("element " + $ref + " has no screen rectangle") }
          $x = [int]($b.X + $b.Width / 2); $y = [int]($b.Y + $b.Height / 2)
        } else {
          $x = [int](Read-Std $a 'x' -1); $y = [int](Read-Std $a 'y' -1)
          if ($x -lt 0 -or $y -lt 0) { throw 'click needs x and y, or a ref from the last snapshot' }
        }
        $btn = [String](Read-Std $a 'button' 'left'); if (-not $btn) { $btn = 'left' }
        $dbl = [bool](Read-Std $a 'dbl' $false)
        Click-At $x $y $btn $dbl
        $res.data = [pscustomobject]@{ x = $x; y = $y; button = $btn; dbl = $dbl; ref = $ref }
        break
      }
      'move_mouse' {
        Move-To ([int](Read-Std $a 'x' 0)) ([int](Read-Std $a 'y' 0))
        $res.data = [pscustomobject]@{ x = [int](Read-Std $a 'x' 0); y = [int](Read-Std $a 'y' 0) }
        break
      }
      'drag' {
        $x1 = [int](Read-Std $a 'x1' 0); $y1 = [int](Read-Std $a 'y1' 0)
        $x2 = [int](Read-Std $a 'x2' 0); $y2 = [int](Read-Std $a 'y2' 0)
        $steps = [int](Read-Std $a 'steps' 16)
        if ($steps -lt 2) { $steps = 2 }
        Move-To $x1 $y1
        Send-Mouse ([uint32][Win32]::LEFTDOWN)
        Start-Sleep -Milliseconds 25
        for ($s = 1; $s -le $steps; $s++) {
          $px = [int]($x1 + ($x2 - $x1) * $s / $steps)
          $py = [int]($y1 + ($y2 - $y1) * $s / $steps)
          Move-To $px $py
          Start-Sleep -Milliseconds 6
        }
        Send-Mouse ([uint32][Win32]::LEFTUP)
        $res.data = [pscustomobject]@{ from_x = $x1; from_y = $y1; to_x = $x2; to_y = $y2 }
        break
      }
      'scroll' {
        $x = [int](Read-Std $a 'x' 0); $y = [int](Read-Std $a 'y' 0)
        Move-To $x $y
        $notch = [int](Read-Std $a 'amount' 3) * 120
        if ([String](Read-Std $a 'dir' 'down') -eq 'up') { $notch = -$notch }
        $i = New-Object Win32+INPUT
        $i.type = 0
        $i.u.mi.dx = 0
        $i.u.mi.dy = 0
        $i.u.mi.mouseData = [uint32]([int]$notch)
        $i.u.mi.dwFlags = [Win32]::WHEEL
        $i.u.mi.time = 0
        $i.u.mi.dwExtraInfo = [UIntPtr]::Zero
        [void][Win32]::SendInput(1, @($i), [System.Runtime.InteropServices.Marshal]::SizeOf([type]'Win32+INPUT'))
        $res.data = [pscustomobject]@{ x = $x; y = $y; dir = [String](Read-Std $a 'dir' 'down'); amount = [int](Read-Std $a 'amount' 3) }
        break
      }
      'type' {
        $text = [String](Read-Std $a 'text' '')
        if ($null -eq $text) { $text = '' }
        for ($i = 0; $i -lt $text.Length; $i++) {
          Send-Unicode $text[$i]
          Start-Sleep -Milliseconds 6
        }
        if ([bool](Read-Std $a 'press_enter' $false)) { Start-Sleep -Milliseconds 40; Send-Combo 'enter' | Out-Null }
        $res.data = [pscustomobject]@{ chars = $text.Length }
        break
      }
      'key' {
        $combo = [String](Read-Std $a 'combo' '')
        $seqv = Send-Combo $combo
        $res.data = [pscustomobject]@{ combo = $combo; vk = @($seqv) }
        break
      }
      'hotkey' {
        $spec = [String](Read-Std $a 'spec' '')
        if ($spec -eq '') {
          [Guard]::Stop()
          $res.data = [pscustomobject]@{ active = $false; spec = '' }
        } else {
          $r = [Guard]::Start($spec)
          $res.data = [pscustomobject]@{ result = $r; active = [Guard]::Active; spec = $spec }
        }
        break
      }
      'hotkey_state' { $res.data = [pscustomobject]@{ active = [Guard]::Active }; break }
      default { throw ("unknown cmd " + $cmd) }
    }
  } catch {
    $res.ok = $false
    $msg = ''
    try { $msg = [String]$_.Exception.Message } catch { $msg = [String]$_ }
    if (-not $msg) { $msg = [String]$_ }
    # Where it actually blew up: without this the caller only sees the .NET message,
    # which for a marshalling failure says "parameter type mismatch" and nothing else.
    $at = ''
    try { $at = [String]$_.InvocationInfo.Line.Trim() } catch { }
    $ln = ''
    try { $ln = 'L' + $_.InvocationInfo.ScriptLineNumber } catch { }
    $res.error = $msg + ' [' + $_.Exception.GetType().Name + ' @ ' + $ln + ' ' + $at + ']'
  }
  if ($cmd -eq '__eof__' -or $cmd -eq 'shutdown') { break }
  [Pipe]::Say(($res | ConvertTo-Json -Compress -Depth 8))
}
