// Local pilot control bridge. It forwards only to the fixed P3 agent endpoint.
import net from 'node:net';
net.createServer(client => {
    const upstream = net.createConnection({ host: 'agent-p3', port: 8080 });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
}).listen(8080, '0.0.0.0');
