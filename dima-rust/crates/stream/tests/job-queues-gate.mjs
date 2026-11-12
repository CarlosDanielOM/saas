// Run from the repository root with test-env loaded. Existing stream tests select database 2;
// this loopback RESP gateway maps only that selection to scratch database 6, leaves 6/7 as is,
// and refuses every other database. This avoids editing another package's existing tests.
import net from 'node:net';
import { spawn } from 'node:child_process';
const address = process.env.DIMA_TEST_DRAGONFLY;
if (!address) throw Error('load tools/test-env first');
const [host, port] = address.split(':');
const sockets = new Set();
const server = net.createServer(client => {
    const upstream = net.connect(Number(port), host);
    client.setNoDelay(true); upstream.setNoDelay(true);
    sockets.add(client); sockets.add(upstream);
    let pending = Buffer.alloc(0);
    client.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length) {
            let offset = 0;
            function line() { const end = pending.indexOf('\r\n',offset); if(end < 0) return null; const value = pending.subarray(offset,end).toString(); offset=end+2; return value; }
            const count = line(); if(count === null) return;
            if(!/^\*\d+$/.test(count)) { client.destroy(Error('expected RESP array')); return; }
            const args=[];
            for(let i=0;i<Number(count.slice(1));i++) {
                const size=line(); if(size===null) return;
                if(!/^\$\d+$/.test(size)) {client.destroy(Error('expected bulk argument'));return;}
                const n=Number(size.slice(1)); if(pending.length < offset+n+2) return;
                args.push(pending.subarray(offset,offset+n)); offset += n+2;
            }
            let frame=pending.subarray(0,offset); pending=pending.subarray(offset);
            if(args[0].toString().toUpperCase()==='SELECT') {
                const db=args[1].toString();
                if(!['2','6','7'].includes(db)) {client.destroy(Error(`database ${db} refused`));return;}
                if(db==='2') frame=Buffer.from('*2\r\n$6\r\nSELECT\r\n$1\r\n6\r\n');
            }
            upstream.write(frame);
        }
    });
    upstream.pipe(client);
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close',()=>{sockets.delete(client);upstream.destroy();});
    upstream.on('close',()=>{sockets.delete(upstream);client.destroy();});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const child=spawn('dima-rust/tools/check',['dima-stream'],{stdio:'inherit',env:{...process.env,DIMA_TEST_DRAGONFLY:`127.0.0.1:${server.address().port}`}});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
child.on('exit',(code)=>{for(const socket of sockets) socket.destroy();server.close();process.exitCode=code ?? 1;});
