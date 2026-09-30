; KHarness 安装包 —— Inno Setup 6
;
; 为什么不用 electron-builder 自带的 NSIS：它打包这一步调的 7za 是单线程压 ~420MB 负载，
; 在这台机器上跑到两小时还不落盘（2026-09-26 又一次现场复现，只能手杀进程）。
; 所以流程改成：electron-builder 只出 `dir`（release-new/win-unpacked，几秒完事），
; 安装包交给 Inno Setup 压（lzma2/fast + 独立压缩进程，一两分钟）。
;
; 出包：  "D:\Inno Setup 6\ISCC.exe" installer\KHarness.iss
; 产物：  release-new\KHarness-Setup-1.3.2.exe
;
; 装的是「程序本体」；用户数据一律在 %APPDATA%\KHarness（kh.db、日志、端口文件），
; 卸载故意不去碰它（和以前 NSIS 的 deleteAppDataOnUninstall=false 一致）。

#define MyAppName "KHarness"
#define MyAppVersion "1.3.2"
#define AppPublisher "KHarness"
; 相对本 .iss 文件所在目录解析
#define UnpackedDir "..\release-new\win-unpacked"
#define OutDir "..\release-new"

[Setup]
AppId={{7B3E9C1A-2F4D-4E58-9A6B-1C0D2E3F4A55}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#AppPublisher}
AppSupportURL=https://localhost/
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableWelcomePage=no
; 和旧的 NSIS perMachine=false 对齐：不需要管理员，装到当前用户的 Programs 下
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename={#MyAppName}-Setup-{#MyAppVersion}
SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\{#MyAppName}.exe
UninstallDisplayName={#MyAppName}
WizardStyle=modern
; 压缩：快为主。这台机器上单线程 lzma 慢到不可用，Inno 的 lzma2/fast 足够
Compression=lzma2/fast
LZMAUseSeparateProcess=yes
SolidCompression=yes
; 程序在跑时安装器会提示关掉它（不然 dll/exe 被占着覆盖不了）
CloseApplications=yes
RestartApplications=no

; 这台机器的 Inno 没装简体中文 .isl（Languages 目录里没有），向导文字就用默认英文；
; 我们自己写的标题/任务名是字面量，不受影响。

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加工具:"

[Files]
; Excludes 是第二道闸：pack-prep 已经把 kh.db* / 日志 / 备份 / 我的技能笔记挡在 payload 外，
; 万一以后有人手改 win-unpacked 或者拿错目录，这里也不会把本机数据打进安装包。
Source: "{#UnpackedDir}\*"; DestDir: "{app}"; Excludes: "kh.db*,*.log,*.tmp,agent-skills"; Flags: ignoreversion recursesubdirs createallsubdirs
; 少一个入口文件就说明拿的是空目录/半成品，直接不出包
Source: "{#UnpackedDir}\{#MyAppName}.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppName}.exe"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppName}.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppName}.exe"; Description: "现在运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 只清安装目录里的运行残留，%APPDATA%\KHarness 一个字节都不碰
Type: filesandordirs; Name: "{app}\resources\client"
Type: filesandordirs; Name: "{app}\resources\server"
