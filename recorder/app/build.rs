// Embeds the desktop server pack (scripts/build-pack.mjs) when one has been built.
// Without it the app opens aim4.io directly, as before.
fn main() {
    let pack = std::path::Path::new("pack/aim4-pack.zip");
    println!("cargo:rerun-if-changed=pack/aim4-pack.zip");
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("aim4-pack.zip");
    if pack.exists() {
        std::fs::copy(pack, &out).unwrap();
    } else {
        std::fs::write(&out, b"").unwrap();
    }
    println!("cargo:rustc-env=AIM4_PACK={}", out.display());
}
