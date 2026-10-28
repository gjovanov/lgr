//! What the supervisor does when a child exits (FR-20 plan step P1-1).
//!
//! Pure functions, so the whole policy is tested without a process in sight. The numbers are
//! roomler's (`agents/roomlerd/src/win_service/supervisor.rs`), which have held in the field:
//! a respawn ladder from 2 s doubling to a 60 s cap, reset once a child has stayed up 30 s.

use std::time::Duration;

/// A child that exits with this code says its configuration is wrong. Restarting cannot help.
pub const EXIT_CONFIG: i32 = 7;
/// A child that exits with this code refused to start on purpose (a restore lock, a clone, a
/// newer database than it can read). Restarting would only hide why.
pub const EXIT_REFUSED: i32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// The first respawn delay, and the floor of the ladder.
    pub initial: Duration,
    /// The ceiling: a child that keeps dying is retried this often, for ever, never given up on.
    pub cap: Duration,
    /// A child that stayed up this long before it died starts the ladder again from the bottom.
    pub healthy: Duration,
}

impl Default for Policy {
    fn default() -> Self {
        Self { initial: Duration::from_secs(2), cap: Duration::from_secs(60), healthy: Duration::from_secs(30) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reaction {
    /// Start it again after this long.
    Respawn(Duration),
    /// Leave it stopped, and say why in the status: an operator has to act.
    Stop,
}

impl Policy {
    /// The delay before respawn number `failures` (1-based): initial, ×2, ×4, …, never above cap.
    pub fn next_backoff(&self, failures: u32) -> Duration {
        let exp = failures.saturating_sub(1).min(20);
        self.initial.saturating_mul(1u32 << exp).min(self.cap)
    }

    /// What to do about an exit the supervisor did not ask for, given how long the child ran and
    /// how many times in a row it failed before. Returns the reaction and the new failure count.
    ///
    /// - A child that ran at least `healthy` was healthy: this is its first failure.
    /// - [`EXIT_CONFIG`] and [`EXIT_REFUSED`] stop it. Everything else is respawned on the ladder,
    ///   a clean `0` included: a server that should run for ever and stopped has failed too.
    /// - `None` (killed by a signal, or no code at all) is a crash like any other.
    pub fn decide(&self, code: Option<i32>, uptime: Duration, failures_before: u32) -> (Reaction, u32) {
        if matches!(code, Some(EXIT_CONFIG) | Some(EXIT_REFUSED)) {
            return (Reaction::Stop, failures_before);
        }
        let failures = if uptime >= self.healthy { 1 } else { failures_before.saturating_add(1) };
        (Reaction::Respawn(self.next_backoff(failures)), failures)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: Policy = Policy { initial: Duration::from_secs(2), cap: Duration::from_secs(60), healthy: Duration::from_secs(30) };

    #[test]
    fn the_default_is_roomlers_ladder() {
        assert_eq!(Policy::default(), P);
    }

    #[test]
    fn the_ladder_doubles_from_two_seconds_and_stops_at_a_minute() {
        let ladder: Vec<u64> = (1..=9).map(|n| P.next_backoff(n).as_secs()).collect();
        assert_eq!(ladder, vec![2, 4, 8, 16, 32, 60, 60, 60, 60]);
        assert_eq!(P.next_backoff(u32::MAX), P.cap);
        assert_eq!(P.next_backoff(0), P.initial);
    }

    #[test]
    fn a_child_that_keeps_dying_climbs_the_ladder() {
        let mut failures = 0;
        let mut delays = vec![];
        for _ in 0..4 {
            let (reaction, f) = P.decide(Some(1), Duration::from_secs(1), failures);
            failures = f;
            delays.push(reaction);
        }
        let secs = |s| Reaction::Respawn(Duration::from_secs(s));
        assert_eq!(delays, vec![secs(2), secs(4), secs(8), secs(16)]);
    }

    #[test]
    fn a_child_that_was_healthy_starts_the_ladder_again() {
        assert_eq!(P.decide(Some(1), P.healthy, 6), (Reaction::Respawn(P.initial), 1));
    }

    #[test]
    fn a_configuration_error_or_a_refusal_is_not_restarted() {
        assert_eq!(P.decide(Some(EXIT_CONFIG), Duration::ZERO, 0).0, Reaction::Stop);
        assert_eq!(P.decide(Some(EXIT_REFUSED), Duration::from_secs(3600), 2), (Reaction::Stop, 2));
    }

    #[test]
    fn a_clean_exit_and_a_signal_are_failures_too() {
        assert_eq!(P.decide(Some(0), Duration::from_secs(1), 0).0, Reaction::Respawn(P.initial));
        assert_eq!(P.decide(None, Duration::from_secs(1), 1).0, Reaction::Respawn(Duration::from_secs(4)));
    }
}
