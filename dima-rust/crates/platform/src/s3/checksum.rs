//! Local workaround: core has no incremental CRC32. IEEE CRC32, as AWS's default checksum.
use base64::{Engine as _, engine::general_purpose::STANDARD};
pub(crate) struct Crc32(u32);
impl Crc32 {
    pub(crate) fn new() -> Self {
        Self(!0)
    }
    pub(crate) fn update(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= u32::from(*b);
            for _ in 0..8 {
                self.0 = (self.0 >> 1) ^ (0xedb88320 & 0u32.wrapping_sub(self.0 & 1));
            }
        }
    }
    pub(crate) fn base64(&self) -> String {
        STANDARD.encode((!self.0).to_be_bytes())
    }
}
pub(crate) fn crc32(bytes: &[u8]) -> String {
    let mut c = Crc32::new();
    c.update(bytes);
    c.base64()
}
