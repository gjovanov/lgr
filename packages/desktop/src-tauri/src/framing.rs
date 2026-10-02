//! C18 — when is a fiscal device's answer complete? (FR-14.26)
//!
//! ⚠ **This is a deliberate port of the browser relay's framing**, not a new idea:
//! `packages/ui-shared/src/composables/fiscalIslResponse.ts` and the heuristic at the bottom of
//! `useFiscalBridge.ts`. The native bridge and the Web Serial relay must answer the hub
//! **identically**, because the hub's drivers (`packages/fiscal/src/isl-frame.ts`, `eltrade.ts`,
//! `tremol.ts`) are the same either way and have no idea which transport carried the bytes.
//!
//! ⚠ **The shell only finds frame boundaries.** It does not check a BCC, does not retry, does not
//! reorder, and does not interpret a status byte — all of that is the driver's business on the
//! hub (C18's trap 4: Eltrade REPLAYS a same-SEQ frame instead of executing it, so a transport
//! that helpfully resent one would silently turn a second sale into a repeat of the first).
//!
//! Pure, so every rule here is tested without a serial port or a socket.

/// ISL answer: `<01><LEN><SEQ><CMD><DATA><04><STATUS×6><05><BCC×4><03>`
const PREAMBLE: u8 = 0x01;
const TERMINATOR: u8 = 0x03;
const POSTAMBLE: u8 = 0x05;
const NAK: u8 = 0x15;
/// The device is busy; it repeats this every 60 ms until the answer is ready.
const SYN: u8 = 0x16;

/// Tremol/Datecs terminate with LF rather than ETX.
const ETX_TREMOL: u8 = 0x0A;

/// The shortest frame that can still carry `…<05><BCC×4><03>` and a readable SEQ.
const MIN_ISL_FRAME: usize = 17;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Collect {
    /// Still arriving — keep reading.
    More,
    /// A complete answer to THIS command.
    Frame,
    /// The device rejected our frame; the hub's driver resends it.
    Nak,
}

/// Collects an ISL answer, stopping at the frame carrying the SEQ of the command just written.
///
/// ⚠ **The SEQ match is the whole point.** A frame with another SEQ is a late answer to an
/// earlier command that timed out. Dropped here; handed back instead, it would answer the NEXT
/// command and every exchange after it would be one step behind — which on a till means a receipt
/// reporting the previous sale's total.
pub struct IslCollector {
    seq: u8,
    buffer: Vec<u8>,
    result: Option<Vec<u8>>,
    /// Bytes seen so far, SYN included — any byte at all means the device is alive.
    pub received: usize,
}

impl IslCollector {
    /// `seq` is the SEQ byte of the request frame, i.e. `frame[2]`.
    pub fn new(seq: u8) -> Self {
        Self { seq, buffer: Vec::new(), result: None, received: 0 }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Collect {
        if let Some(r) = &self.result {
            return if r.len() == 1 { Collect::Nak } else { Collect::Frame };
        }
        self.received += chunk.len();
        self.buffer.extend_from_slice(chunk);
        self.scan()
    }

    /// What to send back to the hub: the matching frame, or a lone NAK.
    ///
    /// ⚠ On a timeout this returns whatever is in the buffer, which may be nothing. The caller
    /// decides whether that is an error — this type never invents an answer.
    pub fn bytes(&self) -> Vec<u8> {
        self.result.clone().unwrap_or_else(|| self.buffer.clone())
    }

    fn scan(&mut self) -> Collect {
        let mut i = 0usize;
        let mut nak = false;

        while i < self.buffer.len() {
            let b = self.buffer[i];
            if b == SYN || b == NAK {
                if b == NAK {
                    nak = true;
                }
                i += 1;
                continue;
            }
            if b != PREAMBLE {
                i += 1;
                continue;
            }

            match self.buffer[i + 1..].iter().position(|&x| x == TERMINATOR) {
                None => {
                    // The frame is still arriving. Keep it, drop the noise before it.
                    self.buffer.drain(..i);
                    return Collect::More;
                }
                Some(offset) => {
                    let end = i + 1 + offset;
                    let frame = &self.buffer[i..=end];
                    if frame.len() >= MIN_ISL_FRAME
                        && frame[frame.len() - 6] == POSTAMBLE
                        && frame[2] == self.seq
                    {
                        self.result = Some(frame.to_vec());
                        return Collect::Frame;
                    }
                    // A stale answer or noise: discard it and keep reading.
                    i = end + 1;
                }
            }
        }

        self.buffer.clear();
        if nak {
            self.result = Some(vec![NAK]);
            return Collect::Nak;
        }
        Collect::More
    }
}

/// The pre-ISL heuristic, for Datecs and Tremol: stop at the terminator the manufacturer uses.
///
/// ⚠ Kept because the hub still speaks it — `createBridgePrinter` hands a Datecs or Tremol device
/// to a driver that sends no `protocol` field, and the relay that predates ISL framing answered
/// exactly this way. A native bridge that only understood ISL would work on an Eltrade and quietly
/// hang on everything else.
pub struct HeuristicCollector {
    buffer: Vec<u8>,
    done: bool,
}

impl Default for HeuristicCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl HeuristicCollector {
    pub fn new() -> Self {
        Self { buffer: Vec::new(), done: false }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Collect {
        if self.done {
            return Collect::Frame;
        }
        // A bare NAK as the very first thing is the device rejecting the frame.
        if self.buffer.is_empty() && chunk == [NAK] {
            self.buffer.extend_from_slice(chunk);
            self.done = true;
            return Collect::Nak;
        }
        self.buffer.extend_from_slice(chunk);
        match chunk.last() {
            Some(&TERMINATOR) | Some(&ETX_TREMOL) => {
                self.done = true;
                Collect::Frame
            }
            _ => Collect::More,
        }
    }

    pub fn bytes(&self) -> Vec<u8> {
        self.buffer.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a well-formed ISL answer with the given SEQ: 01 LEN SEQ CMD <data> 04 <6 status> 05
    /// <4 bcc> 03 — 17 bytes with one data byte, which is also the minimum this accepts.
    fn frame(seq: u8, data: &[u8]) -> Vec<u8> {
        let mut f = vec![PREAMBLE, 0x20, seq, 0x4a];
        f.extend_from_slice(data);
        f.push(0x04);
        f.extend_from_slice(&[0x80; 6]);
        f.push(POSTAMBLE);
        f.extend_from_slice(&[0x30; 4]);
        f.push(TERMINATOR);
        f
    }

    #[test]
    fn a_complete_answer_with_the_matching_seq_is_the_result() {
        let f = frame(0x21, b"OK");
        let mut c = IslCollector::new(0x21);
        assert_eq!(c.push(&f), Collect::Frame);
        assert_eq!(c.bytes(), f);
    }

    #[test]
    fn a_frame_split_across_reads_is_reassembled() {
        // Serial delivers whatever the driver buffered, which is rarely a whole frame.
        let f = frame(0x21, b"OK");
        let mut c = IslCollector::new(0x21);
        for chunk in f.chunks(3) {
            let _ = c.push(chunk);
        }
        assert_eq!(c.bytes(), f);
    }

    #[test]
    fn a_late_answer_to_an_earlier_command_is_dropped() {
        // ⚠ The rule that keeps a till from printing the previous sale's total. The stale frame
        // arrives FIRST and must not be returned.
        let stale = frame(0x20, b"OLD");
        let mine = frame(0x21, b"NEW");
        let mut c = IslCollector::new(0x21);

        assert_eq!(c.push(&stale), Collect::More, "another SEQ is not my answer");
        assert_eq!(c.push(&mine), Collect::Frame);
        assert_eq!(c.bytes(), mine);
    }

    #[test]
    fn syn_means_busy_and_is_not_an_answer() {
        let mut c = IslCollector::new(0x21);
        assert_eq!(c.push(&[SYN; 4]), Collect::More);
        assert!(c.received >= 4, "SYN still proves the device is alive");
        let f = frame(0x21, b"OK");
        assert_eq!(c.push(&f), Collect::Frame);
        assert_eq!(c.bytes(), f);
    }

    #[test]
    fn a_bare_nak_is_returned_at_once_so_the_driver_can_resend() {
        let mut c = IslCollector::new(0x21);
        assert_eq!(c.push(&[NAK]), Collect::Nak);
        assert_eq!(c.bytes(), vec![NAK]);
    }

    #[test]
    fn a_result_is_final_and_repeated_pushes_do_not_change_it() {
        let f = frame(0x21, b"OK");
        let mut c = IslCollector::new(0x21);
        assert_eq!(c.push(&f), Collect::Frame);
        // A device that keeps talking must not overwrite the answer already collected.
        assert_eq!(c.push(&frame(0x21, b"LATER")), Collect::Frame);
        assert_eq!(c.bytes(), f);
    }

    #[test]
    fn a_malformed_frame_is_discarded_rather_than_returned() {
        // Right SEQ, but too short to be an answer and with no postamble where one belongs.
        let mut c = IslCollector::new(0x21);
        assert_eq!(c.push(&[PREAMBLE, 0x20, 0x21, 0x4a, TERMINATOR]), Collect::More);
        let f = frame(0x21, b"OK");
        assert_eq!(c.push(&f), Collect::Frame);
        assert_eq!(c.bytes(), f);
    }

    #[test]
    fn noise_before_the_frame_is_skipped() {
        let f = frame(0x21, b"OK");
        let mut c = IslCollector::new(0x21);
        let mut stream = vec![0x00, 0xff, SYN];
        stream.extend_from_slice(&f);
        assert_eq!(c.push(&stream), Collect::Frame);
        assert_eq!(c.bytes(), f, "the answer, without the rubbish that preceded it");
    }

    #[test]
    fn an_incomplete_frame_keeps_only_itself_in_the_buffer() {
        // Otherwise a noisy line grows the buffer without bound across a long print.
        let mut c = IslCollector::new(0x21);
        assert_eq!(c.push(&[0x00; 64]), Collect::More);
        assert_eq!(c.push(&[PREAMBLE, 0x20, 0x21]), Collect::More);
        assert_eq!(c.bytes().len(), 3, "the leading noise was dropped");
    }

    #[test]
    fn seq_zero_is_a_real_seq() {
        // An off-by-one that treats 0 as "unset" would answer the wrong command exactly once per
        // SEQ wrap, which is the sort of thing that shows up as one bad receipt a month.
        let f = frame(0x00, b"OK");
        let mut c = IslCollector::new(0x00);
        assert_eq!(c.push(&f), Collect::Frame);
    }

    #[test]
    fn the_heuristic_stops_at_the_datecs_terminator() {
        let mut c = HeuristicCollector::new();
        assert_eq!(c.push(&[0x01, 0x30, 0x31]), Collect::More);
        assert_eq!(c.push(&[0x32, TERMINATOR]), Collect::Frame);
        assert_eq!(c.bytes(), vec![0x01, 0x30, 0x31, 0x32, TERMINATOR]);
    }

    #[test]
    fn the_heuristic_stops_at_the_tremol_terminator() {
        let mut c = HeuristicCollector::new();
        assert_eq!(c.push(&[0x02, 0x41, ETX_TREMOL]), Collect::Frame);
    }

    #[test]
    fn the_heuristic_returns_a_lone_nak_immediately() {
        let mut c = HeuristicCollector::new();
        assert_eq!(c.push(&[NAK]), Collect::Nak);
        assert_eq!(c.bytes(), vec![NAK]);
    }

    #[test]
    fn a_nak_byte_inside_a_payload_is_not_a_rejection() {
        // ⚠ Only a NAK that is the WHOLE first read is a rejection. 0x15 is a perfectly ordinary
        // data byte, and treating it as a refusal mid-answer would abort a valid receipt.
        let mut c = HeuristicCollector::new();
        assert_eq!(c.push(&[0x01, NAK, 0x32]), Collect::More);
        assert_eq!(c.push(&[TERMINATOR]), Collect::Frame);
        assert_eq!(c.bytes().len(), 4);
    }
}
