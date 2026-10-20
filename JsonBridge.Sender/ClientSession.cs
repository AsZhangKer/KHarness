using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace JsonBridge.Sender;

internal sealed class ClientSession : IDisposable
{
    private readonly TcpClient _client;
    private readonly NetworkStream _stream;
    private readonly AppIdentity _identity;

    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonElement>> _pending = new();
    private readonly CancellationTokenSource _cts = new();
    private int _disposed;

    public string Cid { get; private set; } = "";
    public EndPoint? Remote { get; }

    public ClientSession(TcpClient client, AppIdentity identity)
    {
        _client = client;
        _stream = client.GetStream();
        _identity = identity;
        Remote = client.Client.RemoteEndPoint;
    }

    // ---------- 握手 ----------
    public async Task<bool> HandshakeAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var doc = await JsonFraming.ReadAsync(_stream, timeout.Token);
        if (doc == null) return false;

        var root = doc.RootElement;

        if (!root.TryGetProperty("type", out var typeEl) || typeEl.GetString() != "hello")
        {
            await SendAsync(new { type = "hello_ack", ok = false, error = "expected_hello" });
            return false;
        }

        if (!root.TryGetProperty("sid", out var sidEl) || sidEl.GetString() != _identity.Sid)
        {
            await SendAsync(new { type = "hello_ack", ok = false, error = "sid_mismatch" });
            return false;
        }

        var cid = root.TryGetProperty("cid", out var cidEl) ? cidEl.GetString() ?? "" : "";
        var token = root.TryGetProperty("token", out var tokenEl) ? tokenEl.GetString() ?? "" : "";

        if (cid.Length == 0)
        {
            await SendAsync(new { type = "hello_ack", ok = false, error = "missing_cid" });
            return false;
        }

        if (!ValidatePairing(cid, token, out var error))
        {
            await SendAsync(new { type = "hello_ack", ok = false, error });
            return false;
        }

        Cid = cid;
        await SendAsync(new
        {
            type = "hello_ack",
            ok = true,
            session = Guid.NewGuid().ToString("N")
        });
        return true;
    }

    private bool ValidatePairing(string cid, string token, out string error)
    {
        error = "";
        lock (_identity)
        {
            // 首次配对：绑定
            if (string.IsNullOrEmpty(_identity.PairedCid))
            {
                _identity.PairedCid = cid;
                _identity.Token = token;
                _identity.Save();
                Console.WriteLine($"[配对] 首次绑定接收端 cid={cid}");
                return true;
            }
            if (_identity.PairedCid != cid) { error = "cid_mismatch"; return false; }
            if (_identity.Token != token) { error = "bad_token"; return false; }
            return true;
        }
    }

    // ---------- 收发 ----------
    public void RegisterPending(int seq, TaskCompletionSource<JsonElement> tcs) => _pending[seq] = tcs;
    public void UnregisterPending(int seq) => _pending.TryRemove(seq, out _);

    public async Task SendAsync(object message)
    {
        await _writeLock.WaitAsync(_cts.Token);
        try
        {
            await JsonFraming.WriteAsync(_stream, message, _cts.Token);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public async Task RunReadLoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            using var doc = await JsonFraming.ReadAsync(_stream, _cts.Token);
            if (doc == null) return;

            var root = doc.RootElement;
            var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;

            switch (type)
            {
                case "reply": HandleReply(root); break;
                case "ping":
                    await SendAsync(new { type = "pong", ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds() });
                    break;
                case "pong": break;
                default:
                    Console.WriteLine($"[?] 未知消息类型: {type}");
                    break;
            }
        }
    }

    private void HandleReply(JsonElement root)
    {
        if (!root.TryGetProperty("seq", out var seqEl) || !seqEl.TryGetInt32(out var seq))
            return;
        if (!_pending.TryRemove(seq, out var tcs))
            return;

        JsonElement payload = root.TryGetProperty("payload", out var p)
            ? p.Clone()
            : JsonDocument.Parse("{}").RootElement.Clone();

        tcs.TrySetResult(payload);
    }

    // ---------- 释放 ----------
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;

        try { _cts.Cancel(); } catch { }

        foreach (var kv in _pending)
            kv.Value.TrySetException(new IOException("连接已关闭"));
        _pending.Clear();

        try { _stream.Dispose(); } catch { }
        try { _client.Dispose(); } catch { }
        _cts.Dispose();
    }
}