use sha2::{Digest, Sha256};
use std::path::PathBuf;
pub fn fixture() -> serde_json::Value {
    let path = PathBuf::from(std::env::var_os("DIMA_PET_SCHEMAS_FIXTURE_DIR").expect("fixture directory"));
    assert!(path.is_absolute());
    assert_eq!(path.canonicalize().unwrap(), path);
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).canonicalize().unwrap();
    assert!(!path.starts_with(workspace.parent().unwrap()));
    let file = path.join("pet-schemas-wakeups-reference.json");
    assert!(std::fs::symlink_metadata(&file).unwrap().file_type().is_file());
    let bytes = std::fs::read(file).unwrap();
    let expected = std::env::var("DIMA_PET_SCHEMAS_FIXTURE_SHA256").expect("fixture SHA256");
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected);
    serde_json::from_slice(&bytes).unwrap()
}
pub fn require_private_resources() {
    assert_eq!(std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(), Ok("dimabot-migration"));
}

// Task-local RESP2 stub. No Redis/production resources: it binds an ephemeral
// loopback port and owns every accepted socket. Events expose command/EOF order.
use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}};
use tokio::{io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader}, net::{TcpListener, TcpStream}, sync::{broadcast, mpsc, Notify}, task::JoinHandle};

#[derive(Debug)]
pub enum Event { Connected, Command(String), Closed }
pub struct Stub {
    pub url: String,
    pub events: mpsc::UnboundedReceiver<Event>,
    pub block_publish: Arc<AtomicBool>,
    pub block_handshake: Arc<AtomicBool>,
    pub release: Arc<Notify>,
    pub close: broadcast::Sender<()>,
    pub connections: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}
impl Stub {
    pub async fn start() -> Self {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url=format!("redis://{}/",listener.local_addr().unwrap());
        let (tx,events)=mpsc::unbounded_channel(); let (close,_)=broadcast::channel(16);
        let block_publish=Arc::new(AtomicBool::new(false)); let block_handshake=Arc::new(AtomicBool::new(false)); let release=Arc::new(Notify::new()); let connections=Arc::new(AtomicUsize::new(0));
        let (b,h,r,c,stop)=(block_publish.clone(),block_handshake.clone(),release.clone(),connections.clone(),close.clone());
        let task=tokio::spawn(async move { loop { let Ok((stream,_))=listener.accept().await else {break}; c.fetch_add(1,Ordering::SeqCst); let _=tx.send(Event::Connected); tokio::spawn(serve(stream,tx.clone(),b.clone(),h.clone(),r.clone(),stop.subscribe())); }});
        Self {url,events,block_publish,block_handshake,release,close,connections,task}
    }
    pub async fn command(&mut self, wanted: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(3),async {loop {match self.events.recv().await.expect("stub event") {Event::Command(cmd) if cmd==wanted=>break, _=>{}}}}).await.expect("command timeout");
    }
    pub async fn closed(&mut self) {
        tokio::time::timeout(std::time::Duration::from_secs(3),async {loop {if matches!(self.events.recv().await,Some(Event::Closed)){break}}}).await.expect("socket close timeout");
    }
}
impl Drop for Stub { fn drop(&mut self) {let _=self.close.send(());self.task.abort();} }
async fn read_command(reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>) -> Option<Vec<Vec<u8>>> {
    let mut line=String::new(); if reader.read_line(&mut line).await.ok()? == 0 {return None}
    let count: usize=line.strip_prefix('*')?.trim().parse().ok()?; let mut args=Vec::new();
    for _ in 0..count { line.clear();reader.read_line(&mut line).await.ok()?;let len:usize=line.strip_prefix('$')?.trim().parse().ok()?;let mut value=vec![0;len+2];reader.read_exact(&mut value).await.ok()?;value.truncate(len);args.push(value); }
    Some(args)
}
async fn serve(stream: TcpStream, tx:mpsc::UnboundedSender<Event>, block:Arc<AtomicBool>, handshake:Arc<AtomicBool>, release:Arc<Notify>, mut close:broadcast::Receiver<()>) {
    let (read,mut write)=stream.into_split();let mut reader=BufReader::new(read);
    loop {
        let args=tokio::select! {_=close.recv()=>break, value=read_command(&mut reader)=>match value {Some(v)=>v,None=>break}};
        let cmd=String::from_utf8_lossy(args.first().map(Vec::as_slice).unwrap_or_default()).to_ascii_uppercase();let _=tx.send(Event::Command(cmd.clone()));
        if cmd=="CLIENT" && handshake.load(Ordering::SeqCst) {tokio::select! {_=release.notified()=>{},_=close.recv()=>break}}
        let response=match cmd.as_str() {
            "PUBLISH" => {if block.load(Ordering::SeqCst) {tokio::select! {_=release.notified()=>{},_=close.recv()=>break, result=reader.fill_buf()=>{if result.map(|v|v.is_empty()).unwrap_or(true){break} else {break}}}} ":1\r\n"},
            "SUBSCRIBE" => "*3\r\n$9\r\nsubscribe\r\n$23\r\ndomain-events:wakeup:v1\r\n:1\r\n",
            "PING" => "+PONG\r\n", _ => "+OK\r\n",
        };
        if write.write_all(response.as_bytes()).await.is_err(){break}
    }
    let _=tx.send(Event::Closed);
}
