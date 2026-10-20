using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json;

namespace JsonBridge.Sender;

/// <summary>
/// 每秒从每张真实网卡发一次子网定向广播。
/// 不用 255.255.255.255，因为 Android 默认丢弃全局广播。
/// </summary>
internal sealed class DiscoveryBroadcaster : IDisposable
{
    private readonly int _port;
    private readonly Func<object> _payloadFactory;
    private readonly Timer _timer;

    public DiscoveryBroadcaster(string group, int port, Func<object> payloadFactory)
    {
        _port = port;
        _payloadFactory = payloadFactory;
        _timer = new Timer(_ => SendOnce(), null, Timeout.Infinite, Timeout.Infinite);
    }

    public void Start() => _timer.Change(0, 1000);

    private void SendOnce()
    {
        byte[] bytes;
        try
        {
            bytes = JsonSerializer.SerializeToUtf8Bytes(_payloadFactory());
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[发现] 序列化失败: {ex.Message}");
            return;
        }

        bool any = false;
        foreach (var (localIp, broadcastIp) in GetTargets())
        {
            any = true;
            try
            {
                using var socket = new Socket(
                    AddressFamily.InterNetwork,
                    SocketType.Dgram,
                    ProtocolType.Udp);
                socket.SetSocketOption(
                    SocketOptionLevel.Socket,
                    SocketOptionName.ReuseAddress,
                    true);
                socket.EnableBroadcast = true;
                socket.Bind(new IPEndPoint(localIp, 0));
                socket.SendTo(bytes, new IPEndPoint(broadcastIp, _port));
                Console.WriteLine($"[发现] {localIp} → {broadcastIp}:{_port}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[发现] 从 {localIp} 发往 {broadcastIp} 失败: {ex.Message}");
            }
        }

        if (!any)
        {
            Console.WriteLine("[发现] 没找到可用的 IPv4 网卡，无法广播");
        }
    }

    private IEnumerable<(IPAddress local, IPAddress broadcast)> GetTargets()
    {
        foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != OperationalStatus.Up) continue;
            if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            if (ni.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;

            IPInterfaceProperties props;
            try { props = ni.GetIPProperties(); }
            catch { continue; }

            foreach (var addr in props.UnicastAddresses)
            {
                if (addr.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                if (IPAddress.IsLoopback(addr.Address)) continue;
                if (addr.IPv4Mask == null) continue;

                var ipBytes = addr.Address.GetAddressBytes();
                var maskBytes = addr.IPv4Mask.GetAddressBytes();
                var bcastBytes = new byte[4];
                for (int i = 0; i < 4; i++)
                {
                    bcastBytes[i] = (byte)(ipBytes[i] | (maskBytes[i] ^ 0xFF));
                }

                yield return (addr.Address, new IPAddress(bcastBytes));
            }
        }
    }

    public void Dispose()
    {
        _timer.Dispose();
    }
}