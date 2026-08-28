//! Joining a TeamSpeak channel and capturing every speaker separately.
//!
//! The one part of the recorder that cannot be proved without a real server,
//! which is why everything it does with the packets lives in
//! `aim4_recorder_core::capture` instead: this module's whole job is to turn a
//! tsclientlib event stream into `SegmentWriter::push` calls and to remember
//! who each speaking client is.
//!
//! Why a bot client rather than a plugin on the user's TeamSpeak: incoming
//! voice arrives already separated. Each packet is
//! `AudioData::S2C { from, codec, data }`, so per-speaker tracks are what the
//! protocol hands over, not something reconstructed from a mixed stream.
//!
//! Nothing is decoded while recording. Frames go to disk exactly as they
//! arrive, so a session costs I/O and nothing else while a game is running.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use aim4_recorder_core::capture::{Segment, SegmentWriter};
use futures::prelude::*;
use tsclientlib::{ClientId, Connection, DisconnectOptions, Identity, OutCommandExt, StreamItem};
use tsproto_packets::packets::{AudioData, Direction, Flags, OutCommand, PacketType};

/// Who a speaking client turned out to be.
#[derive(Debug, Clone, PartialEq)]
pub struct Speaker {
    /// TeamSpeak identity UID: stable across nickname changes, and the key the
    /// site maps to a roster player.
    pub uid: String,
    pub nickname: String,
    pub talk_ms: i64,
}

#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub address: String,
    pub nickname: String,
    /// Channel to join by path. None stays in the default channel.
    pub channel: Option<String>,
    pub server_password: Option<String>,
    pub channel_password: Option<String>,
    /// Reused across sessions so the bot keeps one identity on the server.
    pub identity: Identity,
}

#[derive(Debug)]
pub struct SessionResult {
    pub segments: Vec<Segment>,
    /// Keyed by the client id the segments carry.
    pub speakers: HashMap<u16, Speaker>,
    pub duration_ms: i64,
    pub dir: PathBuf,
    /// Set when the session ended by itself — a kick, a dead network, a full
    /// disk — rather than by the user's Stop. The recording up to that moment
    /// is still complete and packable; this is what tells the user why it is
    /// shorter than they expected.
    pub interrupted: Option<String>,
}

/// What the window shows while a recording runs. Written by the capture loop,
/// read by the UI thread; a Mutex because both sides only ever hold it for a
/// field copy.
#[derive(Debug, Default, Clone)]
pub struct LiveStatus {
    pub connected: bool,
    /// Nickname and talk time so far, most talkative first.
    pub speakers: Vec<(String, i64)>,
    pub total_talk_ms: i64,
}

/// Record a channel until `stop` is set.
///
/// `stop` rather than a timeout because the user decides when a scrim is over,
/// and the window sets it from the Stop button. `live`, when given, is kept
/// current for a status readout; the CLI passes None and prints at the end.
pub async fn record(
    cfg: SessionConfig,
    dir: impl AsRef<Path>,
    stop: Arc<AtomicBool>,
    live: Option<Arc<std::sync::Mutex<LiveStatus>>>,
) -> Result<SessionResult, Box<dyn std::error::Error>> {
    let dir = dir.as_ref().to_path_buf();
    let mut writer = SegmentWriter::new(&dir)?;
    let mut speakers: HashMap<u16, Speaker> = HashMap::new();

    let mut builder = Connection::build(cfg.address.clone())
        .name(cfg.nickname.clone())
        .identity(cfg.identity.clone());
    if let Some(channel) = &cfg.channel {
        builder = builder.channel(channel.clone());
    }
    if let Some(pw) = &cfg.server_password {
        builder = builder.password(pw.clone());
    }
    if let Some(pw) = &cfg.channel_password {
        builder = builder.channel_password(pw.clone());
    }

    let mut con = builder.connect()?;

    // Wait for the first book update: until it lands there are no clients to
    // name and no channel to be in. The stop flag and a deadline stay in view
    // the whole time — an unreachable server must not hang the window with a
    // Stop button that does nothing.
    let connect_deadline = Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if stop.load(Ordering::Relaxed) {
            return Err("stopped before the connection came up".into());
        }
        if Instant::now() > connect_deadline {
            return Err("could not reach the server within 30 seconds".into());
        }
        let item = {
            let mut events = con.events();
            tokio::select! {
                item = events.next() => item,
                _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => continue,
            }
        };
        match item {
            Some(Ok(StreamItem::BookEvents(_))) => break,
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(format!("could not connect: {e}").into()),
            None => return Err("the connection closed before it was up".into()),
        }
    }

    // Tell the server this client is recording, which is what puts the little
    // recording marker beside it in everyone's client list. People are being
    // recorded; they get to see that without being told separately.
    let mut cmd = OutCommand::new(
        Direction::C2S,
        Flags::empty(),
        PacketType::Command,
        "clientupdate",
    );
    cmd.write_arg("client_is_recording", &1);
    if let Err(err) = cmd.send(&mut con) {
        // Not fatal: a server that refuses the flag is still recordable, and
        // failing the whole session over a status bit would be worse.
        eprintln!("could not set the recording flag: {err}");
    }

    let started = Instant::now();
    let now_ms = move || started.elapsed().as_millis() as i64;

    // Names are read from the book as packets arrive rather than once up
    // front: someone can join, rename, or reconnect mid-scrim.
    let remember = |con: &Connection, id: ClientId, speakers: &mut HashMap<u16, Speaker>| {
        let Ok(state) = con.get_state() else { return };
        let Some(client) = state.clients.get(&id) else { return };
        let entry = speakers.entry(id.0).or_insert_with(|| Speaker {
            uid: String::new(),
            nickname: String::new(),
            talk_ms: 0,
        });
        if let Some(uid) = &client.uid {
            entry.uid = uid.to_string();
        }
        entry.nickname = client.name.clone();
    };

    if let Some(live) = &live {
        if let Ok(mut l) = live.lock() {
            l.connected = true;
        }
    }

    let mut interrupted: Option<String> = None;

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }

        // Keep the window's readout current. Every pass is fine: the loop
        // wakes at most every 120ms, and the copy is a dozen small fields.
        if let Some(live) = &live {
            let mut list: Vec<(String, i64)> = speakers
                .iter()
                .map(|(id, s)| {
                    let name = if s.nickname.is_empty() {
                        format!("client {id}")
                    } else {
                        s.nickname.clone()
                    };
                    (name, writer.talk_ms(*id))
                })
                .collect();
            list.sort_by(|a, b| b.1.cmp(&a.1));
            if let Ok(mut l) = live.lock() {
                l.speakers = list;
                l.total_talk_ms = writer.total_talk_ms();
            }
        }

        let next = {
            let mut events = con.events();
            tokio::select! {
                item = events.next() => item,
                _ = tokio::time::sleep(std::time::Duration::from_millis(120)) => None,
            }
        };

        let Some(item) = next else {
            // Timed out with nothing to do, which is most of a round. Loop back
            // so the stop flag is checked promptly.
            continue;
        };

        // Anything that goes wrong from here on ends the session, it does not
        // lose it: an hour of scrim comms is on disk by now, and a kick in the
        // last round or a disk filling up must salvage that hour, not throw it
        // away with an Err.
        let item = match item {
            Ok(item) => item,
            Err(e) => {
                interrupted = Some(format!("the connection died: {e}"));
                break;
            }
        };
        match item {
            StreamItem::Audio(packet) => {
                let (from, codec, data) = match packet.data().data() {
                    AudioData::S2C { from, codec, data, .. } => (*from, *codec as u8, *data),
                    AudioData::S2CWhisper { from, codec, data, .. } => (*from, *codec as u8, *data),
                    // C2S is this client's own microphone, which it does not have.
                    _ => continue,
                };
                if let Err(e) = writer.push(from, codec, data, now_ms()) {
                    interrupted = Some(format!("could not keep writing audio: {e}"));
                    break;
                }
                if !data.is_empty() {
                    remember(&con, ClientId(from), &mut speakers);
                }
            }
            StreamItem::DisconnectedTemporarily(_) => {
                // The library reconnects on its own; close open segments so a
                // gap does not become one impossibly long utterance. Best
                // effort — the gap rule in the writer catches it anyway if
                // this fails.
                let open: Vec<u16> = speakers.keys().copied().collect();
                for id in open {
                    writer.close_speaker(id, now_ms()).ok();
                }
            }
            _ => {}
        }
    }

    let duration_ms = now_ms();
    let segments = writer.finish(duration_ms)?;
    for (id, speaker) in speakers.iter_mut() {
        speaker.talk_ms = writer.talk_ms(*id);
    }

    // Best effort: the recording on disk is already complete, and a goodbye
    // the server never hears must not turn a finished session into an error.
    if con.disconnect(DisconnectOptions::new()).is_ok() {
        con.events().for_each(|_| future::ready(())).await;
    }

    Ok(SessionResult {
        segments,
        speakers,
        duration_ms,
        dir,
        interrupted,
    })
}

/// A stable identity for this installation, created once and reused.
///
/// Reused so the bot is the same client to the server every time: server
/// groups, channel permissions and bans are all attached to an identity, and a
/// bot that arrives as a stranger each session has to be re-permitted each
/// session.
pub fn load_or_create_identity(path: impl AsRef<Path>) -> Result<Identity, Box<dyn std::error::Error>> {
    let path = path.as_ref();
    if let Ok(text) = std::fs::read_to_string(path) {
        if let Ok(id) = Identity::new_from_str(text.trim()) {
            return Ok(id);
        }
    }
    let mut id = Identity::create();
    // Servers can require a minimum identity security level, and computing it
    // is deliberately slow work that must not be repeated every launch. Do it
    // once here, then persist the counter that proves it alongside the key —
    // storing the key alone would silently drop back to level 0 on next start.
    id.upgrade_level(8);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, format!("{}V{}", id.counter(), id.key().to_ts()))?;
    Ok(id)
}
