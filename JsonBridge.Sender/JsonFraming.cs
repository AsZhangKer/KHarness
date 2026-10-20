using System.Text.Json;

namespace JsonBridge.Sender;

internal static class JsonFraming
{
    private const int MaxFrame = 8 * 1024 * 1024;

    public static async Task WriteAsync(Stream stream, object message, CancellationToken ct)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(message);
        if (json.Length > MaxFrame)
            throw new InvalidOperationException($"帧过大: {json.Length}");

        var header = new byte[4];
        header[0] = (byte)(json.Length >> 24);
        header[1] = (byte)(json.Length >> 16);
        header[2] = (byte)(json.Length >> 8);
        header[3] = (byte)json.Length;

        await stream.WriteAsync(header, ct);
        await stream.WriteAsync(json, ct);
        await stream.FlushAsync(ct);
    }

    public static async Task<JsonDocument?> ReadAsync(Stream stream, CancellationToken ct)
    {
        var header = new byte[4];
        if (!await ReadExactAsync(stream, header, ct)) return null;

        int len = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
        if (len <= 0 || len > MaxFrame)
            throw new InvalidDataException($"非法帧长度: {len}");

        var buf = new byte[len];
        if (!await ReadExactAsync(stream, buf, ct)) return null;

        return JsonDocument.Parse(buf);
    }

    private static async Task<bool> ReadExactAsync(Stream stream, byte[] buf, CancellationToken ct)
    {
        int off = 0;
        while (off < buf.Length)
        {
            int n = await stream.ReadAsync(buf.AsMemory(off), ct);
            if (n <= 0) return false;
            off += n;
        }
        return true;
    }
}