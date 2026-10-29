fn legacy_number_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n == f64::INFINITY {
        return "Infinity".into();
    }
    if n == f64::NEG_INFINITY {
        return "-Infinity".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    let negative = n < 0.0;
    let raw = n.abs().to_string();
    let (mantissa, exponent) = raw
        .split_once(['e', 'E'])
        .map_or((raw.as_str(), 0), |(m, e)| {
            (m, e.parse::<i32>().unwrap_or(0))
        });
    let point = mantissa.find('.').unwrap_or(mantissa.len()) as i32;
    let mut digits = mantissa.replace('.', "");
    let mut decimal = point + exponent;
    let zeros = digits.bytes().take_while(|b| *b == b'0').count();
    digits.drain(..zeros);
    decimal -= zeros as i32;
    while digits.ends_with('0') {
        digits.pop();
    }
    let mut out = if decimal > 0 && decimal <= 21 {
        if decimal as usize >= digits.len() {
            format!("{}{}", digits, "0".repeat(decimal as usize - digits.len()))
        } else {
            format!(
                "{}.{}",
                &digits[..decimal as usize],
                &digits[decimal as usize..]
            )
        }
    } else if decimal <= 0 && decimal > -6 {
        format!("0.{}{}", "0".repeat((-decimal) as usize), digits)
    } else {
        let e = decimal - 1;
        let mantissa = if digits.len() == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!("{mantissa}e{}{e}", if e >= 0 { "+" } else { "" })
    };
    if negative {
        out.insert(0, '-');
    }
    out
}

fn serde_seed_number_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n == f64::INFINITY {
        return "Infinity".into();
    }
    if n == f64::NEG_INFINITY {
        return "-Infinity".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    let negative = n < 0.0;
    let raw = serde_json::to_string(&n.abs()).unwrap();
    let (mantissa, exponent) = raw
        .split_once(['e', 'E'])
        .map_or((raw.as_str(), 0), |(m, e)| {
            (m, e.parse::<i32>().unwrap_or(0))
        });
    let point = mantissa.find('.').unwrap_or(mantissa.len()) as i32;
    let mut digits = mantissa.replace('.', "");
    let mut decimal = point + exponent;
    let zeros = digits.bytes().take_while(|b| *b == b'0').count();
    digits.drain(..zeros);
    decimal -= zeros as i32;
    while digits.ends_with('0') {
        digits.pop();
    }
    let mut out = if decimal > 0 && decimal <= 21 {
        if decimal as usize >= digits.len() {
            format!("{}{}", digits, "0".repeat(decimal as usize - digits.len()))
        } else {
            format!(
                "{}.{}",
                &digits[..decimal as usize],
                &digits[decimal as usize..]
            )
        }
    } else if decimal <= 0 && decimal > -6 {
        format!("0.{}{}", "0".repeat((-decimal) as usize), digits)
    } else {
        let e = decimal - 1;
        let mantissa = if digits.len() == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!("{mantissa}e{}{e}", if e >= 0 { "+" } else { "" })
    };
    if negative {
        out.insert(0, '-');
    }
    out
}


fn main() {
 let data: serde_json::Value = serde_json::from_slice(&std::fs::read("/artifacts/posthog-payload-performance/attempt2/numbers/json-number-reference.json").unwrap()).unwrap();
 let mut legacy_bad=0; let mut serde_bad=0; let mut samples=Vec::new();
 for c in data["cases"].as_array().unwrap() {
  let bits=c["input"].as_str().unwrap(); let n=f64::from_bits(u64::from_str_radix(bits,16).unwrap());
  let expected=c["string"].as_str().unwrap(); let a=legacy_number_string(n);let b=serde_seed_number_string(n);
  if a!=expected {legacy_bad+=1;} if b!=expected {serde_bad+=1;}
  if (a!=expected||b!=expected)&&samples.len()<16 {samples.push(serde_json::json!({"bits":bits,"legacy":a,"serdeSeed":b,"expected":expected}));}
 }
 let report=serde_json::json!({"cases":data["cases"].as_array().unwrap().len(),"legacyDifferences":legacy_bad,"serdeSeedDifferences":serde_bad,"samples":samples,"scope":"One variable changed: shortest digit seed from existing serde_json; legacy normalization unchanged. Diagnostic only, no performance measurement."});
 println!("{}",report);std::fs::write("/artifacts/posthog-payload-performance/number-diagnostic/report.json",format!("{}\n",report)).unwrap();
}
