// Fixture-only HTTP CONNECT proxy. Production hostnames and TLS verification stay real;
// no DNS forwarding, remote socket, endpoint override or disabled certificate validation.
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {createServer as tlsServer} from 'node:tls';
import {readFile} from 'node:fs/promises';
export async function providerProxy(directory='/tmp/saas-fixtures') {
    // Serve only the non-CA leaf; SSL_CERT_FILE below trusts its separate root.
    const key=await readFile(`${directory}/provider-key.pem`),cert=await readFile(`${directory}/provider-cert.pem`);
    const sockets=new Set(),requests=[],connections=[],modes=new Map();let failure,closing=false,oauthMode='ready';
    const application=httpServer(async(req,res)=>{
        try {
            let body='';for await(const chunk of req){body+=chunk;assert(body.length<16384);}
            const host=req.headers.host?.split(':')[0];assert(['api.twitch.tv','id.twitch.tv'].includes(host));
            const url=new URL(req.url,`https://${host}`);
            if(host==='id.twitch.tv'){
                assert.equal(req.method,'POST');assert.equal(url.pathname,'/oauth2/token');assert.equal(url.search,'');
                assert.match(req.headers['content-type']||'',/^application\/x-www-form-urlencoded/);
                const params=new URLSearchParams(body);
                assert.equal(params.get('client_id'),'dashboard-fixture-client');assert.equal(params.get('client_secret'),'dashboard-fixture-secret');
                assert.equal(params.get('grant_type'),'client_credentials');
                requests.push({provider:'oauth',method:req.method,validCredentials:true});
                if(oauthMode==='hang')return;
                res.writeHead(oauthMode==='fail'?401:200,{'Content-Type':'application/json'});
                res.end(JSON.stringify(oauthMode==='fail'?{error:'invalid_client'}:{access_token:'dashboard-fixture-app-token',expires_in:3600,token_type:'bearer'}));return;
            }
            assert.equal(req.method,'GET');assert.equal(url.pathname,'/helix/chat/emotes');
            assert.equal(req.headers['client-id'],'dashboard-fixture-client');assert.equal(req.headers.authorization,'Bearer dashboard-fixture-app-token');
            const channel=url.searchParams.get('broadcaster_id');assert.match(channel||'',/^\d{1,30}$/);
            requests.push({provider:'helix',channel,authenticated:true});
            const mode=modes.get(channel)||{data:[{id:'owner',name:'OwnerEmote'}]};
            if(mode==='hang')return;
            res.writeHead(mode==='fail'?503:200,{'Content-Type':'application/json'});
            res.end(mode==='json'?'not-json':JSON.stringify(mode==='fail'?{error:'fixture provider failure'}:mode==='invalid'?{data:[{id:'bad:id',name:'Bad'}]}:mode==='oversize'?{data:Array.from({length:2001},()=>({id:'a',name:'A'}))}:mode));
        }catch(error){failure||=error;res.destroy();}
    });
    const tls=tlsServer({key,cert,ALPNProtocols:['http/1.1']},socket=>application.emit('connection',socket));
    tls.on('tlsClientError',error=>{if(!closing)failure||=error;});
    const proxy=httpServer((_req,res)=>{failure||=new Error('Provider fixture expects HTTPS CONNECT');res.writeHead(400);res.end();});
    proxy.on('connect',(req,socket,head)=>{
        try{
            assert(['api.twitch.tv:443','id.twitch.tv:443'].includes(req.url),'CONNECT escaped fixture provider allowlist');
            connections.push(req.url);socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if(head.length)socket.unshift(head);tls.emit('connection',socket);
        }catch(error){failure||=error;socket.destroy();}
    });
    proxy.on('connection',socket=>{sockets.add(socket);socket.on('error',error=>{if(!closing&&!['ECONNRESET','EPIPE'].includes(error.code))failure||=error;});socket.on('close',()=>sockets.delete(socket));});
    await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
    const url=`http://127.0.0.1:${proxy.address().port}`;
    return {requests,connections,modes,setOAuthMode(mode){oauthMode=mode;},check(){if(failure)throw failure;},
        env:{HTTPS_PROXY:url,HTTP_PROXY:url,ALL_PROXY:url,NO_PROXY:'',https_proxy:url,http_proxy:url,all_proxy:url,no_proxy:'',SSL_CERT_FILE:`${directory}/provider-root-cert.pem`},
        async close(){closing=true;for(const socket of sockets)socket.destroy();await new Promise(resolve=>proxy.close(resolve));tls.close();application.close();}
    };
}
