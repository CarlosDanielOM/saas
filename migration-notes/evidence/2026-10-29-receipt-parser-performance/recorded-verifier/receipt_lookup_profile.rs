use dima_rust::utils::{lossless_json_view::JsonDocument,ai_usage_receipt_parser::parse_queued_ai_usage_receipt};
use std::{hint::black_box,time::Instant};
const N:usize=3200;
fn measure(mut run:impl FnMut()->usize,label:&str){
 let mut checksum=0usize;for _ in 0..N{checksum=checksum.wrapping_add(black_box(run()));}
 let mut samples=Vec::new();for _ in 0..7{let start=Instant::now();for _ in 0..N{checksum=checksum.wrapping_add(black_box(run()));}samples.push(start.elapsed().as_nanos() as u64);}
 let mut sorted=samples.clone();sorted.sort();println!("{{\"stage\":\"{}\",\"operationsPerSample\":{},\"samplesNs\":{:?},\"medianNsPerPass\":{},\"checksum\":{}}}",label,N,samples,sorted[3] as f64/N as f64,black_box(checksum));
}
fn main(){
 let raw=include_str!("/task-tools/receipt_lookup_profile_input.json");
 measure(||JsonDocument::parse(black_box(raw)).unwrap().root().raw().len(),"validate-and-index");
 let doc=JsonDocument::parse(raw).unwrap();let row=doc.root();
 let keys=["occurredAt","credits","channelID","customerId","id","entryKind","quantity","channelID","customerId","id","requestId","category","operation","source","provider","model","unit","resourceType","resourceId","itemized"];
 measure(||keys.iter().filter(|key|black_box(row.get(black_box(key))).is_some()).count(),"twenty-field-lookups");
 measure(||black_box(parse_queued_ai_usage_receipt(black_box(raw)).unwrap()).credits().to_bits() as usize,"parse-to-normalized-dto");
 let parsed=parse_queued_ai_usage_receipt(raw).unwrap();measure(||black_box(parsed.json()).len(),"prepared-dto-wire");
 measure(||black_box(parse_queued_ai_usage_receipt(black_box(raw)).unwrap().json()).len(),"parse-and-wire");
}
