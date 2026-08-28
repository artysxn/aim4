//! The contract between the aim4 recorder and the aim4 site.
//!
//! Everything here has an exact counterpart in the site's `shared/comms/`:
//! `format` writes the container that `format.js` reads, and `countdown` is a
//! port of `countdown.js` down to its test vectors. Both halves have to agree,
//! because the recorder writes the sync anchor and the viewer re-derives
//! candidates from the same transcript when the recorder could not find one.
//!
//! Deliberately free of the app's dependencies: no window, no network, no
//! audio. That is what keeps `cargo test -p aim4-recorder-core` fast enough to
//! run on every change to the format.

pub mod budget;
pub mod capture;
pub mod countdown;
pub mod format;
