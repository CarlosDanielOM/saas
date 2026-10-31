//! Placeholder only: the production worker must not be registered until the
//! durable gift lifecycle and its application adapters are implemented.
fn main() {
    if std::env::args().any(|arg| arg == "--dry-run") {
        println!("{{\"worker\":\"credit-gifts\"}}");
        return;
    }
    eprintln!("credit-gifts worker is not implemented");
    std::process::exit(1);
}
