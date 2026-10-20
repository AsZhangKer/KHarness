using JsonBridge.Sender;

Console.OutputEncoding = System.Text.Encoding.UTF8;

const string MulticastGroup = "239.255.42.99";
const int DiscoveryPort = 37020;
const int TcpPort = 45678;

var app = new SenderApp(MulticastGroup, DiscoveryPort, TcpPort);
await app.RunAsync();