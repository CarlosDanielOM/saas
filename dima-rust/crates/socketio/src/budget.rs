//! Counters that bound memory: a reservation takes its share in one step (never a check and
//! then an increment that a concurrent caller can slip between) and gives it back exactly once.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Takes `amount` from a counter bounded by `max`; `false` (and nothing taken) when it does not
/// fit.
pub(crate) fn reserve(counter: &AtomicUsize, amount: usize, max: usize) -> bool {
    counter
        .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            n.checked_add(amount).filter(|total| *total <= max)
        })
        .is_ok()
}

/// Gives back what [`reserve`] took.
pub(crate) fn release(counter: &AtomicUsize, amount: usize) {
    if amount == 0 {
        return;
    }
    let _ = counter.try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
        Some(n.saturating_sub(amount))
    });
}

/// Inbound memory reserved for one received packet: on the server-wide counter and, when it
/// has one, on its socket's (or connection's). Given back when dropped, which happens when the
/// handler has finished with the event (or the acknowledgement's waiter has its answer).
#[derive(Debug)]
pub(crate) struct Charge {
    amount: usize,
    total: Arc<AtomicUsize>,
    own: Option<Arc<AtomicUsize>>,
}

impl Charge {
    /// Reserves `amount` on `own` (bounded by `own_max`) and on `total` (bounded by
    /// `total_max`), both or neither.
    pub fn take(
        amount: usize,
        total: &Arc<AtomicUsize>,
        total_max: usize,
        own: Option<(&Arc<AtomicUsize>, usize)>,
    ) -> Option<Self> {
        if let Some((own, own_max)) = own
            && !reserve(own, amount, own_max)
        {
            return None;
        }
        if !reserve(total, amount, total_max) {
            if let Some((own, _)) = own {
                release(own, amount);
            }
            return None;
        }
        Some(Self {
            amount,
            total: Arc::clone(total),
            own: own.map(|(own, _)| Arc::clone(own)),
        })
    }
}

impl Drop for Charge {
    fn drop(&mut self) {
        release(&self.total, self.amount);
        if let Some(own) = &self.own {
            release(own, self.amount);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_reservations_never_exceed_the_bound() {
        let counter = std::sync::Arc::new(AtomicUsize::new(0));
        let taken = std::sync::Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let counter = std::sync::Arc::clone(&counter);
                let taken = std::sync::Arc::clone(&taken);
                std::thread::spawn(move || {
                    for _ in 0..1000 {
                        if reserve(&counter, 3, 100) {
                            taken.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(taken.load(Ordering::Relaxed), 33);
        assert_eq!(counter.load(Ordering::Relaxed), 99);
        release(&counter, 99);
        release(&counter, 5);
        assert_eq!(counter.load(Ordering::Relaxed), 0);
    }
}
