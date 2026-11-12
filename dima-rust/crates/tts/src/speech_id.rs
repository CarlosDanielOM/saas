//! Uppercase hexadecimal ids, one injected Math.random draw per digit.
pub fn generate(
    random: &dyn dima_core::Random,
    length: usize,
) -> Result<String, dima_core::RandomError> {
    if length > 4096 {
        return Err(dima_core::RandomError::InvalidRange(
            "speech id exceeds 4096 characters",
        ));
    }
    let mut out = String::with_capacity(length);
    for _ in 0..length {
        let digit = (random.float()? * 16.0).floor() as u32;
        out.push(
            char::from_digit(digit, 16)
                .unwrap_or('0')
                .to_ascii_uppercase(),
        );
    }
    Ok(out)
}
