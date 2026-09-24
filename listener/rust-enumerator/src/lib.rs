use std::collections::{HashMap, HashSet, VecDeque};
use std::mem::size_of;
use std::ops::Range;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use napi::{bindgen_prelude::BigInt, Env, Error, JsFunction, Result};
use napi_derive::napi;
use num_bigint::BigUint;
use num_integer::Integer;

const NONE: u32 = u32::MAX;
const CHUNK: usize = 65_536;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const CYCLE_BATCH_SIZE: usize = 16;
const CYCLE_BATCH_BYTES: usize = 64 * 1024;
const SCRATCH_ERROR: &str = "blockscan Rust enumeration scratch memory limit exceeded";
const CANCELLED_ERROR: &str = "blockscan Rust parallel enumeration cancelled";

#[napi(object)]
pub struct QuoteValue {
    pub num: BigInt,
    pub den: BigInt,
}

#[napi(object)]
pub struct DfsQuote {
    pub id: String,
    pub instance: String,
    pub token_in: String,
    pub token_out: String,
    pub num: BigInt,
    pub den: BigInt,
    pub value: Option<QuoteValue>,
}

#[napi(object)]
pub struct DirectedPriceSignal {
    pub token: String,
    pub buy: String,
    pub sell: String,
    pub num: BigInt,
    pub den: BigInt,
}

#[napi(object)]
pub struct EnumerationInput {
    pub quotes: Vec<DfsQuote>,
    pub signals: Vec<DirectedPriceSignal>,
    pub funding: Vec<String>,
    pub min_spread_bps: f64,
    pub max_hops: f64,
    pub allow_repeated_pools: bool,
    pub prefix_pruning_enabled: bool,
    pub max_prefix_drawdown_bps: f64,
    pub deadline_at_ms: f64,
    pub traversal: String,
    pub threads: u32,
    pub memory_limit_bytes: f64,
}

#[derive(Clone, Debug, PartialEq)]
#[napi(object)]
pub struct EnumerationStats {
    pub expanded: f64,
    pub completed_signal_tokens: f64,
    pub deadline_hit: bool,
    pub closed: f64,
    pub half_paths: f64,
    pub joins: f64,
    pub signal_matched: f64,
    pub indexed_join_comparisons: f64,
    pub join_skipped_before_conflicts: f64,
    pub gate_rule: String,
    pub prefix_pruning_enabled: bool,
    pub max_prefix_drawdown_bps: f64,
    pub prefix_pruned_forward: f64,
    pub prefix_pruned_join: f64,
    pub prefix_pruned_total: f64,
    pub traversal: String,
    pub phase: String,
}

impl EnumerationStats {
    fn new(input: &EnumerationInput) -> Self {
        Self {
            expanded: 0.0,
            completed_signal_tokens: 0.0,
            deadline_hit: false,
            closed: 0.0,
            half_paths: 0.0,
            joins: 0.0,
            signal_matched: 0.0,
            indexed_join_comparisons: 0.0,
            join_skipped_before_conflicts: 0.0,
            gate_rule: "signal-rooted-sorted-profitable-join".into(),
            prefix_pruning_enabled: input.prefix_pruning_enabled,
            max_prefix_drawdown_bps: input.max_prefix_drawdown_bps,
            prefix_pruned_forward: 0.0,
            prefix_pruned_join: 0.0,
            prefix_pruned_total: 0.0,
            traversal: input.traversal.clone(),
            phase: "prepare".into(),
        }
    }

    fn add_work(&mut self, other: &Self) {
        self.expanded += other.expanded;
        self.half_paths += other.half_paths;
        self.joins += other.joins;
        self.signal_matched += other.signal_matched;
        self.indexed_join_comparisons += other.indexed_join_comparisons;
        self.join_skipped_before_conflicts += other.join_skipped_before_conflicts;
        self.prefix_pruned_forward += other.prefix_pruned_forward;
        self.prefix_pruned_join += other.prefix_pruned_join;
        self.prefix_pruned_total += other.prefix_pruned_total;
    }
}

/// One non-blocking quota per invocation. Shared indexes and JavaScript/N-API
/// storage remain outside this scratch budget and need the caller's RSS guard.
struct ScratchBudget {
    used: AtomicUsize,
    limit: usize,
}

struct ScratchLease {
    budget: Arc<ScratchBudget>,
    bytes: usize,
}

impl ScratchBudget {
    fn reserve(self: &Arc<Self>, bytes: usize) -> Result<ScratchLease> {
        let mut lease = ScratchLease {
            budget: Arc::clone(self),
            bytes: 0,
        };
        lease.grow(bytes)?;
        Ok(lease)
    }
}

impl ScratchLease {
    fn grow(&mut self, bytes: usize) -> Result<()> {
        self.budget
            .used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes)
                    .filter(|next| *next <= self.budget.limit)
            })
            .map_err(|_| Error::from_reason(SCRATCH_ERROR))?;
        self.bytes += bytes;
        Ok(())
    }
}

impl Drop for ScratchLease {
    fn drop(&mut self) {
        self.budget.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

fn integer_bytes(bits: u64) -> usize {
    // Include spare limb capacity; num-bigint multiplication owns temporaries.
    (bits as usize)
        .div_ceil(64)
        .saturating_add(1)
        .saturating_mul(16)
}

fn route_key_bytes(length: usize) -> usize {
    // Hash table growth, key Vec capacity and allocator metadata.
    2 * (size_of::<Vec<usize>>() + length * size_of::<usize>()) + 128
}

#[derive(Clone)]
struct Rate {
    n: BigUint,
    d: BigUint,
}

impl Rate {
    fn one() -> Self {
        Self {
            n: 1u32.into(),
            d: 1u32.into(),
        }
    }

    fn reduced(self) -> Self {
        let common = self.n.gcd(&self.d);
        Self {
            n: self.n / &common,
            d: self.d / common,
        }
    }
}

struct IndexedQuote {
    from: usize,
    to: usize,
    pool: usize,
    token_in: String,
    token_out: String,
    rate: Rate,
    value: Option<Rate>,
}

struct Anchor {
    token: usize,
    buys: HashSet<usize>,
    sells: HashSet<usize>,
}

/// The same chunked, prepend-linked storage as the TypeScript reference.
struct HalfLayer {
    head: Vec<u32>,
    chunks: Vec<Vec<u32>>,
    count: usize,
    hops: usize,
    memory: ScratchLease,
}

impl HalfLayer {
    fn new(tokens: usize, hops: usize, memory: &Arc<ScratchBudget>) -> Result<Self> {
        let lease = memory.reserve(tokens * size_of::<u32>() + size_of::<Self>() + 128)?;
        Ok(Self {
            head: vec![NONE; tokens],
            chunks: Vec::new(),
            count: 0,
            hops,
            memory: lease,
        })
    }

    fn add(&mut self, token: usize, path: &[usize]) -> Result<()> {
        let index = self.count;
        self.count += 1;
        if index >= NONE as usize {
            return Err(Error::from_reason("paired path index capacity exceeded"));
        }
        let stride = self.hops + 1;
        let chunk = index / CHUNK;
        let offset = (index % CHUNK) * stride;
        if chunk == self.chunks.len() {
            self.memory
                .grow(CHUNK * stride * size_of::<u32>() + 2 * size_of::<Vec<u32>>() + 128)?;
            self.chunks.push(vec![0; CHUNK * stride]);
        }
        let values = &mut self.chunks[chunk];
        for i in 0..self.hops {
            values[offset + i] = path[i] as u32;
        }
        values[offset + self.hops] = self.head[token];
        self.head[token] = index as u32;
        Ok(())
    }

    fn read(&self, index: u32, path: &mut Vec<usize>) -> u32 {
        let index = index as usize;
        let values = &self.chunks[index / CHUNK];
        let offset = (index % CHUNK) * (self.hops + 1);
        path.resize(self.hops, 0);
        for i in 0..self.hops {
            path[i] = values[offset + i] as usize;
        }
        values[offset + self.hops]
    }
}

struct SortedHalf {
    index: u32,
    rate: Rate,
    min_prefix: Option<Rate>,
}

#[derive(Clone)]
struct Enumerator {
    edges: Arc<Vec<IndexedQuote>>,
    outgoing: Arc<Vec<Vec<usize>>>,
    incoming: Arc<Vec<Vec<usize>>>,
    partners: Arc<Vec<HashSet<usize>>>,
    anchors: Arc<Vec<Anchor>>,
    funding: Arc<HashSet<String>>,
    max_half: usize,
    max_hops: usize,
    threshold: BigUint,
    prefix_floor: u32,
    allow_repeated_pools: bool,
    prefix_pruning_enabled: bool,
    deadline_at_ms: f64,
    stats: EnumerationStats,
    memory: Arc<ScratchBudget>,
    cancelled: Option<Arc<AtomicBool>>,
}

fn positive(value: &BigInt, message: &'static str) -> Result<BigUint> {
    if value.sign_bit || value.words.iter().all(|word| *word == 0) {
        return Err(Error::from_reason(message));
    }
    Ok(BigUint::new(
        value
            .words
            .iter()
            .flat_map(|word| [*word as u32, (word >> 32) as u32])
            .collect(),
    ))
}

fn intern(map: &mut HashMap<String, usize>, key: &str) -> usize {
    if let Some(id) = map.get(key) {
        return *id;
    }
    let id = map.len();
    map.insert(key.to_owned(), id);
    id
}

fn expired(stats: &mut EnumerationStats, deadline_at_ms: f64) -> bool {
    if !stats.deadline_hit {
        stats.deadline_hit = deadline_expired(deadline_at_ms);
    }
    stats.deadline_hit
}

fn deadline_expired(deadline_at_ms: f64) -> bool {
    let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as f64,
        Err(error) => -(error.duration().as_millis() as f64),
    };
    now >= deadline_at_ms
}

fn above_spread(n: &BigUint, d: &BigUint, threshold: &BigUint) -> bool {
    n * 10_000u32 > d * threshold
}

impl Enumerator {
    fn expired(&mut self) -> bool {
        if self
            .cancelled
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Acquire))
        {
            self.stats.deadline_hit = true;
            return true;
        }
        expired(&mut self.stats, self.deadline_at_ms)
    }

    fn sorted_half_bytes(&self, path: &[usize]) -> usize {
        let mut raw_n = 0u64;
        let mut raw_d = 0u64;
        let mut value_n = 0u64;
        let mut value_d = 0u64;
        for id in path {
            let quote = &self.edges[*id];
            raw_n = raw_n.saturating_add(quote.rate.n.bits());
            raw_d = raw_d.saturating_add(quote.rate.d.bits());
            if self.prefix_pruning_enabled {
                let value = quote.value.as_ref().unwrap();
                value_n = value_n.saturating_add(value.n.bits());
                value_d = value_d.saturating_add(value.d.bits());
            }
        }
        // Product bit lengths cannot exceed the sums above. Charge spare Vec
        // capacity and several products for value-prefix and sort temporaries.
        2 * size_of::<SortedHalf>()
            + 128
            + 4 * (integer_bytes(raw_n)
                + integer_bytes(raw_d)
                + integer_bytes(value_n)
                + integer_bytes(value_d))
    }

    fn rate(&self, path: &[usize], value: bool) -> Rate {
        let mut result = Rate::one();
        for id in path {
            let quote = &self.edges[*id];
            let rate = if value {
                quote.value.as_ref().unwrap()
            } else {
                &quote.rate
            };
            result.n *= &rate.n;
            result.d *= &rate.d;
        }
        result
    }

    fn minimum_value_prefix(&self, path: &[usize]) -> Rate {
        let mut rate = Rate::one();
        let mut minimum = Rate::one();
        for id in path {
            let value = self.edges[*id].value.as_ref().unwrap();
            rate.n *= &value.n;
            rate.d *= &value.d;
            if &rate.n * &minimum.d < &minimum.n * &rate.d {
                minimum = rate.clone();
            }
        }
        minimum
    }

    #[allow(clippy::too_many_arguments)]
    fn extend(
        &mut self,
        anchor: usize,
        reverse: bool,
        seeds: &HashSet<usize>,
        layers: &mut [HalfLayer],
        path: &mut Vec<usize>,
        execution_path: &mut Vec<usize>,
        token: usize,
        recurse: bool,
        prefix: &Rate,
    ) -> Result<()> {
        let count = if reverse {
            self.incoming[token].len()
        } else {
            self.outgoing[token].len()
        };
        for i in 0..count {
            let expanded = self.stats.expanded;
            self.stats.expanded += 1.0;
            if expanded as u64 & 4095 == 0 && self.expired() {
                return Ok(());
            }
            let id = if reverse {
                self.incoming[token][i]
            } else {
                self.outgoing[token][i]
            };
            let edge = &self.edges[id];
            let next = if reverse { edge.from } else { edge.to };
            if path.is_empty() && !seeds.contains(&id) {
                continue;
            }
            if next == anchor {
                continue;
            }
            if path.iter().any(|old_id| {
                let old = &self.edges[*old_id];
                (!self.allow_repeated_pools && old.pool == edge.pool)
                    || old.from == next
                    || old.to == next
            }) {
                continue;
            }
            let next_prefix = if self.prefix_pruning_enabled && !reverse {
                let value = edge.value.as_ref().unwrap();
                let next = Rate {
                    n: &prefix.n * &value.n,
                    d: &prefix.d * &value.d,
                };
                if &next.n * 10_000u32 < &next.d * self.prefix_floor {
                    self.stats.prefix_pruned_forward += 1.0;
                    self.stats.prefix_pruned_total += 1.0;
                    continue;
                }
                Some(next)
            } else {
                None
            };
            path.push(id);
            execution_path.resize(path.len(), 0);
            for j in 0..path.len() {
                execution_path[j] = path[if reverse { path.len() - 1 - j } else { j }];
            }
            layers[path.len() - 1].add(next, execution_path)?;
            self.stats.half_paths += 1.0;
            if recurse && path.len() < self.max_half {
                self.extend(
                    anchor,
                    reverse,
                    seeds,
                    layers,
                    path,
                    execution_path,
                    next,
                    true,
                    next_prefix.as_ref().unwrap_or(prefix),
                )?;
            }
            path.pop();
            if self.stats.deadline_hit {
                return Ok(());
            }
        }
        Ok(())
    }

    fn halves(
        &mut self,
        anchor: usize,
        reverse: bool,
        seeds: &HashSet<usize>,
    ) -> Result<Vec<HalfLayer>> {
        let mut result = (1..=self.max_half)
            .map(|hops| HalfLayer::new(self.outgoing.len(), hops, &self.memory))
            .collect::<Result<Vec<_>>>()?;
        let mut path = Vec::new();
        let mut execution_path = Vec::new();
        self.stats.phase = if reverse { "reverse" } else { "forward" }.into();
        if self.stats.traversal == "dfs" {
            self.extend(
                anchor,
                reverse,
                seeds,
                &mut result,
                &mut path,
                &mut execution_path,
                anchor,
                true,
                &Rate::one(),
            )?;
        } else {
            for hops in 1..=self.max_half {
                if self.stats.deadline_hit {
                    break;
                }
                if hops == 1 {
                    self.extend(
                        anchor,
                        reverse,
                        seeds,
                        &mut result,
                        &mut path,
                        &mut execution_path,
                        anchor,
                        false,
                        &Rate::one(),
                    )?;
                } else {
                    let count = result[hops - 2].count;
                    for pi in 0..count {
                        if pi & 4095 == 0 && self.expired() {
                            break;
                        }
                        result[hops - 2].read(pi as u32, &mut path);
                        if reverse {
                            path.reverse();
                        }
                        let last = &self.edges[*path.last().unwrap()];
                        let endpoint = if reverse { last.from } else { last.to };
                        let prefix = if self.prefix_pruning_enabled && !reverse {
                            self.rate(&path, true)
                        } else {
                            Rate::one()
                        };
                        self.extend(
                            anchor,
                            reverse,
                            seeds,
                            &mut result,
                            &mut path,
                            &mut execution_path,
                            endpoint,
                            false,
                            &prefix,
                        )?;
                        if self.stats.deadline_hit {
                            break;
                        }
                    }
                }
            }
        }
        Ok(result)
    }

    fn run<F>(&mut self, anchor_range: Range<usize>, emit: &mut F) -> Result<()>
    where
        F: FnMut(&[usize], &BigUint, &BigUint) -> Result<()>,
    {
        if self.funding.is_empty() {
            return Ok(());
        }
        let mut emitted_memory = self.memory.reserve(0)?;
        let mut emitted = HashSet::<Vec<usize>>::new();
        for anchor_index in anchor_range {
            if self.expired() {
                break;
            }
            let anchor = self.anchors[anchor_index].token;
            let sells = self.anchors[anchor_index].sells.clone();
            let forward = self.halves(anchor, false, &sells)?;
            let reverse = if self.stats.deadline_hit {
                Vec::new()
            } else {
                let buys = self.anchors[anchor_index].buys.clone();
                self.halves(anchor, true, &buys)?
            };
            if self.stats.deadline_hit {
                break;
            }
            self.stats.phase = "join".into();
            let mut p = Vec::new();
            let mut q = Vec::new();
            'outer: for b in &reverse {
                for token in 0..self.outgoing.len() {
                    if token & 4095 == 0 && self.expired() {
                        break 'outer;
                    }
                    if b.head[token] == NONE {
                        continue;
                    }
                    let mut sorted_memory = self.memory.reserve(0)?;
                    let mut sorted = Vec::new();
                    let mut qi = b.head[token];
                    while qi != NONE {
                        if sorted.len() & 4095 == 0 && self.expired() {
                            break 'outer;
                        }
                        let index = qi;
                        qi = b.read(qi, &mut q);
                        sorted_memory.grow(self.sorted_half_bytes(&q))?;
                        sorted.push(SortedHalf {
                            index,
                            rate: self.rate(&q, false),
                            min_prefix: if self.prefix_pruning_enabled {
                                Some(self.minimum_value_prefix(&q))
                            } else {
                                None
                            },
                        });
                    }
                    sorted.sort_by(|x, y| {
                        (&x.rate.n * &y.rate.d)
                            .cmp(&(&y.rate.n * &x.rate.d))
                            .then(x.index.cmp(&y.index))
                    });
                    if self.expired() {
                        break 'outer;
                    }
                    for a in &forward {
                        if a.hops + b.hops > self.max_hops {
                            continue;
                        }
                        if a.hops != (a.hops + b.hops).saturating_sub(self.max_half).max(1) {
                            continue;
                        }
                        let mut pi = a.head[token];
                        while pi != NONE {
                            if self.expired() {
                                break 'outer;
                            }
                            pi = a.read(pi, &mut p);
                            let ar = self.rate(&p, false);
                            let forward_value = if self.prefix_pruning_enabled {
                                Some(self.rate(&p, true))
                            } else {
                                None
                            };
                            let (mut low, mut high) = (0, sorted.len());
                            while low < high {
                                let mid = (low + high) / 2;
                                let br = &sorted[mid];
                                self.stats.indexed_join_comparisons += 1.0;
                                if above_spread(
                                    &(&ar.n * &br.rate.n),
                                    &(&ar.d * &br.rate.d),
                                    &self.threshold,
                                ) {
                                    high = mid;
                                } else {
                                    low = mid + 1;
                                }
                            }
                            self.stats.join_skipped_before_conflicts += low as f64;
                            for br in &sorted[low..] {
                                b.read(br.index, &mut q);
                                let joins = self.stats.joins;
                                self.stats.joins += 1.0;
                                if joins as u64 & 4095 == 0 && self.expired() {
                                    break 'outer;
                                }
                                if !self.partners[p[0]].contains(q.last().unwrap()) {
                                    continue;
                                }
                                self.stats.signal_matched += 1.0;
                                if let Some(value) = &forward_value {
                                    let minimum = br.min_prefix.as_ref().unwrap();
                                    if &value.n * &minimum.n * 10_000u32
                                        < &value.d * &minimum.d * self.prefix_floor
                                    {
                                        self.stats.prefix_pruned_join += 1.0;
                                        self.stats.prefix_pruned_total += 1.0;
                                        continue;
                                    }
                                }
                                let conflict = p.iter().any(|p_id| {
                                    let left = &self.edges[*p_id];
                                    q.iter().any(|q_id| {
                                        let right = &self.edges[*q_id];
                                        left.from == right.from
                                            || (!self.allow_repeated_pools
                                                && left.pool == right.pool)
                                    })
                                });
                                if conflict {
                                    continue;
                                }
                                let path = p.iter().chain(q.iter()).copied().collect::<Vec<_>>();
                                let n = &ar.n * &br.rate.n;
                                let d = &ar.d * &br.rate.d;
                                for start in 0..path.len() {
                                    if !self.funding.contains(&self.edges[path[start]].token_in) {
                                        continue;
                                    }
                                    let rotated = (0..path.len())
                                        .map(|offset| path[(start + offset) % path.len()])
                                        .collect::<Vec<_>>();
                                    if emitted.contains(&rotated) {
                                        continue;
                                    }
                                    emitted_memory.grow(route_key_bytes(rotated.len()))?;
                                    emitted.insert(rotated.clone());
                                    self.stats.closed += 1.0;
                                    emit(&rotated, &n, &d)?;
                                }
                            }
                        }
                    }
                }
            }
            if self.stats.deadline_hit {
                break;
            }
            self.stats.completed_signal_tokens += 1.0;
        }
        self.expired();
        self.stats.phase = if self.stats.deadline_hit {
            "interrupted"
        } else {
            "complete"
        }
        .into();
        Ok(())
    }
}

struct Cycle {
    path: Vec<usize>,
    n: BigUint,
    d: BigUint,
    _memory: ScratchLease,
}

enum WorkerStatus {
    Complete,
    Cancelled,
    Failed(String),
}

struct WorkerOutcome {
    stats: EnumerationStats,
    status: WorkerStatus,
}

struct Worker {
    receiver: Option<Receiver<Vec<Cycle>>>,
    handle: Option<JoinHandle<WorkerOutcome>>,
    cancelled: Arc<AtomicBool>,
}

impl Worker {
    fn finish(&mut self) -> std::result::Result<WorkerOutcome, String> {
        self.receiver.take();
        self.handle
            .take()
            .unwrap()
            .join()
            .map_err(|_| "blockscan Rust enumeration worker panicked".to_owned())
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        // Also cover unwinding: no worker may outlive its synchronous caller.
        if let Some(handle) = self.handle.take() {
            self.cancelled.store(true, Ordering::Release);
            self.receiver.take();
            let _ = handle.join();
        }
    }
}

fn send_batch(
    sender: &SyncSender<Vec<Cycle>>,
    mut batch: Vec<Cycle>,
    deadline: f64,
    cancelled: &AtomicBool,
) -> bool {
    loop {
        if cancelled.load(Ordering::Acquire) || deadline_expired(deadline) {
            return false;
        }
        match sender.try_send(batch) {
            Ok(()) => return true,
            Err(TrySendError::Disconnected(_)) => return false,
            Err(TrySendError::Full(returned)) => batch = returned,
        }
        // Never wait indefinitely on a later anchor's full queue.
        thread::sleep(Duration::from_millis(1));
    }
}

fn spawn_worker(
    template: &Enumerator,
    anchor: usize,
    cancelled: &Arc<AtomicBool>,
) -> Result<Worker> {
    let mut engine = template.clone();
    engine.cancelled = Some(Arc::clone(cancelled));
    let cancelled_worker = Arc::clone(cancelled);
    let memory = Arc::clone(&engine.memory);
    let deadline = engine.deadline_at_ms;
    let (sender, receiver) = mpsc::sync_channel(1);
    let handle = thread::Builder::new()
        .name(format!("blockscan-anchor-{anchor}"))
        .spawn(move || {
            let mut batch = Vec::new();
            let mut batch_bytes = 0usize;
            let mut send_cancelled = false;
            let result = engine.run(anchor..anchor + 1, &mut |path, n, d| {
                if cancelled_worker.load(Ordering::Acquire) || deadline_expired(deadline) {
                    send_cancelled = true;
                    return Err(Error::from_reason(CANCELLED_ERROR));
                }
                let bytes = 2 * size_of::<Cycle>()
                    + route_key_bytes(path.len())
                    + integer_bytes(n.bits())
                    + integer_bytes(d.bits())
                    + 128;
                if !batch.is_empty() && batch_bytes.saturating_add(bytes) > CYCLE_BATCH_BYTES {
                    if !send_batch(
                        &sender,
                        std::mem::take(&mut batch),
                        deadline,
                        &cancelled_worker,
                    ) {
                        send_cancelled = true;
                        return Err(Error::from_reason(CANCELLED_ERROR));
                    }
                    batch_bytes = 0;
                }
                let lease = memory.reserve(bytes)?;
                batch.push(Cycle {
                    path: path.to_vec(),
                    n: n.clone(),
                    d: d.clone(),
                    _memory: lease,
                });
                batch_bytes += bytes;
                if batch.len() == CYCLE_BATCH_SIZE || batch_bytes >= CYCLE_BATCH_BYTES {
                    if !send_batch(
                        &sender,
                        std::mem::take(&mut batch),
                        deadline,
                        &cancelled_worker,
                    ) {
                        send_cancelled = true;
                        return Err(Error::from_reason(CANCELLED_ERROR));
                    }
                    batch_bytes = 0;
                }
                Ok(())
            });
            let status = match result {
                Err(error) if !send_cancelled => {
                    cancelled_worker.store(true, Ordering::Release);
                    WorkerStatus::Failed(error.reason)
                }
                _ if send_cancelled
                    || engine.stats.deadline_hit
                    || cancelled_worker.load(Ordering::Acquire) =>
                {
                    WorkerStatus::Cancelled
                }
                _ => {
                    if batch.is_empty() || send_batch(&sender, batch, deadline, &cancelled_worker) {
                        WorkerStatus::Complete
                    } else {
                        WorkerStatus::Cancelled
                    }
                }
            };
            WorkerOutcome {
                stats: engine.stats,
                status,
            }
        })
        .map_err(|error| {
            Error::from_reason(format!(
                "blockscan Rust enumeration worker spawn failed: {error}"
            ))
        })?;
    Ok(Worker {
        receiver: Some(receiver),
        handle: Some(handle),
        cancelled: Arc::clone(cancelled),
    })
}

impl Enumerator {
    fn run_parallel<F>(&mut self, threads: usize, emit: &mut F) -> Result<()>
    where
        F: FnMut(&[usize], &BigUint, &BigUint) -> Result<()>,
    {
        if self.funding.is_empty() {
            return Ok(());
        }
        let template = self.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut workers = VecDeque::<Worker>::new();
        let mut next_anchor = 0usize;
        let mut error = None;
        let mut timed_out = false;
        let mut emitted_memory = self.memory.reserve(0)?;
        let mut emitted = HashSet::<Vec<usize>>::new();
        while next_anchor < self.anchors.len() && workers.len() < threads {
            match spawn_worker(&template, next_anchor, &cancelled) {
                Ok(worker) => {
                    workers.push_back(worker);
                    next_anchor += 1;
                }
                Err(failure) => {
                    error = Some(failure);
                    break;
                }
            }
        }
        'drain: while error.is_none() && !workers.is_empty() {
            if deadline_expired(self.deadline_at_ms) {
                timed_out = true;
                break;
            }
            if cancelled.load(Ordering::Acquire) {
                break;
            }
            let received = workers
                .front()
                .unwrap()
                .receiver
                .as_ref()
                .unwrap()
                .recv_timeout(Duration::from_millis(2));
            match received {
                Ok(batch) => {
                    for cycle in batch {
                        if deadline_expired(self.deadline_at_ms) {
                            timed_out = true;
                            break 'drain;
                        }
                        if cancelled.load(Ordering::Acquire) {
                            break 'drain;
                        }
                        if emitted.contains(&cycle.path) {
                            continue;
                        }
                        if let Err(failure) = emitted_memory.grow(route_key_bytes(cycle.path.len()))
                        {
                            error = Some(failure);
                            break 'drain;
                        }
                        emitted.insert(cycle.path.clone());
                        self.stats.closed += 1.0;
                        if let Err(failure) = emit(&cycle.path, &cycle.n, &cycle.d) {
                            // Preserve the original N-API exception across cleanup.
                            error = Some(failure);
                            break 'drain;
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    let mut worker = workers.pop_front().unwrap();
                    match worker.finish() {
                        Ok(outcome) => {
                            self.stats.add_work(&outcome.stats);
                            match outcome.status {
                                WorkerStatus::Complete => self.stats.completed_signal_tokens += 1.0,
                                WorkerStatus::Cancelled => {
                                    timed_out |= deadline_expired(self.deadline_at_ms);
                                    break;
                                }
                                WorkerStatus::Failed(reason) => {
                                    error = Some(Error::from_reason(reason));
                                    break;
                                }
                            }
                        }
                        Err(reason) => {
                            error = Some(Error::from_reason(reason));
                            break;
                        }
                    }
                    if next_anchor < self.anchors.len() {
                        match spawn_worker(&template, next_anchor, &cancelled) {
                            Ok(worker) => {
                                workers.push_back(worker);
                                next_anchor += 1;
                            }
                            Err(failure) => {
                                error = Some(failure);
                                break;
                            }
                        }
                    }
                }
            }
        }
        cancelled.store(true, Ordering::Release);
        // Disconnect every queue before joining any producer, including later
        // anchors blocked behind the ordered consumer.
        for worker in &mut workers {
            worker.receiver.take();
        }
        for mut worker in workers {
            match worker.finish() {
                Ok(outcome) => {
                    self.stats.add_work(&outcome.stats);
                    if let WorkerStatus::Failed(reason) = outcome.status {
                        if error.is_none() {
                            error = Some(Error::from_reason(reason));
                        }
                    }
                }
                Err(reason) => {
                    if error.is_none() {
                        error = Some(Error::from_reason(reason));
                    }
                }
            }
        }
        if let Some(error) = error {
            return Err(error);
        }
        timed_out |= deadline_expired(self.deadline_at_ms);
        if !timed_out && self.stats.completed_signal_tokens != self.anchors.len() as f64 {
            return Err(Error::from_reason(CANCELLED_ERROR));
        }
        self.stats.deadline_hit = timed_out;
        self.stats.phase = if timed_out { "interrupted" } else { "complete" }.into();
        Ok(())
    }
}

fn enumerate_inner<F>(input: EnumerationInput, mut emit: F) -> Result<EnumerationStats>
where
    F: FnMut(&[usize], &BigUint, &BigUint) -> Result<()>,
{
    let safe_integer =
        |value: f64| value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER;
    if !safe_integer(input.min_spread_bps)
        || input.min_spread_bps < 0.0
        || !safe_integer(input.max_hops)
        || input.max_hops < 2.0
    {
        return Err(Error::from_reason(
            "paired enumeration requires integer spread bps and maxHops >= 2",
        ));
    }
    if !safe_integer(input.max_prefix_drawdown_bps)
        || input.max_prefix_drawdown_bps < 0.0
        || input.max_prefix_drawdown_bps > 10_000.0
    {
        return Err(Error::from_reason(
            "maxPrefixDrawdownBps must be a safe integer from 0 to 10000",
        ));
    }
    if input.traversal != "dfs" && input.traversal != "layered" {
        return Err(Error::from_reason(
            "SEARCHER_BLOCKSCAN_ENUMERATION_METHOD must be dfs or layered",
        ));
    }
    if !(1..=8).contains(&input.threads) {
        return Err(Error::from_reason(
            "Rust enumeration threads must be an integer from 1 to 8",
        ));
    }
    if !safe_integer(input.memory_limit_bytes)
        || !(1.0..=2_147_483_648.0).contains(&input.memory_limit_bytes)
    {
        return Err(Error::from_reason(
            "Rust enumeration memoryLimitBytes must be an integer from 1 to 2147483648",
        ));
    }
    let mut stats = EnumerationStats::new(&input);
    if expired(&mut stats, input.deadline_at_ms) {
        return Ok(stats);
    }
    let mut tokens = HashMap::new();
    let mut pools = HashMap::new();
    let mut by_id = HashMap::new();
    let mut edges = Vec::new();
    for quote in input.quotes {
        if by_id.contains_key(&quote.id) {
            return Err(Error::from_reason("duplicate directed quote id"));
        }
        let rate = Rate {
            n: positive(&quote.num, "invalid directed quote amount")?,
            d: positive(&quote.den, "invalid directed quote amount")?,
        };
        by_id.insert(quote.id, edges.len());
        let value = quote
            .value
            .map(|value| -> Result<Rate> {
                let rate = Rate {
                    n: positive(&value.num, "invalid quote value")?,
                    d: positive(&value.den, "invalid quote value")?,
                };
                // Reference values only feed exact prefix comparisons. Reduce
                // once at ingestion; raw quote/callback products stay untouched.
                Ok(if input.prefix_pruning_enabled {
                    rate.reduced()
                } else {
                    rate
                })
            })
            .transpose()?;
        edges.push(IndexedQuote {
            from: intern(&mut tokens, &quote.token_in),
            to: intern(&mut tokens, &quote.token_out),
            pool: intern(&mut pools, &quote.instance),
            token_in: quote.token_in,
            token_out: quote.token_out,
            rate,
            value,
        });
    }
    let mut outgoing = vec![Vec::new(); tokens.len()];
    let mut incoming = vec![Vec::new(); tokens.len()];
    for (id, edge) in edges.iter().enumerate() {
        if edge.value.is_none() {
            continue;
        }
        outgoing[edge.from].push(id);
        incoming[edge.to].push(id);
    }
    let mut partners = (0..edges.len()).map(|_| HashSet::new()).collect::<Vec<_>>();
    let mut anchors = Vec::<Anchor>::new();
    let mut anchor_index = HashMap::new();
    let mut pair_count = 0usize;
    // Match BigInt(10_000 + bps), including JavaScript's Number addition.
    let threshold = BigUint::from((10_000.0 + input.min_spread_bps) as u64);
    for signal in input.signals {
        let (Some(&b), Some(&s)) = (by_id.get(&signal.buy), by_id.get(&signal.sell)) else {
            continue;
        };
        let (buy, sell) = (&edges[b], &edges[s]);
        if buy.token_out != signal.token
            || sell.token_in != signal.token
            || (!input.allow_repeated_pools && buy.pool == sell.pool)
        {
            return Err(Error::from_reason("invalid directed price signal"));
        }
        let den = positive(&signal.den, "invalid directed price signal")?;
        let num = positive(&signal.num, "invalid directed price signal")?;
        if !above_spread(&num, &den, &threshold) {
            continue;
        }
        if !input.prefix_pruning_enabled {
            partners[b].insert(s);
        }
        partners[s].insert(b);
        pair_count += 1;
        let index = *anchor_index.entry(sell.from).or_insert_with(|| {
            let index = anchors.len();
            anchors.push(Anchor {
                token: sell.from,
                buys: HashSet::new(),
                sells: HashSet::new(),
            });
            index
        });
        anchors[index].buys.insert(b);
        anchors[index].sells.insert(s);
    }
    if expired(&mut stats, input.deadline_at_ms) || pair_count == 0 {
        return Ok(stats);
    }
    let max_hops = input.max_hops as usize;
    let max_half = ((max_hops + 1) / 2).min(tokens.len().saturating_sub(1));
    let mut engine = Enumerator {
        edges: Arc::new(edges),
        outgoing: Arc::new(outgoing),
        incoming: Arc::new(incoming),
        partners: Arc::new(partners),
        anchors: Arc::new(anchors),
        funding: Arc::new(input.funding.into_iter().collect()),
        max_half,
        max_hops,
        threshold,
        prefix_floor: if input.prefix_pruning_enabled {
            (10_000.0 - input.max_prefix_drawdown_bps) as u32
        } else {
            0
        },
        allow_repeated_pools: input.allow_repeated_pools,
        prefix_pruning_enabled: input.prefix_pruning_enabled,
        deadline_at_ms: input.deadline_at_ms,
        stats,
        memory: Arc::new(ScratchBudget {
            used: AtomicUsize::new(0),
            limit: input.memory_limit_bytes as usize,
        }),
        cancelled: None,
    };
    if input.threads == 1 {
        engine.run(0..engine.anchors.len(), &mut emit)?;
    } else {
        engine.run_parallel(input.threads as usize, &mut emit)?;
    }
    Ok(engine.stats)
}

#[napi]
pub fn enumerate(
    env: Env,
    input: EnumerationInput,
    on_cycle: JsFunction,
) -> Result<EnumerationStats> {
    enumerate_inner(input, |indices, n, d| {
        // Only completed cycles cross N-API. The callback is synchronous and
        // consumes the same deadline as search; each call has a bounded scope.
        env.run_in_scope(|| {
            let mut path = env.create_array_with_length(indices.len())?;
            for (offset, index) in indices.iter().enumerate() {
                path.set_element(offset as u32, env.create_uint32(*index as u32)?)?;
            }
            let num = env.create_bigint_from_words(false, n.to_u64_digits())?;
            let den = env.create_bigint_from_words(false, d.to_u64_digits())?;
            on_cycle.call(
                None,
                &[
                    path.into_unknown(),
                    num.into_unknown()?,
                    den.into_unknown()?,
                ],
            )?;
            Ok(())
        })
    })
}

#[napi]
pub fn api_version() -> u32 {
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bigint(value: u64) -> BigInt {
        BigInt {
            sign_bit: false,
            words: vec![value],
        }
    }

    fn quote(id: &str, from: &str, to: &str, amount_out: u64) -> DfsQuote {
        DfsQuote {
            id: id.into(),
            instance: id.into(),
            token_in: from.into(),
            token_out: to.into(),
            num: bigint(amount_out),
            den: bigint(100),
            value: Some(QuoteValue {
                num: bigint(1),
                den: bigint(1),
            }),
        }
    }

    fn input(traversal: &str) -> EnumerationInput {
        EnumerationInput {
            quotes: vec![
                quote("sell", "f", "a", 200),
                quote("49", "a", "f", 49),
                quote("50", "a", "f", 50),
                quote("51", "a", "f", 51),
                quote("60", "a", "f", 60),
            ],
            signals: ["49", "50", "51", "60"]
                .iter()
                .map(|buy| DirectedPriceSignal {
                    token: "f".into(),
                    buy: (*buy).into(),
                    sell: "sell".into(),
                    num: bigint(120),
                    den: bigint(100),
                })
                .collect(),
            funding: vec!["f".into(), "a".into()],
            min_spread_bps: 0.0,
            max_hops: 2.0,
            allow_repeated_pools: true,
            prefix_pruning_enabled: false,
            max_prefix_drawdown_bps: 1_000.0,
            deadline_at_ms: f64::INFINITY,
            traversal: traversal.into(),
            threads: 1,
            memory_limit_bytes: 512.0 * 1024.0 * 1024.0,
        }
    }

    #[test]
    fn sorted_join_and_funding_callback_order_match_for_both_traversals() {
        for traversal in ["dfs", "layered"] {
            let mut cycles = Vec::new();
            let stats = enumerate_inner(input(traversal), |path, n, d| {
                assert!(n > d);
                cycles.push(path.to_vec());
                Ok(())
            })
            .unwrap();
            assert_eq!(cycles, vec![vec![0, 3], vec![3, 0], vec![0, 4], vec![4, 0]]);
            assert_eq!(stats.joins, 2.0);
            assert_eq!(stats.join_skipped_before_conflicts, 2.0);
            assert_eq!(stats.closed, 4.0);
            assert_eq!(stats.phase, "complete");
            assert!(!stats.deadline_hit);
        }
    }

    #[test]
    fn zero_drawdown_keeps_exactly_one_and_rejects_below_one() {
        for traversal in ["dfs", "layered"] {
            for (numerator, expected) in [(100, 4.0), (99, 0.0)] {
                let mut input = input(traversal);
                input.prefix_pruning_enabled = true;
                input.max_prefix_drawdown_bps = 0.0;
                input.quotes[0].value = Some(QuoteValue {
                    num: bigint(numerator),
                    den: bigint(100),
                });
                let stats = enumerate_inner(input, |_, _, _| Ok(())).unwrap();
                assert_eq!(stats.closed, expected);
                assert_eq!(
                    stats.prefix_pruned_forward,
                    if numerator == 100 { 0.0 } else { 1.0 }
                );
            }
        }
    }

    #[test]
    fn bigint_admission_does_not_round_away_positive_spread() {
        let huge = BigUint::from(10u32).pow(100);
        assert!(above_spread(
            &(&huge + 1u32),
            &huge,
            &BigUint::from(10_000u32)
        ));
        assert!(!above_spread(&huge, &huge, &BigUint::from(10_000u32)));
        assert_eq!(
            positive(
                &BigInt {
                    sign_bit: false,
                    words: huge.to_u64_digits()
                },
                "invalid"
            )
            .unwrap(),
            huge
        );
    }

    #[test]
    fn reference_reduction_preserves_ratio_and_raw_callback_products() {
        let common = BigUint::from(10u32).pow(100);
        let reduced = Rate {
            n: &common * 99u32,
            d: &common * 100u32,
        }
        .reduced();
        assert_eq!(reduced.n, BigUint::from(99u32));
        assert_eq!(reduced.d, BigUint::from(100u32));
        for traversal in ["dfs", "layered"] {
            let mut input = input(traversal);
            input.prefix_pruning_enabled = true;
            input.max_prefix_drawdown_bps = 0.0;
            for quote in &mut input.quotes {
                let n = positive(&quote.num, "invalid").unwrap() * &common;
                let d = positive(&quote.den, "invalid").unwrap() * &common;
                quote.num = BigInt {
                    sign_bit: false,
                    words: n.to_u64_digits(),
                };
                quote.den = BigInt {
                    sign_bit: false,
                    words: d.to_u64_digits(),
                };
                quote.value = Some(QuoteValue {
                    num: BigInt {
                        sign_bit: false,
                        words: common.to_u64_digits(),
                    },
                    den: BigInt {
                        sign_bit: false,
                        words: common.to_u64_digits(),
                    },
                });
            }
            let mut cycles = Vec::new();
            let stats = enumerate_inner(input, |path, n, d| {
                let buy = if path.contains(&3) { 51u32 } else { 60u32 };
                assert_eq!(*n, &common * &common * 200u32 * buy);
                assert_eq!(*d, &common * &common * 10_000u32);
                cycles.push(path.to_vec());
                Ok(())
            })
            .unwrap();
            assert_eq!(cycles, vec![vec![0, 3], vec![3, 0], vec![0, 4], vec![4, 0]]);
            assert_eq!(stats.joins, 2.0);
            assert_eq!(stats.prefix_pruned_total, 0.0);
        }
    }

    #[test]
    fn expired_input_stays_in_prepare_without_callbacks() {
        let mut input = input("dfs");
        input.deadline_at_ms = 0.0;
        let stats =
            enumerate_inner(input, |_, _, _| panic!("expired input emitted a cycle")).unwrap();
        assert!(stats.deadline_hit);
        assert_eq!(stats.phase, "prepare");
        assert_eq!(stats.expanded, 0.0);
    }

    #[test]
    fn callback_failure_stops_enumeration() {
        let mut calls = 0;
        let result = enumerate_inner(input("dfs"), |_, _, _| {
            calls += 1;
            Err(Error::from_reason("callback failure"))
        });
        assert_eq!(calls, 1);
        assert!(result.is_err());
    }

    fn parallel_input(traversal: &str, threads: u32) -> EnumerationInput {
        let mut value = input(traversal);
        value.threads = threads;
        value.quotes = vec![quote("sell", "f", "a", 200)];
        value.signals.clear();
        for index in 0..64 {
            let id = format!("buy-{index}");
            value.quotes.push(quote(&id, "a", "f", 51 + index % 17));
            value.signals.push(DirectedPriceSignal {
                token: "f".into(),
                buy: id,
                sell: "sell".into(),
                num: bigint(120),
                den: bigint(100),
            });
        }
        for index in 0..64 {
            value.signals.push(DirectedPriceSignal {
                token: "a".into(),
                buy: "sell".into(),
                sell: format!("buy-{index}"),
                num: bigint(120),
                den: bigint(100),
            });
        }
        value
    }

    #[test]
    fn ordered_parallel_results_and_all_complete_stats_match_serial() {
        for traversal in ["dfs", "layered"] {
            let mut expected = Vec::new();
            let expected_stats = enumerate_inner(parallel_input(traversal, 1), |path, n, d| {
                expected.push((path.to_vec(), n.clone(), d.clone()));
                Ok(())
            })
            .unwrap();
            for threads in [2, 4, 8] {
                let mut actual = Vec::new();
                let stats = enumerate_inner(parallel_input(traversal, threads), |path, n, d| {
                    actual.push((path.to_vec(), n.clone(), d.clone()));
                    Ok(())
                })
                .unwrap();
                assert_eq!(actual, expected);
                assert_eq!(stats, expected_stats);
                assert_eq!(stats.completed_signal_tokens, 2.0);
            }
        }
    }

    #[test]
    fn scratch_pressure_is_an_error_before_callbacks_for_every_backend_width() {
        for traversal in ["dfs", "layered"] {
            for threads in [1, 2, 4] {
                let mut input = parallel_input(traversal, threads);
                input.memory_limit_bytes = 1024.0 * 1024.0;
                let mut calls = 0;
                let error = enumerate_inner(input, |_, _, _| {
                    calls += 1;
                    Ok(())
                })
                .unwrap_err();
                assert_eq!(error.reason, SCRATCH_ERROR);
                assert_eq!(calls, 0);
            }
        }
    }

    #[test]
    fn callback_failure_cancels_backpressured_workers_and_allows_a_fresh_call() {
        for threads in [2, 4, 8] {
            let mut calls = 0;
            let error = enumerate_inner(parallel_input("dfs", threads), |_, _, _| {
                calls += 1;
                Err(Error::from_reason("original callback failure"))
            })
            .unwrap_err();
            assert_eq!(error.reason, "original callback failure");
            assert_eq!(calls, 1);
            let stats = enumerate_inner(parallel_input("dfs", threads), |_, _, _| Ok(())).unwrap();
            assert_eq!(stats.phase, "complete");
        }
    }

    #[test]
    fn parallel_callback_time_is_in_the_shared_deadline() {
        for threads in [2, 4] {
            let mut input = parallel_input("dfs", threads);
            input.deadline_at_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as f64
                + 1000.0;
            let mut calls = 0;
            let stats = enumerate_inner(input, |_, _, _| {
                calls += 1;
                thread::sleep(Duration::from_millis(1100));
                Ok(())
            })
            .unwrap();
            assert_eq!(calls, 1);
            assert!(stats.deadline_hit);
            assert_eq!(stats.phase, "interrupted");
            assert_eq!(stats.completed_signal_tokens, 0.0);
        }
    }
}
