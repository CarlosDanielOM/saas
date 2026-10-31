pub const LEASE_MS: u64 = 120_000;

pub fn gift_announcement(buyer: &str, recipient: &str, credits: u64, spanish: bool) -> String {
    fn login(s: &str) -> String {
        s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(25).collect()
    }
    let digits = credits.to_string();
    let separator = if spanish { '.' } else { ',' };
    let mut number = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 { number.push(separator); }
        number.push(ch);
    }
    let (buyer, recipient) = (login(buyer), login(recipient));
    if spanish {
        format!("🎁 @{buyer} regaló {number} créditos permanentes de IA a @{recipient}. ¡Ya están disponibles! ¡Gracias!")
    } else {
        format!("🎁 @{buyer} gifted {number} permanent AI credits to @{recipient}. The credits are ready to use. Thank you!")
    }
}
