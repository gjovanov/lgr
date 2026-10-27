//! Pacing the bulk socket on the shop's upstream (FR-20.52, FR-20.68, plan step P3-2c).
//!
//! Two sockets keep a catch-up from queueing in front of a click inside the supervisor, but not on
//! the line: a shop's ADSL or 4G upstream sits behind a router with a deep buffer, and every byte the
//! bulk socket hands the kernel waits there in front of the interactive socket's. A 1 MB chunk on a
//! 512 kbit/s line is sixteen seconds in front of a click. So the bulk socket is paced, by delay:
//! - **The line's queue is measured on the interactive socket.** While bulk has work, a ping every
//!   two seconds (`SAMPLE_EVERY`): its round trip, less the least seen in ten minutes, is the delay
//!   queued in front of a click.
//! - **A rate.** Over the target delay it falls (by a fifth; by half when far over), at most once a
//!   round trip or two. Under it, it grows by a quarter, but only on evidence: bulk used at least
//!   two fifths of what the rate allowed since the last sample (an idle line says nothing about the
//!   line). Never below `MIN_RATE`: the mirror never stops. With no samples it holds.
//! - **A route that changes is followed.** The base round trip is the least of ten minutes, so a
//!   slower route reads as queue; when the rate has sat at the floor for two minutes and the delay
//!   still will not drop, that queue is not the mirror's, and the base starts again from the last
//!   minute.
//! - **Pieces that fit the rate.** A page asked for, or a file's chunk, is about a quarter of a second
//!   of it (`piece`), so what a click waits behind is bounded whatever the line.
//! - **A token bucket** spaces the frames out (`take`), in the pump's own task: the socket's loop
//!   never waits on it.
//!
//! Off with `LGR_BULK_PACING=off`, for a line nothing else uses.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The delay a click may wait behind the mirror on the line, over the line's own round trip.
pub const TARGET: Duration = Duration::from_millis(150);
/// The mirror never stops: at least this, whatever the line says.
pub const MIN_RATE: f64 = 8.0 * 1024.0;
/// Where a rate starts: a slow line's share, grown from there by what the line shows.
pub const START_RATE: f64 = 64.0 * 1024.0;
/// Above any shop's upstream: the line's delay is the cap.
pub const MAX_RATE: f64 = 100.0 * 1024.0 * 1024.0;
/// A page or a chunk is about this much of the rate: what a click may wait behind.
pub const PIECE_TIME: Duration = Duration::from_millis(250);
pub const PIECE_MIN: usize = 16 * 1024;
pub const PIECE_MAX: usize = 1 << 20;
/// While bulk has work, the interactive socket's round trip is measured this often.
pub const SAMPLE_EVERY: Duration = Duration::from_secs(2);
/// Bulk counts as having work for this long after it last sent.
const BUSY_FOR: Duration = Duration::from_secs(10);
/// The base round trip: the least of each minute, over the last ten.
const BASE_BUCKET: Duration = Duration::from_secs(60);
const BASE_BUCKETS: usize = 10;
/// The share of the rate bulk must have used for growing it to be evidence-based.
const USED_TO_GROW: f64 = 0.4;
/// At the floor this long with the delay still over the target: the queue is not the mirror's.
const STUCK_FOR: Duration = Duration::from_secs(120);

pub struct Pacer {
    state: Mutex<State>,
}

struct State {
    rate: f64,
    /// Bytes that may go now; below zero, a debt the next frame waits out.
    tokens: f64,
    refilled: Instant,
    /// Per minute: when it began, and the least round trip seen in it.
    base: VecDeque<(Instant, Duration)>,
    last_rtt: Option<Duration>,
    last_delay: Option<Duration>,
    last_sample: Option<Instant>,
    last_cut: Option<Instant>,
    /// Bytes bulk reserved since the last sample.
    sent: f64,
    busy_until: Option<Instant>,
    /// Since when the rate sits at the floor with the delay over the target.
    stuck_since: Option<Instant>,
    cuts: u64,
}

impl Pacer {
    pub fn new(now: Instant) -> Self {
        Self {
            state: Mutex::new(State {
                rate: START_RATE,
                tokens: PIECE_MIN as f64,
                refilled: now,
                base: VecDeque::new(),
                last_rtt: None,
                last_delay: None,
                last_sample: None,
                last_cut: None,
                sent: 0.0,
                busy_until: None,
                stuck_since: None,
                cuts: 0,
            }),
        }
    }

    /// On unless `LGR_BULK_PACING=off`.
    pub fn from_env() -> Option<Arc<Self>> {
        match std::env::var("LGR_BULK_PACING").ok().as_deref().map(str::trim) {
            Some("off" | "0" | "false") => None,
            _ => Some(Arc::new(Self::new(Instant::now()))),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The interactive socket's round trip, measured: the rate follows the line's queue.
    pub fn sample(&self, rtt: Duration, now: Instant) {
        let mut s = self.lock();
        match s.base.back_mut() {
            Some((start, least)) if now.saturating_duration_since(*start) < BASE_BUCKET => *least = (*least).min(rtt),
            _ => s.base.push_back((now, rtt)),
        }
        while s.base.len() > BASE_BUCKETS {
            s.base.pop_front();
        }
        let base = s.base.iter().map(|(_, d)| *d).min().unwrap_or(rtt);
        let delay = rtt.saturating_sub(base);
        // What bulk used of the rate since the last sample: growing is evidence only when it was used.
        let used = s.last_sample.map(|at| {
            let allowed = s.rate * now.saturating_duration_since(at).as_secs_f64();
            if allowed > 0.0 { s.sent / allowed } else { 0.0 }
        });
        s.last_rtt = Some(rtt);
        s.last_delay = Some(delay);
        s.last_sample = Some(now);
        s.sent = 0.0;
        if delay > TARGET {
            // At most once a round trip or two: the queue a cut left needs that long to drain.
            let spacing = (rtt * 2).max(Duration::from_secs(1));
            if s.last_cut.is_none_or(|at| now.saturating_duration_since(at) >= spacing) {
                let factor = if delay > TARGET * 4 { 0.5 } else { 0.8 };
                s.rate = (s.rate * factor).max(MIN_RATE);
                s.last_cut = Some(now);
                s.cuts += 1;
            }
            if s.rate <= MIN_RATE * 2.0 {
                let since = *s.stuck_since.get_or_insert(now);
                if now.saturating_duration_since(since) >= STUCK_FOR {
                    // Sending next to nothing and still a queue: a slower route, not the mirror's queue.
                    let newest = s.base.pop_back();
                    s.base.clear();
                    s.base.extend(newest);
                    s.stuck_since = None;
                }
            } else {
                s.stuck_since = None;
            }
        } else {
            s.stuck_since = None;
            if used.is_some_and(|u| u >= USED_TO_GROW) {
                s.rate = (s.rate * 1.25 + 4096.0).min(MAX_RATE);
            }
        }
    }

    /// How many bytes the next page or chunk may hold: about a quarter of a second of the rate.
    pub fn piece(&self) -> usize {
        piece_of(self.lock().rate)
    }

    /// Reserve `bytes`, and say how long to wait before they may go.
    pub fn reserve(&self, bytes: usize, now: Instant) -> Duration {
        let mut s = self.lock();
        let burst = piece_of(s.rate) as f64;
        let elapsed = now.saturating_duration_since(s.refilled).as_secs_f64();
        s.tokens = (s.tokens + elapsed * s.rate).min(burst);
        s.refilled = now;
        s.tokens -= bytes as f64;
        s.sent += bytes as f64;
        s.busy_until = Some(now + BUSY_FOR);
        if s.tokens >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-s.tokens / s.rate)
        }
    }

    /// Wait until `bytes` may go on the bulk socket.
    pub async fn take(&self, bytes: usize) {
        let wait = self.reserve(bytes, Instant::now());
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }

    /// Whether the interactive socket should measure the line now: bulk has work.
    pub fn wants_samples(&self, now: Instant) -> bool {
        self.lock().busy_until.is_some_and(|until| now < until)
    }

    /// For `lgr-server status`.
    pub fn snapshot(&self) -> serde_json::Value {
        let s = self.lock();
        let ms = |d: Option<Duration>| d.map(|d| d.as_millis() as u64);
        serde_json::json!({
            "rateBytesPerSec": s.rate.round() as u64,
            "piece": piece_of(s.rate),
            "baseRttMs": ms(s.base.iter().map(|(_, d)| *d).min()),
            "lastRttMs": ms(s.last_rtt),
            "delayMs": ms(s.last_delay),
            "cuts": s.cuts,
        })
    }

    #[cfg(test)]
    fn rate(&self) -> f64 {
        self.lock().rate
    }
}

fn piece_of(rate: f64) -> usize {
    ((rate * PIECE_TIME.as_secs_f64()) as usize).clamp(PIECE_MIN, PIECE_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: fn(u64) -> Duration = Duration::from_millis;

    /// Bulk sends everything the rate allows over `d` from `t`.
    fn use_it(p: &Pacer, t: Instant, d: Duration) {
        let _ = p.reserve((p.rate() * d.as_secs_f64()) as usize, t);
    }

    #[test]
    fn under_the_target_the_rate_grows_only_on_evidence_that_bulk_used_it() {
        let t0 = Instant::now();
        let p = Pacer::new(t0);
        p.sample(MS(40), t0);
        // Idle bulk is no evidence: the rate holds.
        p.sample(MS(45), t0 + SAMPLE_EVERY);
        assert_eq!(p.rate(), START_RATE);
        // A trickle, a tenth of the rate: still no evidence.
        let _ = p.reserve((START_RATE * 0.1 * SAMPLE_EVERY.as_secs_f64()) as usize, t0 + SAMPLE_EVERY);
        p.sample(MS(45), t0 + SAMPLE_EVERY * 2);
        assert_eq!(p.rate(), START_RATE);
        // Bulk used the rate, and the line's delay stayed low: it grows.
        use_it(&p, t0 + SAMPLE_EVERY * 2, SAMPLE_EVERY);
        p.sample(MS(50), t0 + SAMPLE_EVERY * 3);
        assert!(p.rate() > START_RATE * 1.2, "{}", p.rate());
    }

    #[test]
    fn over_the_target_it_falls_once_a_round_trip_never_below_the_floor() {
        let t0 = Instant::now();
        let p = Pacer::new(t0);
        p.sample(MS(40), t0);
        // 400 ms queued in front of a click: a cut by a fifth.
        p.sample(MS(440), t0 + MS(100));
        assert!((p.rate() - START_RATE * 0.8).abs() < 1.0, "{}", p.rate());
        // Again within the spacing (two round trips): nothing more, the queue is still draining.
        p.sample(MS(450), t0 + MS(500));
        assert!((p.rate() - START_RATE * 0.8).abs() < 1.0);
        // Far over the target, after the spacing of that round trip: by half.
        p.sample(MS(2_000), t0 + MS(1_200));
        p.sample(MS(2_000), t0 + MS(5_300));
        assert!((p.rate() - START_RATE * 0.4).abs() < 1.0, "{}", p.rate());
        for i in 0..10 {
            p.sample(MS(5_000), t0 + Duration::from_secs(20 + i * 11));
        }
        assert_eq!(p.rate(), MIN_RATE);
    }

    #[test]
    fn a_slower_route_is_followed_within_minutes_not_ten() {
        let t0 = Instant::now();
        let p = Pacer::new(t0);
        p.sample(MS(20), t0);
        // A slower route from now on: at first it reads as queue, and is cut to the floor.
        let mut t = t0;
        for _ in 0..30 {
            t += SAMPLE_EVERY;
            p.sample(MS(300), t);
        }
        assert_eq!(p.rate(), MIN_RATE);
        // At the floor two minutes with the delay unmoved: the base starts again from the last minute.
        for _ in 0..70 {
            t += SAMPLE_EVERY;
            use_it(&p, t, SAMPLE_EVERY);
            p.sample(MS(300), t);
        }
        assert!(t.duration_since(t0) < Duration::from_secs(300));
        assert!(p.rate() > MIN_RATE * 4.0, "{}", p.rate());
    }

    #[test]
    fn frames_are_spaced_by_the_rate_and_pieces_follow_it() {
        let t0 = Instant::now();
        let p = Pacer::new(t0);
        // A quarter of a second of 64 KB/s, within its bounds.
        assert_eq!(p.piece(), PIECE_MIN);
        // What is in the bucket goes at once; the rest waits its share of the rate.
        assert_eq!(p.reserve(PIECE_MIN, t0), Duration::ZERO);
        let wait = p.reserve(64 * 1024, t0);
        assert!((wait.as_secs_f64() - 1.0).abs() < 0.01, "{wait:?}");
        // The bucket refills at the rate, up to one piece: an idle minute is no licence for a burst.
        assert_eq!(p.reserve(0, t0 + Duration::from_secs(60)), Duration::ZERO);
        assert!(p.reserve(PIECE_MIN * 2, t0 + Duration::from_secs(60)) > Duration::ZERO);
        // Busy while it sends, and some seconds after.
        assert!(p.wants_samples(t0 + Duration::from_secs(61)));
        assert!(!p.wants_samples(t0 + Duration::from_secs(120)));
    }

    #[test]
    fn a_fast_line_is_found_within_half_a_minute() {
        let t0 = Instant::now();
        let p = Pacer::new(t0);
        p.sample(MS(30), t0);
        let mut t = t0;
        for _ in 0..15 {
            use_it(&p, t, SAMPLE_EVERY);
            t += SAMPLE_EVERY;
            p.sample(MS(35), t);
        }
        // 10 Mbit/s within thirty seconds of samples, and the pieces with it.
        assert!(p.rate() >= 1.25 * 1024.0 * 1024.0, "{}", p.rate());
        assert_eq!(p.piece(), piece_of(p.rate()));
        assert!(p.piece() >= 256 * 1024);
    }
}
