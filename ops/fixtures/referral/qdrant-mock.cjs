const http = require('node:http');

// The API boots its Qdrant client before serving requests. Keep candidate
// verification on the helper's private network without reaching live Qdrant.
if (process.argv[1]?.endsWith('/server/index.js')) http.createServer((request, response) => {
    const result = request.url === '/collections'
        ? { collections: [] }
        : request.url?.endsWith('/exists')
            ? { exists: true }
            : true;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result, status: 'ok', time: 0 }));
}).listen(6333, '127.0.0.1');
