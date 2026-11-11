//! Golden checks that need no database: JSON rendering of raw BSON recorded from the Node
//! driver, the Node number writer, int64 reads and Mongoose's ObjectId cast table.
//!
//! The recording is `tests/mongo_golden/golden.json` (see `record.mjs` there).

use anyhow::{Context, Result, bail};
use bson::{Bson, Document};
use dima_store::mongo::{id, json, number};
use serde_json::Value;

fn golden() -> Result<Value> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/mongo_golden/golden.json"
    );
    let text = std::fs::read_to_string(path).context("reading golden.json")?;
    serde_json::from_str(&text).context("parsing golden.json")
}

fn hex_bytes(hex: &str) -> Result<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        bail!("odd hex length");
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            let pair = hex.get(i..i + 2).context("hex pair")?;
            u8::from_str_radix(pair, 16).context("hex digit")
        })
        .collect()
}

fn decode(hex: &str) -> Result<Document> {
    Document::from_reader(hex_bytes(hex)?.as_slice()).context("decoding recorded BSON")
}

#[test]
fn json_matches_node_for_every_bson_type() -> Result<()> {
    let golden = golden()?;
    let sample = &golden["json"];
    let document = decode(sample["bsonHex"].as_str().context("bsonHex")?)?;
    let expected = sample["driverJson"].as_str().context("driverJson")?;
    assert_eq!(json::to_json_string(&document), expected);
    // Mongoose `.lean()` hands Express the same object as the driver.
    assert_eq!(sample["mongooseLeanJson"].as_str(), Some(expected));
    // The value form agrees with the text form.
    let reparsed: Value = serde_json::from_str(expected)?;
    assert_eq!(json::to_json_value(&document), reparsed);
    Ok(())
}

#[test]
fn json_matches_node_for_crafted_bson() -> Result<()> {
    let golden = golden()?;
    let crafted = golden["json"]["crafted"]
        .as_array()
        .context("crafted samples")?;
    let mut compared = 0;
    for sample in crafted {
        let name = sample["name"].as_str().context("name")?;
        let document = decode(sample["bsonHex"].as_str().context("bsonHex")?)?;
        let rendered = json::to_json_string(&document);
        match sample["json"].as_str() {
            Some(expected) => {
                assert_eq!(rendered, expected, "crafted sample {name}");
                compared += 1;
            }
            // Node cannot read these at all (a pattern or flags JavaScript rejects); the Rust
            // renderer writes `{}` for the pattern instead of failing the whole read.
            None => assert!(rendered.contains("{}"), "crafted sample {name}: {rendered}"),
        }
    }
    assert!(compared >= 13, "only {compared} crafted samples compared");
    Ok(())
}

#[test]
fn node_number_writer_table() -> Result<()> {
    let golden = golden()?;
    let rows = golden["numbers"]["jsNumbers"]
        .as_array()
        .context("jsNumbers")?;
    for row in rows {
        let input = row["input"].as_str().context("input")?;
        let value = match input {
            "-0" => -0.0,
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            other => other.parse::<f64>().context("number input")?,
        };
        let expected = Bson::try_from(row["stored"].clone()).context("stored value")?;
        let actual = number::js_number(value);
        let same = match (&actual, &expected) {
            (Bson::Double(a), Bson::Double(b)) => {
                a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
            }
            _ => actual == expected,
        };
        assert!(same, "{input}: {actual:?} != {expected:?}");
    }
    let writes = golden["numbers"]["mongooseWrites"]
        .as_array()
        .context("mongooseWrites")?;
    let written: Vec<Bson> = writes
        .iter()
        .map(|row| Bson::try_from(row["n"].clone()))
        .collect::<Result<_, _>>()?;
    assert_eq!(
        written,
        vec![
            number::js_number(5.0),
            number::js_number(2_147_483_648.0),
            number::js_number(7.0)
        ]
    );
    Ok(())
}

#[test]
fn int64_reads_match_hydrated_mongoose() -> Result<()> {
    let golden = golden()?;
    for row in golden["numbers"]["int64Reads"]
        .as_array()
        .context("int64Reads")?
    {
        let stored: i64 = row["stored"].as_str().context("stored")?.parse()?;
        let hydrated: f64 = row["hydrated"]["json"]
            .as_str()
            .context("hydrated")?
            .parse()?;
        assert_eq!(
            number::read_number(&Bson::Int64(stored)),
            Some(hydrated),
            "{stored}"
        );
        // A raw or lean read keeps a Long object beyond 2^53, which is what the JSON renderer writes.
        let lean = row["lean"]["json"].as_str().context("lean")?;
        assert_eq!(
            json::bson_to_json_value(&Bson::Int64(stored))
                .map(|v| dima_text::to_js_json(&v))
                .as_deref(),
            Some(lean)
        );
    }
    Ok(())
}

#[test]
fn object_id_cast_table() -> Result<()> {
    let golden = golden()?;
    for row in golden["objectIdCasts"]
        .as_array()
        .context("objectIdCasts")?
    {
        let input = row["input"].as_str().context("input")?;
        let actual = id::parse_object_id(input).map(|oid| oid.to_hex()).ok();
        let expected = row["cast"].as_str().map(str::to_owned);
        assert_eq!(actual, expected, "{input:?}");
        assert_eq!(
            actual.is_some(),
            row["isValidObjectId"].as_bool() == Some(true),
            "{input:?}"
        );
    }
    Ok(())
}
