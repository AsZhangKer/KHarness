using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace JsonBridge.Sender;

internal sealed class SenderServer : IDisposable
{
    private readonly TcpListener _listener;
    private readonly AppIdentity _identity;
    private readonly object _lock = new();
    private readonly CancellationTokenSource _cts = new();

    private ClientSession? _session;
    private int _seq;

    public SenderServer(AppIdentity identity, int port)
    {
        _identity = identity;
        _listener = new TcpListener(IPAddress.Any, port);
    }

    public bool IsConnected { get { lock (_lock) return _session != null; } }

    public void Start()
    {
        _listener.Start();
        Console.WriteLine($"[TCP] 监听 0.0.0.0:{((IPEndPoint)_listener.LocalEndpoint).Port}");
        _ = Task.Run(AcceptLoopAsync);
    }

    private async Task AcceptLoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await _listener.AcceptTcpClientAsync(_cts.Token); }
            catch (OperationCanceledException) { break; }
            catch (ObjectDisposedException) { break; }
            catch (Exception ex)
            {
                Console.WriteLine($"[TCP] accept 出错: {ex.Message}");
                continue;
            }

            _ = Task.Run(() => HandleClientAsync(client));
        }
    }

    private async Task HandleClientAsync(TcpClient client)
    {
        client.NoDelay = true;
        var session = new ClientSession(client, _identity);
        Console.WriteLine($"[+] 新连接来自 {session.Remote}");

        try
        {
            if (!await session.HandshakeAsync())
            {
                Console.WriteLine($"[-] 握手失败，关闭 {session.Remote}");
                session.Dispose();
                return;
            }

            // 单连接锁：踢掉旧会话
            ClientSession? previous;
            lock (_lock)
            {
                previous = _session;
                _session = session;
            }
            previous?.Dispose();

            Console.WriteLine($"[=] 接收端已连接 cid={session.Cid} @ {session.Remote}");
            await session.RunReadLoopAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[!] 会话异常: {ex.Message}");
        }
        finally
        {
            lock (_lock)
            {
                if (ReferenceEquals(_session, session)) _session = null;
            }
            session.Dispose();
            Console.WriteLine($"[-] 连接关闭 {session.Remote}");
        }
    }

    /// <summary>发送一次 event，等待对应 seq 的 reply。</summary>
    public async Task<JsonElement> SendEventAndWaitAsync(object payload, TimeSpan timeout)
    {
        ClientSession session;
        lock (_lock)
        {
            session = _session ?? throw new InvalidOperationException("当前没有接收端连接");
        }

        int seq = Interlocked.Increment(ref _seq);
        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        session.RegisterPending(seq, tcs);

        try
        {
            await session.SendAsync(new
            {
                v = 1,
                type = "event",
                seq,
                ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                payload
            });

            using var cts = new CancellationTokenSource(timeout);
            using var reg = cts.Token.Register(
                () => tcs.TrySetException(new TimeoutException($"等待 seq={seq} 回复超时")));

            return await tcs.Task;
        }
        finally
        {
            session.UnregisterPending(seq);
        }
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _listener.Stop(); } catch { }

        ClientSession? s;
        lock (_lock) { s = _session; _session = null; }
        s?.Dispose();

        _cts.Dispose();
    }
}