//! #767 — the one signal that every loop waiting for the server sees.
//!
//! Three loops wait for a server that went away, each on its own backoff (1 s doubling to 60 s,
//! `presence::backoff_secs`): the window's probe (`web.rs#start_retry_loop`), the presence link
//! (`presence::run`) and the fiscal bridge (`bridge::fetch_assignment_until`, `bridge::run`).
//! **Retry now** wakes all of them, and so does any one of them reaching the server, so a till's
//! window, presence and bridge come back together instead of up to a minute apart.
//!
//! ⚠ **A generation, never a flag.** It used to be one `AtomicBool` (`LinkState::nudge`) that each
//! waiter swapped back to false. With the unreachable page on screen on a registered till both the
//! window's loop and presence wait, and whichever looked first took the nudge while the other slept
//! on. A counter is never cleared: each waiter compares it with the value it saw last, so one ring
//! wakes every waiter, once each.
//!
//! ⚠ **Which rings a wait counts** (the `seen` passed to [`Wake::sleep`]). Each loop reads
//! [`Wake::current`] as a try BEGINS, and again when a session that reached the server ends:
//!   · a ring from before the try began is old news, and the try itself answered it;
//!   · a ring that came while a try was failing is not lost: the server may have come back after the
//!     try left, and the wait after it ends at once (a failed try takes seconds, a wait a minute);
//!   · a ring that came while the loop's own link was UP (a session of hours, the bridge reconnecting
//!     under it) is stale, and never cuts short the wait after that session.
//!
//! ⚠ **Polled in 100 ms slices, like the waits it replaced.** The shell has no async runtime on these
//! threads (`presence.rs`), and each loop also watches a stop flag of its own that nothing rings: a
//! condition variable would wake on the ring and still poll for the stop.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// How often a wait looks at its stop flag and at the generation.
pub const SLICE: Duration = Duration::from_millis(100);

/// Shared by the three loops and by **Retry now** (`AppState::wake`).
#[derive(Default)]
pub struct Wake {
    generation: AtomicU64,
}

/// Why a [`Wake::sleep`] returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Woke {
    /// The whole wait went by.
    Elapsed,
    /// Something rang since `seen`: try again now.
    Rung,
    /// The loop's own stop flag: end the loop.
    Stopped,
}

impl Wake {
    /// The generation now. Read it as a try begins, and pass it to [`Wake::sleep`] after.
    pub fn current(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Wake every loop that waits: **Retry now**, and a loop that reached the server.
    ///
    /// ⚠ Never for anything else. A stop (`restart_presence`, quitting) is each loop's own flag: a
    /// ring there would send the window's loop to probe for nothing.
    pub fn ring(&self) {
        // Wrapping is fine: a wait only asks whether the value moved.
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// Sleep for `secs`, or until a ring after `seen`, or until `stopped()`, whichever comes first.
    ///
    /// ⚠ `stopped` is asked first: a run told to stop (`restart_presence`) must end, rung or not.
    pub fn sleep(&self, secs: u64, seen: u64, stopped: impl Fn() -> bool) -> Woke {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            if stopped() {
                return Woke::Stopped;
            }
            if self.current() != seen {
                return Woke::Rung;
            }
            let now = Instant::now();
            if now >= deadline {
                return Woke::Elapsed;
            }
            std::thread::sleep(SLICE.min(deadline - now));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    fn never() -> bool {
        false
    }

    /// A waiter on its own thread: began its try at `seen`, waits a minute.
    fn waiter(wake: &Arc<Wake>, seen: u64, stop: Arc<AtomicBool>) -> std::thread::JoinHandle<(Woke, Duration)> {
        let wake = wake.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            let woke = wake.sleep(60, seen, || stop.load(Ordering::SeqCst));
            (woke, started.elapsed())
        })
    }

    #[test]
    fn two_waiters_one_ring_both_wake() {
        // #767: the window's loop and presence both waited on one flag, and the first to look took
        // it. One ring now ends both waits.
        let wake = Arc::new(Wake::default());
        let seen = wake.current();
        let window = waiter(&wake, seen, Arc::new(AtomicBool::new(false)));
        let presence = waiter(&wake, seen, Arc::new(AtomicBool::new(false)));
        std::thread::sleep(Duration::from_millis(300));
        wake.ring();
        for (name, handle) in [("window", window), ("presence", presence)] {
            let (woke, took) = handle.join().unwrap();
            assert_eq!(woke, Woke::Rung, "{name}");
            assert!(took < Duration::from_secs(10), "{name} slept {took:?} of its minute");
        }
    }

    #[test]
    fn a_ring_is_seen_once_by_each_waiter() {
        // What `a_nudge_is_consumed_once` held, per waiter now: Retry now must not fire for ever. A
        // loop that woke tries again, reads the generation as that try begins, and its next wait is
        // a whole one.
        let wake = Wake::default();
        let seen = wake.current();
        wake.ring();
        assert_eq!(wake.sleep(60, seen, never), Woke::Rung);
        assert_eq!(wake.sleep(60, seen, never), Woke::Rung, "another waiter that saw the same value wakes too");
        let next_try = wake.current();
        assert_eq!(wake.sleep(1, next_try, never), Woke::Elapsed, "the same ring must not wake the next wait");
    }

    #[test]
    fn a_ring_before_a_try_began_does_not_wake_the_wait_after_it() {
        // A Retry now pressed an hour ago, or a bridge that reconnected while presence was up: the
        // try that came after answered it, and the wait after that try is not cut short by it.
        let wake = Wake::default();
        wake.ring();
        wake.ring();
        let seen = wake.current();
        let started = Instant::now();
        assert_eq!(wake.sleep(1, seen, never), Woke::Elapsed);
        assert!(started.elapsed() >= Duration::from_millis(900), "slept {:?}", started.elapsed());
    }

    #[test]
    fn a_ring_while_a_try_was_failing_is_not_lost() {
        // The server came back while this loop's try was still failing (a probe is two requests with
        // a 5 s timeout each): another loop found it and rang. Taken at the start of the wait, that
        // ring would be missed and this loop would sleep its minute.
        let wake = Wake::default();
        let seen = wake.current();
        wake.ring(); // during the try
        let started = Instant::now();
        assert_eq!(wake.sleep(60, seen, never), Woke::Rung);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_stop_ends_one_wait_and_rings_nobody() {
        // `restart_presence`: the old presence run is told to stop by its own flag and leaves its
        // sleep within a slice. Nothing is rung, so the window's loop, waiting beside it, sleeps on
        // instead of probing for nothing.
        let wake = Arc::new(Wake::default());
        let seen = wake.current();
        let presence_stop = Arc::new(AtomicBool::new(false));
        let presence = waiter(&wake, seen, presence_stop.clone());
        let window = waiter(&wake, seen, Arc::new(AtomicBool::new(false)));
        std::thread::sleep(Duration::from_millis(300));

        presence_stop.store(true, Ordering::SeqCst);
        let (woke, took) = presence.join().unwrap();
        assert_eq!(woke, Woke::Stopped);
        assert!(took < Duration::from_secs(10), "the old run slept {took:?} after its stop");
        assert_eq!(wake.current(), seen, "a stop rings nobody");

        std::thread::sleep(Duration::from_millis(300));
        assert!(!window.is_finished(), "the window's loop must still be asleep");
        wake.ring();
        assert_eq!(window.join().unwrap().0, Woke::Rung);
    }

    #[test]
    fn the_loop_that_finds_the_server_wakes_the_other_two() {
        // The three loops, as each uses this: the bridge's try reaches the server and rings; the
        // window and presence, asleep on their own backoff, both try again now.
        let wake = Arc::new(Wake::default());
        let window = waiter(&wake, wake.current(), Arc::new(AtomicBool::new(false)));
        let presence = waiter(&wake, wake.current(), Arc::new(AtomicBool::new(false)));

        let bridge_try = wake.current();
        std::thread::sleep(Duration::from_millis(300));
        // ... the bridge's try answered: it says so.
        wake.ring();

        for (name, handle) in [("window", window), ("presence", presence)] {
            let (woke, took) = handle.join().unwrap();
            assert_eq!(woke, Woke::Rung, "{name}");
            assert!(took < Duration::from_secs(10), "{name} slept {took:?}");
        }
        // The bridge's own next wait, after a session that worked, starts from after its ring.
        let after_session = wake.current();
        assert_ne!(after_session, bridge_try);
        assert_eq!(wake.sleep(1, after_session, never), Woke::Elapsed, "its own ring does not wake it");
    }
}
