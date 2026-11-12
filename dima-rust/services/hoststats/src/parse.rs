//! Pure f64 parsers. JSON null represents absent/non-finite counters.
use serde_json::{Value as V, json};
use std::collections::HashSet;
pub fn number(v: &V) -> f64 {
    dima_text::js_number(v)
}
pub fn n(v: Option<&V>) -> V {
    v.map(number)
        .filter(|n| n.is_finite())
        .map_or(V::Null, |n| json!(n))
}
fn re(pattern: &str, s: &str) -> bool {
    regex::Regex::new(pattern).is_ok_and(|r| r.is_match(s))
}
pub fn cpu(s: &str) -> V {
    let Some(line) = s.lines().find(|l| l.starts_with("cpu ")) else {
        return V::Null;
    };
    let f: Vec<f64> = line
        .split_whitespace()
        .skip(1)
        .map(dima_text::parse_number)
        .collect();
    if f.len() < 4 {
        return V::Null;
    }
    let total: f64 = f.iter().take(8).sum();
    if !total.is_finite() {
        return V::Null;
    }
    json!({"total":total,"idle":f[3],"iowait":f.get(4).unwrap_or(&0.),"steal":f.get(7).unwrap_or(&0.)})
}
pub fn cpu_between(a: &V, b: &V) -> V {
    if a.is_null() || b.is_null() {
        return V::Null;
    }
    let total = number(&b["total"]) - number(&a["total"]);
    if total <= 0. {
        return V::Null;
    }
    let delta = |k: &str| number(&b[k]) - number(&a[k]);
    let pct = |n: f64| (n / total * 100.).clamp(0., 100.);
    json!({"cpuPct":pct(total-delta("idle")-delta("iowait")),"iowaitPct":pct(delta("iowait")),"stealPct":pct(delta("steal"))})
}
pub fn mem(s: &str) -> V {
    let mut m = V::Object(Default::default());
    if let Ok(r) = regex::Regex::new(r"^([A-Za-z0-9_]+):\s+([0-9]+)") {
        for line in s.lines() {
            if let Some(c) = r.captures(line) {
                m[&c[1]] = json!(dima_text::parse_number(&c[2]) * 1024.);
            }
        }
    }
    if number(&m["MemTotal"]) == 0. {
        return V::Null;
    }
    let z = |k: &str| number(&m[k]);
    let available = m
        .get("MemAvailable")
        .or(m.get("MemFree"))
        .cloned()
        .unwrap_or(json!(0));
    json!({"memTotal":m["MemTotal"],"memAvailable":available,"memUsed":(z("MemTotal")-number(&available)).max(0.),"memFree":m["MemFree"],"memCache":z("Cached")+z("Buffers")+z("SReclaimable"),"memShared":m["Shmem"],"swapTotal":z("SwapTotal"),"swapUsed":(z("SwapTotal")-z("SwapFree")).max(0.)})
}
pub fn load(s: &str) -> V {
    let f: Vec<_> = s
        .trim()
        .split(char::is_whitespace)
        .filter(|s| !s.is_empty())
        .collect();
    let get = |i: usize| {
        f.get(i)
            .map(|s| json!(dima_text::parse_number(s)))
            .unwrap_or(V::Null)
    };
    let mut tasks = f.get(3).copied().unwrap_or("").split('/');
    json!({"load1":if s.trim().is_empty(){json!(0)}else{get(0)},"load5":get(1),"load15":get(2),"running":tasks.next().map(dima_text::parse_number),"procs":tasks.next().map(dima_text::parse_number)})
}
pub fn uptime(s: &str) -> V {
    json!(dima_text::parse_number(
        s.split_whitespace().next().unwrap_or("")
    ))
}
pub fn disks(s: &str) -> V {
    let (mut a, mut b, mut found) = (0., 0., false);
    for l in s.lines() {
        let f: Vec<_> = l.split_whitespace().collect();
        if f.len() < 10
            || !re(
                r"^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$",
                f[2],
            )
        {
            continue;
        }
        found = true;
        a += dima_text::parse_number(f[5]) * 512.;
        b += dima_text::parse_number(f[9]) * 512.;
    }
    if found {
        json!({"read":a,"written":b})
    } else {
        V::Null
    }
}
pub fn net(s: &str) -> V {
    let (mut a, mut b, mut found) = (0., 0., false);
    for l in s.lines().skip(2) {
        let Some((name, rest)) = l.split_once(':') else {
            continue;
        };
        if rest.is_empty()
            || re(
                r"^(lo|docker[0-9]*|br-|veth|virbr|cni|flannel|tunl|vxlan|wg|tailscale)",
                name.trim(),
            )
        {
            continue;
        }
        let f: Vec<_> = rest
            .split(':')
            .next()
            .unwrap_or("")
            .split_whitespace()
            .collect();
        if f.len() < 9 {
            continue;
        }
        found = true;
        a += dima_text::parse_number(f[0]);
        b += dima_text::parse_number(f[8]);
    }
    if found {
        json!({"rx":a,"tx":b})
    } else {
        V::Null
    }
}
pub fn pressure(s: &str) -> V {
    regex::Regex::new(r"(?m)^some avg10=([[0-9].]+)")
        .ok()
        .and_then(|r| r.captures(s).map(|c| json!(dima_text::parse_number(&c[1]))))
        .unwrap_or(V::Null)
}
pub fn rate(a: &V, b: &V, seconds: f64) -> V {
    if a.is_null() || b.is_null() || seconds <= 0. || number(b) < number(a) {
        V::Null
    } else {
        json!((number(b) - number(a)) / seconds)
    }
}
pub fn array(v: &V) -> &[V] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn select(list: &V, projects: &HashSet<String>) -> Vec<V> {
    array(list)
        .iter()
        .filter_map(|c| {
            let id = c["Id"].as_str()?;
            let name = c["Names"][0]
                .as_str()
                .unwrap_or("")
                .strip_prefix('/')
                .unwrap_or(c["Names"][0].as_str().unwrap_or(""));
            let project = c["Labels"]["com.docker.compose.project"].as_str()?;
            if re(r"^[a-f0-9]{64}$", id)
                && re(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$", name)
                && projects.contains(project)
            {
                Some(json!({"id":id,"name":name,"project":project}))
            } else {
                None
            }
        })
        .collect()
}
pub fn counters(s: &V) -> V {
    if !s.is_object() && !s.is_array() {
        return V::Null;
    }
    let mem = &s["memory_stats"];
    let cache = mem
        .pointer("/stats/inactive_file")
        .filter(|v| !v.is_null())
        .or(mem.pointer("/stats/total_inactive_file"))
        .unwrap_or(&V::Null);
    let (mut rx, mut tx, mut has) = (0., 0., false);
    if let Some(nets) = s["networks"].as_object() {
        for nic in nets.values() {
            has = true;
            rx += zero_nan(number(&nic["rx_bytes"]));
            tx += zero_nan(number(&nic["tx_bytes"]));
        }
    }
    let (mut read, mut written) = (0., 0.);
    for e in array(&s["blkio_stats"]["io_service_bytes_recursive"]) {
        let v = number(&e["value"]);
        let v = if v.is_nan() { 0. } else { v };
        match e["op"].as_str().unwrap_or("").to_lowercase().as_str() {
            "read" => read += v,
            "write" => written += v,
            _ => {}
        }
    }
    json!({"cpuNs":n(s.pointer("/cpu_stats/cpu_usage/total_usage")),"memBytes":mem.get("usage").map(|v|nonnegative(number(v)-number(cache))),"pids":n(s.pointer("/pids_stats/current")),"rx":if has{json!(rx)}else{V::Null},"tx":if has{json!(tx)}else{V::Null},"read":read,"written":written})
}
fn text(v: &V, max: usize) -> V {
    v.as_str()
        .map(|s| json!(dima_text::truncate_chars(s, max)))
        .unwrap_or(V::Null)
}
fn date(v: &V) -> V {
    v.as_str()
        .filter(|s| !s.is_empty() && !s.starts_with("0001-"))
        .map(|s| json!(s))
        .unwrap_or(V::Null)
}
pub fn view(entry: &V, i: &V, c: &V, p: &V, at: f64) -> V {
    let s = &i["State"];
    let h = &i["HostConfig"];
    let seconds = (at - number(&p["at"])) / 1000.;
    let running = s["Status"] == "running";
    let positive = |k: &str| {
        if number(&h[k]) > 0. {
            h[k].clone()
        } else {
            V::Null
        }
    };
    let cpu = rate(&p["cpuNs"], &c["cpuNs"], seconds);
    let health = s["Health"]["Status"]
        .as_str()
        .filter(|s| ["healthy", "unhealthy", "starting"].contains(s));
    let state = text(&s["Status"], 20);
    let state = if state.is_null() || state == "" {
        json!("unknown")
    } else {
        state
    };
    let cr = |key: &str| {
        if running {
            rate(&p[key], &c[key], seconds)
        } else {
            V::Null
        }
    };
    json!({"name":entry["name"],"project":entry["project"],"service":text(&i["Config"]["Labels"]["com.docker.compose.service"],80),"image":text(&i["Config"]["Image"],200),"imageId":text(&i["Image"],80),"state":state,"health":health,"failingStreak":n(s.pointer("/Health/FailingStreak")),"startedAt":date(&s["StartedAt"]),"finishedAt":date(&s["FinishedAt"]),"exitCode":n(s.get("ExitCode")),"oomKilled":s["OOMKilled"]==true,"restartCount":n(i.get("RestartCount")).as_f64().unwrap_or(0.),"restartPolicy":text(&h["RestartPolicy"]["Name"],40),"cpuPct":if running&&!cpu.is_null(){json!((number(&c["cpuNs"])-number(&p["cpuNs"]))/(seconds*1e9)*100.)}else{V::Null},"cpuLimit":if number(&h["NanoCpus"])>0.{json!(number(&h["NanoCpus"])/1e9)}else if number(&h["CpuQuota"])>0.&&number(&h["CpuPeriod"])>0.{json!(number(&h["CpuQuota"])/number(&h["CpuPeriod"]))}else{V::Null},"memBytes":if running{c["memBytes"].clone()}else{V::Null},"memLimit":positive("Memory"),"pids":if running{c["pids"].clone()}else{V::Null},"pidsLimit":positive("PidsLimit"),"netRx":c["rx"],"netTx":c["tx"],"netRxBps":cr("rx"),"netTxBps":cr("tx"),"blkRead":c["read"],"blkWrite":c["written"],"blkReadBps":cr("read"),"blkWriteBps":cr("written"),"imageBytes":null,"writableBytes":null,"volumeBytes":null,"volumes":array(&i["Mounts"]).iter().filter(|m|m["Type"]=="volume"&&m["Name"].is_string()).map(|m|text(&m["Name"],128)).collect::<Vec<_>>()})
}
pub fn df(d: &V, at: i64) -> V {
    if !d.is_object() && !d.is_array() {
        return V::Null;
    }
    let images = array(&d["Images"]);
    let containers = array(&d["Containers"]);
    let volumes = array(&d["Volumes"]);
    let cache = array(&d["BuildCache"]);
    let pos = |v: &V| {
        let n = number(v);
        if n > 0. { n } else { 0. }
    };
    let mut bi = V::Object(Default::default());
    let mut bc = bi.clone();
    let mut bv = bi.clone();
    for i in images {
        if let Some(id) = i["Id"].as_str() {
            bi[id] = json!(zero_nan(number(&i["Size"])));
        }
    }
    for c in containers {
        if let Some(id) = c["Id"].as_str() {
            bc[id] = json!(zero_nan(number(&c["SizeRw"])));
        }
    }
    for v in volumes {
        if let Some(id) = v["Name"].as_str() {
            bv[id] = json!(pos(&v["UsageData"]["Size"]));
        }
    }
    json!({"at":dima_text::to_iso_string(at),"imagesCount":images.len(),"imagesBytes":if pos(&d["LayersSize"])>0.{pos(&d["LayersSize"])}else{images.iter().map(|i|pos(&i["Size"])).sum::<f64>()},"imagesUnusedBytes":images.iter().filter(|i|!containers.iter().any(|c|c["ImageID"]==i["Id"])&&number(&i["Containers"]).partial_cmp(&0.)!=Some(std::cmp::Ordering::Greater)).map(|i|(number(&i["Size"])-pos(&i["SharedSize"])).max(0.)).sum::<f64>(),"buildCacheBytes":cache.iter().map(|c|pos(&c["Size"])).sum::<f64>(),"buildCacheReclaimable":cache.iter().filter(|c|!dima_text::js_truthy(&c["InUse"])&&!dima_text::js_truthy(&c["Shared"])).map(|c|pos(&c["Size"])).sum::<f64>(),"volumesCount":volumes.len(),"volumesBytes":volumes.iter().map(|v|pos(&v["UsageData"]["Size"])).sum::<f64>(),"containersBytes":containers.iter().map(|c|pos(&c["SizeRw"])).sum::<f64>(),"byImage":bi,"byContainer":bc,"byVolume":bv})
}

fn zero_nan(n: f64) -> f64 {
    if n.is_nan() { 0. } else { n }
}

fn nonnegative(n: f64) -> f64 {
    if n.is_nan() { n } else { n.max(0.) }
}

/// Filesystem snapshot projection; f64 arithmetic in the reference's evaluation order.
pub fn filesystem(blocks: f64, bsize: f64, bfree: f64, bavail: f64, files: f64, ffree: f64) -> V {
    let total = blocks * bsize;
    json!({"diskTotal":total,"diskFree":bavail*bsize,"diskUsed":total-bfree*bsize,"inodesTotal":files,"inodesUsed":files-ffree})
}
