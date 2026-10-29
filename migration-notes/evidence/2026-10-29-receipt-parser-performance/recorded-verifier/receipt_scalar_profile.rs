use dima_rust::utils::{lossless_json_view::JsonDocument,ai_usage_receipt_parser::parse_queued_ai_usage_receipt};
use std::{hint::black_box,time::Instant};
const N:usize=3200;
fn measure(mut run:impl FnMut()->usize,label:&str){
 let mut checksum=0usize;for _ in 0..N{checksum=checksum.wrapping_add(black_box(run()));}
 let mut samples=Vec::new();for _ in 0..7{let start=Instant::now();for _ in 0..N{checksum=checksum.wrapping_add(black_box(run()));}samples.push(start.elapsed().as_nanos() as u64);}
 let mut sorted=samples.clone();sorted.sort();println!("{{\"stage\":\"{}\",\"operationsPerSample\":{},\"samplesNs\":{:?},\"medianNsPerPass\":{},\"checksum\":{}}}",label,N,samples,sorted[3] as f64/N as f64,black_box(checksum));
}
fn main(){
 let raw=include_str!("/task-tools/receipt_lookup_profile_input.json");let doc=JsonDocument::parse(raw).unwrap();let row=doc.root();
 let strings=[row.get("channelID").unwrap(),row.get("customerId").unwrap(),row.get("id").unwrap(),row.get("occurredAt").unwrap()];
 measure(||strings[..3].iter().filter(|v|black_box(**v).truthy()).count(),"three-string-truthiness-checks");
 measure(||strings.iter().map(|v|black_box(black_box(*v).as_string().unwrap()).len()).sum(),"four-string-decodes");
 measure(||strings.iter().map(|v|black_box(black_box(*v).js_string().unwrap()).len()).sum(),"four-string-coercions");
 measure(||black_box(parse_queued_ai_usage_receipt(black_box(raw)).unwrap()).credits().to_bits() as usize,"parse-to-normalized-dto");
}
