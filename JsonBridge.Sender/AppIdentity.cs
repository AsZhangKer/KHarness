using System.Text.Json;

namespace JsonBridge.Sender;

internal sealed class AppIdentity
{
    public string Sid { get; set; } = "";
    public string? PairedCid { get; set; }
    public string? Token { get; set; }

    private static string Dir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "JsonBridge");

    private static string FilePath => Path.Combine(Dir, "identity.json");

    public static AppIdentity LoadOrCreate()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                var loaded = JsonSerializer.Deserialize<AppIdentity>(File.ReadAllText(FilePath));
                if (loaded is { Sid.Length: > 0 }) return loaded;
            }
        }
        catch { /* 文件损坏，重建 */ }

        var created = new AppIdentity { Sid = Guid.NewGuid().ToString("D") };
        created.Save();
        return created;
    }

    public void Save()
    {
        Directory.CreateDirectory(Dir);
        File.WriteAllText(FilePath,
            JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }

    public void ResetPairing()
    {
        PairedCid = null;
        Token = null;
        Save();
    }
}