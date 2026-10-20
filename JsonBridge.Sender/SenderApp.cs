using System.Text.Json;

namespace JsonBridge.Sender;

internal sealed class SenderApp
{
    private readonly AppIdentity _identity;
    private readonly SenderServer _server;
    private readonly DiscoveryBroadcaster _discovery;
    private readonly int _tcpPort;

    public SenderApp(string group, int discoveryPort, int tcpPort)
    {
        _tcpPort = tcpPort;
        _identity = AppIdentity.LoadOrCreate();
        _server = new SenderServer(_identity, tcpPort);

        _discovery = new DiscoveryBroadcaster(group, discoveryPort, () => new
        {
            magic = "JSONBRIDGE/1",
            role = "win-controller",
            sid = _identity.Sid,
            name = Environment.MachineName,
            tcp_port = _tcpPort,
            ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        });
    }

    public async Task RunAsync()
    {
        Console.WriteLine("=== JsonBridge · Windows 发送端 ===");
        Console.WriteLine($"本机 SID : {_identity.Sid}");
        Console.WriteLine($"已配对   : {_identity.PairedCid ?? "(未配对，等待首个接收端)"}");

        _server.Start();
        _discovery.Start();

        Console.WriteLine();
        Console.WriteLine("命令：");
        Console.WriteLine("  回车/go   触发一次事件并等待回复");
        Console.WriteLine("  reset     清除配对信息");
        Console.WriteLine("  status    查看连接状态");
        Console.WriteLine("  quit      退出");
        Console.WriteLine();

        while (true)
        {
            Console.Write("> ");
            var line = Console.ReadLine();
            if (line == null) break;
            line = line.Trim();

            switch (line.ToLowerInvariant())
            {
                case "":
                case "go":
                    await TriggerAsync();
                    break;

                case "reset":
                    _identity.ResetPairing();
                    Console.WriteLine("[配对] 已清除，等待新接收端接入");
                    break;

                case "status":
                    Console.WriteLine(_server.IsConnected ? "[状态] 接收端已连接" : "[状态] 未连接");
                    break;

                case "quit":
                case "exit":
                    goto done;

                default:
                    Console.WriteLine("未知命令");
                    break;
            }
        }

    done:
        _discovery.Dispose();
        _server.Dispose();
        Console.WriteLine("已退出。");
    }

    private async Task TriggerAsync()
    {
        if (!_server.IsConnected)
        {
            Console.WriteLine("[!] 暂无接收端连接，无法发送");
            return;
        }

        var payload = new
        {
            action = "ask",
            text = "是否继续？",
            ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        };

        Console.WriteLine($"[事件] 发送: {JsonSerializer.Serialize(payload)}");

        try
        {
            var reply = await _server.SendEventAndWaitAsync(payload, TimeSpan.FromSeconds(30));
            var text = reply.ValueKind == JsonValueKind.Undefined ? "{}" : reply.GetRawText();
            Console.WriteLine($"[回复] 收到: {text}");

            // —— 根据回复内容决定下一步 ——
            if (reply.ValueKind == JsonValueKind.Object &&
                reply.TryGetProperty("ok", out var okEl) &&
                okEl.ValueKind == JsonValueKind.True)
            {
                Console.WriteLine("=> 下一步：继续执行");
            }
            else
            {
                Console.WriteLine("=> 下一步：停止 / 走其它分支");
            }
        }
        catch (TimeoutException)
        {
            Console.WriteLine("[!] 等待回复超时");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[!] 发送失败: {ex.Message}");
        }
    }
}