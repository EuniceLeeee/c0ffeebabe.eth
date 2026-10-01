//! Stderr-only observations. Never echo endpoint, request parameters, response
//! bodies, remote messages, or arbitrary error Display strings.
use std::{collections::BTreeMap, error::Error, io::{self, Write}, time::{SystemTime, UNIX_EPOCH}};
use serde_json::{Value, json};

// The daemon handles requests synchronously on one thread. A fixed, request-local
// accumulator also sees the fresh precheck RpcClient and the reused session's
// client, without changing either client's lifetime counters or source behavior.
#[derive(Clone, Copy)]
pub enum Phase {
    Other, SourcePrecheck, Hydration, TokenDeal, TokenDealInitialProbe,
    TokenDealTrials, TokenDealFallback, TraceHints, PrefixExecution,
    MainReadSetup, EffectsObservations, CanonicalPostcheck,
}
const PHASES: [(Phase, &str); 12] = [
    (Phase::Other, "other"), (Phase::SourcePrecheck, "source-precheck"),
    (Phase::Hydration, "hydration"), (Phase::TokenDeal, "token-deal"),
    (Phase::TokenDealInitialProbe, "token-deal-initial-probe"),
    (Phase::TokenDealTrials, "token-deal-trials"), (Phase::TokenDealFallback, "token-deal-fallback"),
    (Phase::TraceHints, "trace-hints"), (Phase::PrefixExecution, "prefix-execution"),
    (Phase::MainReadSetup, "main-read-setup"), (Phase::EffectsObservations, "effects-observations"),
    (Phase::CanonicalPostcheck, "canonical-postcheck"),
];

#[derive(Clone, Copy, Default)]
struct PhaseMetric { wall: std::time::Duration, rpc_attempts: u64, entries: u64 }
struct StrictTiming {
    active: Phase,
    last: std::time::Instant,
    phases: [PhaseMetric; PHASES.len()],
    progress: Option<Progress>,
}
impl StrictTiming {
    fn close_interval(&mut self) {
        let now = std::time::Instant::now();
        self.phases[self.active as usize].wall += now.duration_since(self.last);
        self.last = now;
    }
}
thread_local! {
    static STRICT_TIMING: std::cell::RefCell<Option<StrictTiming>> = const { std::cell::RefCell::new(None) };
    #[cfg(test)]
    static LAST_STRICT_RECORD: std::cell::RefCell<Option<Value>> = const { std::cell::RefCell::new(None) };
    #[cfg(test)]
    static LAST_PAIR_RECORD: std::cell::RefCell<Option<Value>> = const { std::cell::RefCell::new(None) };
    #[cfg(test)]
    static PROGRESS_RECORDS: std::cell::RefCell<Option<Vec<Value>>> = const { std::cell::RefCell::new(None) };
    #[cfg(test)]
    static PROGRESS_METHOD_SCANS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    #[cfg(test)]
    static PROGRESS_OBSERVER: std::cell::RefCell<Option<std::sync::mpsc::SyncSender<Value>>> = const { std::cell::RefCell::new(None) };
}

pub fn begin_strict(enabled: bool, started: std::time::Instant) {
    STRICT_TIMING.with(|slot| {
        if let Ok(mut slot) = slot.try_borrow_mut() {
            *slot = enabled.then(|| StrictTiming { active: Phase::Other, last: started,
                phases: [PhaseMetric::default(); PHASES.len()], progress: None });
        }
    });
}

pub struct PhaseScope(Option<Phase>);
pub fn phase(next: Phase) -> PhaseScope {
    PhaseScope(STRICT_TIMING.with(|slot| {
        let mut slot = slot.try_borrow_mut().ok()?;
        let timing = slot.as_mut()?;
        timing.close_interval();
        let previous = timing.active;
        timing.active = next;
        timing.phases[next as usize].entries += 1;
        if let Some(progress) = &mut timing.progress {
            progress.record("phase-enter", next, || json!({"previousPhase":PHASES[previous as usize].1}));
        }
        Some(previous)
    }))
}
impl Drop for PhaseScope {
    fn drop(&mut self) {
        if let Some(previous) = self.0 {
            STRICT_TIMING.with(|slot| {
                if let Ok(mut slot) = slot.try_borrow_mut() {
                    if let Some(timing) = slot.as_mut() {
                        timing.close_interval();
                        timing.active = previous;
                        if let Some(progress) = &mut timing.progress {
                            progress.record("phase-resume", previous, || json!({}));
                        }
                    }
                }
            });
        }
    }
}

// Called exactly where send_json increments its physical-attempt counter,
// including failed sends/retries, but not backoff or logical batch items.
pub fn rpc_attempt() {
    STRICT_TIMING.with(|slot| {
        if let Ok(mut slot) = slot.try_borrow_mut() {
            if let Some(timing) = slot.as_mut() { timing.phases[timing.active as usize].rpc_attempts += 1; }
        }
    });
}

// At most 127 ordinary records plus one truncation marker per scalar or pair
// interval. Terminal metrics are separate and never truncated. Missing ends
// (kill, broken sink or truncation) mean censored/unknown, never zero duration.
const PROGRESS_RECORD_CAP: usize = 128;
const PROGRESS_METHOD_CAP: usize = 128;

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressIdentity {
    interval: &'static str,
    request_id: Option<u64>,
    child_request_ids: Option<[u64; 2]>,
    source_block: Option<u64>,
}
struct Progress {
    identity: ProgressIdentity,
    started: std::time::Instant,
    sequence: usize,
    attempts: u64,
}
impl Progress {
    fn record(&mut self, event: &'static str, phase: Phase, fields: impl FnOnce() -> Value) {
        if self.sequence >= PROGRESS_RECORD_CAP { return; }
        self.sequence += 1;
        let truncated = self.sequence == PROGRESS_RECORD_CAP;
        let mut record = if truncated { json!({"recordCap":PROGRESS_RECORD_CAP}) } else { fields() };
        record["event"] = json!(if truncated { "truncated" } else { event });
        record["identity"] = json!(self.identity);
        record["sequence"] = json!(self.sequence);
        record["elapsedMs"] = json!(self.started.elapsed().as_secs_f64() * 1000.0);
        record["phase"] = json!(PHASES[phase as usize].1);
        #[cfg(test)]
        PROGRESS_RECORDS.with(|slot| {
            if let Some(records) = &mut *slot.borrow_mut() {
                // Test capture is also bounded; a pair has three intervals.
                if records.len() < 3 * PROGRESS_RECORD_CAP { records.push(record.clone()); }
            }
        });
        #[cfg(test)]
        PROGRESS_OBSERVER.with(|slot| {
            if let Some(sender) = slot.borrow().as_ref() { let _ = sender.try_send(record.clone()); }
        });
        emit("strict-progress", record);
    }
}

fn bind_progress(identity: ProgressIdentity, started: std::time::Instant) {
    STRICT_TIMING.with(|slot| {
        if let Ok(mut slot) = slot.try_borrow_mut() {
            if let Some(timing) = slot.as_mut() {
                let mut progress = Progress { identity, started, sequence: 0, attempts: 0 };
                progress.record("interval-begin", timing.active, || json!({}));
                timing.progress = Some(progress);
            }
        }
    });
}

pub fn bind_strict_identity(identity: &StrictTimingIdentity, started: std::time::Instant) {
    bind_progress(ProgressIdentity { interval: "scalar", request_id: identity.request_id,
        child_request_ids: None, source_block: identity.source_block }, started);
}

// Only invoked for an enabled, untruncated begin record. Inspect a bounded
// number of method names, never parameters; unknown names collapse to other.
fn progress_methods(body: &Value) -> Value {
    #[cfg(test)]
    PROGRESS_METHOD_SCANS.with(|count| count.set(count.get() + 1));
    let mut counts = BTreeMap::new();
    let mut add = |item: &Value| { *counts.entry(method(item["method"].as_str().unwrap_or(""))).or_insert(0usize) += 1; };
    let count = if let Some(items) = body.as_array() {
        for item in items.iter().take(PROGRESS_METHOD_CAP) { add(item); }
        items.len()
    } else { add(body); 1 };
    json!({"methods":counts,"logicalItems":count,"methodItemsSampled":count.min(PROGRESS_METHOD_CAP),
        "methodsComplete":count <= PROGRESS_METHOD_CAP})
}

pub struct RpcAttemptScope(Option<(ProgressIdentity, std::time::Instant, u64, std::time::Instant)>);
pub fn rpc_attempt_scope(body: &Value) -> RpcAttemptScope {
    rpc_attempt(); // Same physical counter location; never count logical items.
    RpcAttemptScope(STRICT_TIMING.with(|slot| {
        let mut slot = slot.try_borrow_mut().ok()?;
        let timing = slot.as_mut()?;
        let progress = timing.progress.as_mut()?;
        if progress.sequence >= PROGRESS_RECORD_CAP { return None; }
        progress.attempts += 1;
        let attempt = progress.attempts;
        let started = std::time::Instant::now();
        progress.record("rpc-attempt-begin", timing.active, || {
            let mut fields = progress_methods(body);
            fields["attemptId"] = json!(attempt);
            fields
        });
        Some((progress.identity, progress.started, attempt, started))
    }))
}
impl Drop for RpcAttemptScope {
    fn drop(&mut self) {
        let Some((identity, interval_started, attempt, started)) = self.0 else { return; };
        STRICT_TIMING.with(|slot| {
            if let Ok(mut slot) = slot.try_borrow_mut() {
                if let Some(timing) = slot.as_mut() {
                    if let Some(progress) = &mut timing.progress {
                        if progress.identity == identity && progress.started == interval_started {
                            // Scope ended (including Err/continue), NOT success.
                            progress.record("rpc-attempt-end", timing.active, || json!({"attemptId":attempt,
                                "attemptElapsedMs":started.elapsed().as_secs_f64() * 1000.0}));
                        }
                    }
                }
            }
        });
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrictTimingIdentity {
    pub request_id: Option<u64>,
    pub source_block: Option<u64>,
    pub prefix_present: bool,
    // Bytes, not a route-hop count. No calldata or caller-provided strings leave.
    pub prefix_calldata_bytes: Option<usize>,
}

fn take_metrics() -> Option<Value> {
    let timing = STRICT_TIMING.with(|slot| slot.try_borrow_mut().ok()?.take());
    let mut timing = timing?;
    timing.close_interval();
    if let Some(progress) = &mut timing.progress {
        progress.record("interval-end", timing.active, || json!({}));
    }
    let mut phases = serde_json::Map::new();
    let mut wall = std::time::Duration::ZERO;
    let mut attempts = 0;
    for (phase, label) in PHASES {
        let metric = timing.phases[phase as usize];
        wall += metric.wall;
        attempts += metric.rpc_attempts;
        phases.insert(label.into(), json!({"wallMs":metric.wall.as_secs_f64() * 1000.0,
            "rpcAttempts":metric.rpc_attempts,"entries":metric.entries}));
    }
    Some(json!({"accounting":"exclusive","wallMs":wall.as_secs_f64() * 1000.0,
        "rpcAttempts":attempts,"phases":phases}))
}

pub fn finish_strict(identity: StrictTimingIdentity, ok: bool, success: Option<bool>, fatal: bool) {
    let Some(mut record) = take_metrics() else { return; };
    record["identity"] = json!(identity);
    record["ok"] = json!(ok);
    record["success"] = json!(success);
    record["fatal"] = json!(fatal);
    #[cfg(test)]
    LAST_STRICT_RECORD.with(|slot| *slot.borrow_mut() = Some(record.clone()));
    // One terminal stderr record, after postcheck even on ordinary errors. A
    // killed daemon cannot emit it and must remain censored by the caller.
    emit("strict-phase-timing", record);
}

// Three disjoint intervals, not nested scalar requests. The bridge belongs to
// neither child: its four logical checks and each physical attempt count once.
pub struct PairTiming {
    enabled: bool,
    ids: [u64; 2],
    source: u64,
    part: usize,
    parts: [Option<Value>; 3],
}
impl PairTiming {
    pub fn begin(enabled: bool, ids: [u64; 2], source: u64, started: std::time::Instant) -> Self {
        begin_strict(enabled, started);
        let timing = Self { enabled, ids, source, part: 0, parts: [None, None, None] };
        timing.bind_progress(started);
        timing
    }
    fn bind_progress(&self, started: std::time::Instant) {
        if !self.enabled { return; }
        bind_progress(ProgressIdentity {
            interval: ["pair-first", "pair-bridge", "pair-second"][self.part],
            request_id: match self.part { 0 => Some(self.ids[0]), 2 => Some(self.ids[1]), _ => None },
            child_request_ids: Some(self.ids), source_block: Some(self.source),
        }, started);
    }
    pub fn advance(&mut self) {
        self.parts[self.part] = take_metrics();
        self.part += 1;
        if self.enabled {
            let started = std::time::Instant::now();
            begin_strict(true, started);
            self.bind_progress(started);
        }
    }
    pub fn finish(mut self, emitted_children: usize, fatal: bool) {
        self.parts[self.part] = take_metrics();
        if !self.enabled { return; }
        let wall: f64 = self.parts.iter().flatten().filter_map(|p| p["wallMs"].as_f64()).sum();
        let attempts: u64 = self.parts.iter().flatten().filter_map(|p| p["rpcAttempts"].as_u64()).sum();
        let bridge_sent = self.parts[1].as_ref().and_then(|p| p["rpcAttempts"].as_u64()).is_some_and(|n| n > 0);
        let record = json!({"childRequestIds":self.ids,"sourceBlock":self.source,
            "accounting":"exclusive","wallMs":wall,"rpcAttempts":attempts,
            "emittedChildren":emitted_children,"fatal":fatal,
            "first":self.parts[0],"bridge":self.parts[1],"second":self.parts[2],
            "bridgeChecks":{"postRequestId":self.ids[0],"preRequestId":self.ids[1],"logicalCount":if bridge_sent { 4 } else { 0 }}});
        #[cfg(test)]
        LAST_PAIR_RECORD.with(|slot| *slot.borrow_mut() = Some(record.clone()));
        emit("strict-pair-phase-timing", record);
    }
}

#[cfg(test)]
pub fn take_pair_record() -> Option<Value> {
    LAST_PAIR_RECORD.with(|slot| slot.borrow_mut().take())
}

#[cfg(test)]
pub fn take_strict_record() -> Option<Value> {
    LAST_STRICT_RECORD.with(|slot| slot.borrow_mut().take())
}

pub fn emit(stage: &'static str, fields: Value) {
    emit_to(&mut std::io::stderr().lock(), stage, fields);
}

fn emit_to(out: &mut impl Write, stage: &'static str, fields: Value) {
    let record = json!({"schemaVersion":1,"pid":std::process::id(),"stage":stage,
        "timeUnixMs":SystemTime::now().duration_since(UNIX_EPOCH).ok().map(|d|d.as_millis()),
        "details":fields});
    // Broken diagnostics must not change the operation's result or fatal latch.
    let _ = writeln!(out, "[revm-diagnostic] {record}");
}

#[cfg(test)]
pub fn capture_progress() {
    PROGRESS_RECORDS.with(|slot| *slot.borrow_mut() = Some(Vec::new()));
    PROGRESS_METHOD_SCANS.with(|count| count.set(0));
}

#[cfg(test)]
pub fn take_progress() -> Vec<Value> {
    PROGRESS_RECORDS.with(|slot| slot.borrow_mut().take().unwrap_or_default())
}

#[cfg(test)]
pub fn observe_progress(sender: std::sync::mpsc::SyncSender<Value>) {
    PROGRESS_OBSERVER.with(|slot| *slot.borrow_mut() = Some(sender));
}

pub fn method(value: &str) -> &'static str {
    match value {
        "eth_chainId" => "eth_chainId", "eth_getBlockByHash" => "eth_getBlockByHash",
        "eth_getBlockByNumber" => "eth_getBlockByNumber", "eth_getCode" => "eth_getCode",
        "eth_getBalance" => "eth_getBalance", "eth_getTransactionCount" => "eth_getTransactionCount",
        "eth_getStorageAt" => "eth_getStorageAt", "debug_traceCall" => "debug_traceCall",
        "eth_call" => "eth_call", _ => "other",
    }
}

pub fn methods(body: &Value) -> BTreeMap<&'static str, usize> {
    let mut counts = BTreeMap::new();
    let mut add = |item: &Value| { *counts.entry(method(item["method"].as_str().unwrap_or(""))).or_insert(0) += 1; };
    if let Some(items) = body.as_array() { for item in items { add(item); } }
    else { add(body); }
    counts
}

pub fn transport_category(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() { "timeout" }
    else if error.is_connect() { "connection" }
    else if error.is_body() { "body-transfer" }
    else if error.is_decode() { "response-decode" }
    else if error.is_builder() { "request-builder" }
    else { "transport-other" }
}

// Diagnostic hints only. These labels never feed the retry/fatal policy, and
// unknown errors stay unknown. Never return any part of the original message.
fn transport_message_class(message: &str) -> &'static str {
    let message = message.to_ascii_lowercase();
    if message.contains("temporary failure in name resolution") { "dns-temporary" }
    else if message.contains("nodename nor servname provided") || message.contains("name or service not known") { "dns-not-found" }
    else if message.contains("dns error") || message.contains("failed to lookup address information") { "dns-resolution" }
    else if message.contains("certificate") || message.contains("unknown issuer") { "tls-certificate" }
    else if message.contains("handshake") { "tls-handshake" }
    else if message.contains("ssl") || message.contains("tls") { "tls-other" }
    else if message == "connection closed before message completed" { "http-header-eof" }
    else { "unclassified" }
}

fn native_status_hint(debug: &str) -> Option<i32> {
    // native-tls on Apple hides its concrete Security Framework error behind
    // Display/Debug and exposes no source or numeric accessor. Extract ONLY a
    // number from its known Debug layout; never log the Debug string itself.
    // It is a hint (not a downcast/type proof), and never authorizes retries.
    let rest = debug.strip_prefix("Error { code: ")?;
    let (digits, suffix) = rest.split_once(',').or_else(|| rest.split_once(" }"))?;
    if !suffix.is_empty() && !suffix.starts_with(" message: ") { return None; }
    let code: i32 = digits.parse().ok()?;
    (code < 0).then_some(code)
}

fn transport_causes(mut cause: Option<&(dyn Error + 'static)>) -> Value {
    let mut rows = Vec::new();
    while let Some(error) = cause {
        if rows.len() == 16 { break; }
        let mut row = json!({"depth":rows.len(), "messageClass":transport_message_class(&error.to_string())});
        if let Some(error) = error.downcast_ref::<io::Error>() {
            row["ioKind"] = json!(format!("{:?}", error.kind()));
            row["osError"] = json!(error.raw_os_error());
        }
        if let Some(code) = native_status_hint(&format!("{error:?}")) {
            row["nativeSecurityStatusHint"] = json!(code);
        }
        rows.push(row);
        cause = error.source();
    }
    json!({"causes":rows, "causesTruncated":cause.is_some()})
}

pub fn transport_details(error: &reqwest::Error, attempt: usize, status_allows_retry: bool, will_retry: bool) -> Value {
    // Read the existing predicate/limit for explanation only; do not replace
    // either. A refusal can mean an unclassified error, not a permanent one.
    let retryable = crate::retryable_rpc_transport_error(error);
    let attempts_remaining = attempt < crate::RPC_ATTEMPT_DELAYS.len();
    let mut details = transport_causes(error.source());
    details["flags"] = json!({"connect":error.is_connect(), "timeout":error.is_timeout(),
        "body":error.is_body(), "decode":error.is_decode(), "builder":error.is_builder(), "request":error.is_request()});
    details["retryableTransport"] = json!(retryable);
    details["attemptsRemaining"] = json!(attempts_remaining);
    details["statusAllowsRetry"] = json!(status_allows_retry);
    details["retryDecision"] = json!(if will_retry { "retry" }
        else if !retryable { "transport-not-classified-retryable" }
        else if !status_allows_retry { "http-status-not-retryable" }
        else if !attempts_remaining { "attempt-limit" }
        else { "not-retried" });
    details
}

pub fn rpc_transport_failure(stage: &'static str, body: &Value, attempt: usize,
    http_status: Option<u16>, error: &reqwest::Error, status_allows_retry: bool, will_retry: bool) {
    emit(stage, json!({"methods":methods(body),"attempt":attempt,"httpStatus":http_status,
        "rpcCode":null,"category":transport_category(error),"willRetry":will_retry,
        "transport":transport_details(error, attempt, status_allows_retry, will_retry)}));
}

pub fn source_category(error: &anyhow::Error) -> &'static str {
    match error.to_string().as_str() {
        "rpc send failed" => "rpc-send-failed",
        "rpc json decode failed" => "rpc-json-decode-failed",
        "rpc response identity mismatch" => "rpc-response-identity-mismatch",
        "rpc batch: non-array response" => "rpc-batch-non-array",
        "rpc batch identity mismatch" => "rpc-batch-identity-mismatch",
        "rpc batch identity missing" => "rpc-batch-identity-missing",
        "pinned state batch incomplete" => "pinned-batch-incomplete",
        "invalid pinned hex" | "invalid pinned hex width" => "invalid-state-hex",
        "invalid pinned quantity" => "invalid-state-quantity",
        "invalid pinned bytecode" => "invalid-state-bytecode",
        "pinned chain mismatch" => "chain-mismatch",
        "pinned header identity mismatch" => "header-identity-mismatch",
        "pinned state root mismatch" => "state-root-mismatch",
        "pinned canonical header changed" => "canonical-header-changed",
        "unsupported pre-Prague pinned profile" => "unsupported-header-profile",
        "invalid pinned gas limits" | "invalid post-merge pinned header" |
        "invalid pinned extraData" | "invalid pinned blob gas" | "blob fee overflow" => "invalid-header-fields",
        "incomplete pinned account" => "incomplete-account",
        "missing pinned account code" => "missing-account-code",
        _ => "unclassified-local-error",
    }
}

pub fn rpc_failure(stage: &'static str, body: &Value, attempt: usize,
    http_status: Option<u16>, rpc_code: Option<i64>, category: &'static str, will_retry: bool) {
    emit(stage, json!({"methods":methods(body),"attempt":attempt,"httpStatus":http_status,
        "rpcCode":rpc_code,"category":category,"willRetry":will_retry}));
}

#[cfg(test)]
mod tests {
    use super::*;
    fn progress_identity() -> StrictTimingIdentity {
        StrictTimingIdentity { request_id: Some(7), source_block: Some(300),
            prefix_present: true, prefix_calldata_bytes: Some(1) }
    }

    #[test]
    fn strict_progress_disabled_and_nested_counters_remain_exclusive() {
        for enabled in [false, true] {
            capture_progress();
            let started = std::time::Instant::now();
            begin_strict(enabled, started);
            bind_strict_identity(&progress_identity(), started);
            {
                let _parent = phase(Phase::TokenDeal);
                { let _rpc = rpc_attempt_scope(&json!({"method":"eth_call"})); }
                {
                    let _child = phase(Phase::TokenDealInitialProbe);
                    let _rpc = rpc_attempt_scope(&json!({"method":"eth_getCode"}));
                }
                { let _rpc = rpc_attempt_scope(&json!({"method":"eth_call"})); }
            }
            finish_strict(progress_identity(), true, Some(true), false);
            let records = take_progress();
            let terminal = take_strict_record();
            if !enabled {
                assert!(records.is_empty()); assert!(terminal.is_none());
                PROGRESS_METHOD_SCANS.with(|count| assert_eq!(count.get(), 0));
                continue;
            }
            let terminal = terminal.unwrap();
            assert_eq!(terminal["rpcAttempts"], 3);
            assert_eq!(terminal["phases"]["token-deal"]["rpcAttempts"], 2);
            assert_eq!(terminal["phases"]["token-deal-initial-probe"]["rpcAttempts"], 1);
            assert_eq!(records.first().unwrap()["event"], "interval-begin");
            assert_eq!(records.last().unwrap()["event"], "interval-end");
            let mut elapsed = 0.0;
            for (i, record) in records.iter().enumerate() {
                assert_eq!(record["sequence"], i + 1);
                assert_eq!(record["identity"], json!({"interval":"scalar","requestId":7,
                    "childRequestIds":null,"sourceBlock":300}));
                assert!(record["elapsedMs"].as_f64().unwrap() >= elapsed);
                elapsed = record["elapsedMs"].as_f64().unwrap();
            }
            assert!(records.iter().any(|r| r["event"] == "phase-resume" && r["phase"] == "token-deal"));
            let attempts: Vec<_> = records.iter().filter(|r| r["attemptId"].is_number()).collect();
            assert_eq!(attempts.len(), 6);
            for (i, pair) in attempts.chunks_exact(2).enumerate() {
                assert_eq!(pair[0]["event"], "rpc-attempt-begin");
                assert_eq!(pair[1]["event"], "rpc-attempt-end");
                assert_eq!(pair[0]["attemptId"], i + 1);
                assert_eq!(pair[0]["attemptId"], pair[1]["attemptId"]);
                assert!(pair[1].get("success").is_none());
                assert!(pair[1]["attemptElapsedMs"].as_f64().unwrap() >= 0.0);
            }
        }
    }

    #[test]
    fn strict_progress_cap_truncates_once_and_metadata_is_bounded_and_safe() {
        capture_progress();
        let started = std::time::Instant::now();
        begin_strict(true, started);
        bind_strict_identity(&progress_identity(), started);
        let secret = "https://user:private@example.invalid/calldata";
        let mut items = vec![json!({"method":"eth_getStorageAt","params":[secret]}); 200];
        items[0]["method"] = json!(secret);
        let body = json!(items);
        for _ in 0..200 { let _rpc = rpc_attempt_scope(&body); }
        let scans = PROGRESS_METHOD_SCANS.with(|count| count.get());
        for _ in 0..10 { let _phase = phase(Phase::Hydration); let _rpc = rpc_attempt_scope(&body); }
        assert_eq!(PROGRESS_METHOD_SCANS.with(|count| count.get()), scans, "no scans after truncation");
        finish_strict(progress_identity(), true, Some(true), false);
        let records = take_progress();
        assert_eq!(records.len(), PROGRESS_RECORD_CAP);
        assert_eq!(records.iter().filter(|r| r["event"] == "truncated").count(), 1);
        assert_eq!(records.last().unwrap()["event"], "truncated");
        assert_eq!(records.last().unwrap()["sequence"], PROGRESS_RECORD_CAP);
        let begin = records.iter().find(|r| r["event"] == "rpc-attempt-begin").unwrap();
        assert_eq!(begin["methods"], json!({"other":1,"eth_getStorageAt":127}));
        assert_eq!(begin["logicalItems"], 200);
        assert_eq!(begin["methodItemsSampled"], PROGRESS_METHOD_CAP);
        assert_eq!(begin["methodsComplete"], false);
        assert!(!json!(records).to_string().contains(secret));
        assert_eq!(take_strict_record().unwrap()["rpcAttempts"], 210, "terminal counters never truncate");
    }

    #[test]
    fn strict_progress_pair_intervals_bind_children_and_count_bridge_once() {
        capture_progress();
        let mut pair = PairTiming::begin(true, [8, 9], 300, std::time::Instant::now());
        for part in 0..3 {
            { let _rpc = rpc_attempt_scope(&json!({"method":"eth_getBlockByNumber"})); }
            if part < 2 { pair.advance(); }
        }
        pair.finish(2, false);
        let records = take_progress();
        assert_eq!(records.len(), 12);
        for (part, interval) in records.chunks_exact(4).enumerate() {
            for (i, record) in interval.iter().enumerate() {
                assert_eq!(record["sequence"], i + 1);
                assert_eq!(record["identity"]["interval"], ["pair-first","pair-bridge","pair-second"][part]);
                assert_eq!(record["identity"]["childRequestIds"], json!([8,9]));
                assert_eq!(record["identity"]["sourceBlock"], 300);
                assert_eq!(record["identity"]["requestId"], match part { 0 => json!(8), 2 => json!(9), _ => Value::Null });
            }
        }
        let terminal = take_pair_record().unwrap();
        assert_eq!(terminal["rpcAttempts"], 3);
        assert_eq!(terminal["bridge"]["rpcAttempts"], 1);
        assert_eq!(terminal["bridgeChecks"]["logicalCount"], 4);
        assert!(take_strict_record().is_none());
    }

    #[test]
    fn strict_progress_old_attempt_cannot_end_in_a_new_identity_and_sink_errors_are_ignored() {
        capture_progress();
        let started = std::time::Instant::now();
        begin_strict(true, started);
        bind_strict_identity(&progress_identity(), started);
        let old = rpc_attempt_scope(&json!({"method":"eth_call"}));
        let next = std::time::Instant::now();
        begin_strict(true, next);
        let identity = StrictTimingIdentity { request_id: Some(8), ..progress_identity() };
        bind_strict_identity(&identity, next);
        drop(old);
        finish_strict(identity, true, Some(true), false);
        let records = take_progress();
        assert!(!records.iter().any(|r| r["event"] == "rpc-attempt-end"));
        assert_eq!(take_strict_record().unwrap()["rpcAttempts"], 0);
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> { Err(io::ErrorKind::BrokenPipe.into()) }
            fn flush(&mut self) -> io::Result<()> { Err(io::ErrorKind::BrokenPipe.into()) }
        }
        emit_to(&mut Broken, "strict-progress", json!({"event":"rpc-attempt-end"}));
    }

    #[test]
    fn strict_phase_metrics_are_exclusive_bounded_and_disabled_by_default() {
        let identity = || StrictTimingIdentity { request_id: Some(1), source_block: Some(300),
            prefix_present: true, prefix_calldata_bytes: Some(1) };
        for enabled in [false, true] {
            begin_strict(enabled, std::time::Instant::now());
            {
                let _parent = phase(Phase::TokenDeal);
                rpc_attempt();
                {
                    let _child = phase(Phase::TokenDealInitialProbe);
                    rpc_attempt(); rpc_attempt();
                }
                rpc_attempt();
            }
            finish_strict(identity(), false, None, true);
            let record = take_strict_record();
            if enabled {
                let record = record.unwrap();
                assert_eq!(record["rpcAttempts"], 4);
                assert_eq!(record["phases"]["token-deal"]["rpcAttempts"], 2);
                assert_eq!(record["phases"]["token-deal-initial-probe"]["rpcAttempts"], 2);
                let phases = record["phases"].as_object().unwrap();
                assert_eq!(phases.len(), PHASES.len());
                let total: f64 = phases.values().map(|v| v["wallMs"].as_f64().unwrap()).sum();
                assert!((record["wallMs"].as_f64().unwrap() - total).abs() < 0.000001);
                assert_eq!(record["fatal"], true);
            } else { assert!(record.is_none()); }
            finish_strict(identity(), true, Some(true), false);
            assert!(take_strict_record().is_none(), "one terminal record only");
        }
    }

    #[test]
    fn metadata_never_copies_arbitrary_method_error_or_parameters() {
        let secret = "https://user:secret@example.invalid/private?key=secret";
        let requests = json!([{"method":"eth_getCode","params":[secret]},
            {"method":secret,"params":[secret]},{"method":"eth_getCode"}]);
        assert_eq!(serde_json::to_value(methods(&requests)).unwrap(), json!({"eth_getCode":2,"other":1}));
        assert_eq!(source_category(&anyhow::anyhow!(secret.to_owned())), "unclassified-local-error");
        assert_eq!(source_category(&anyhow::anyhow!("pinned state root mismatch")), "state-root-mismatch");
        assert_eq!(source_category(&anyhow::anyhow!("rpc send failed")), "rpc-send-failed");
    }

    #[test]
    fn transport_causes_keep_codes_not_error_text() {
        let secret = "https://user:must-not-echo@example.invalid/private?key=must-not-echo";
        let error = io::Error::new(io::ErrorKind::Other, format!("tls handshake: {secret}"));
        let value = transport_causes(Some(&error));
        assert_eq!(value["causes"][0]["ioKind"], "Other");
        assert_eq!(value["causes"][0]["messageClass"], "tls-handshake");
        assert!(!value.to_string().contains("must-not-echo"));
        let error = io::Error::from_raw_os_error(61);
        assert_eq!(transport_causes(Some(&error))["causes"][0]["osError"], 61);
        assert_eq!(native_status_hint(&format!("Error {{ code: -9806, message: \"{secret}\" }}")), Some(-9806));
        assert_eq!(native_status_hint("Error { code: -9806 }"), Some(-9806));
        assert_eq!(native_status_hint(secret), None);
        assert_eq!(native_status_hint("Error { code: bad, message: \"secret\" }"), None);
        for (message, expected) in [
            ("temporary failure in name resolution", "dns-temporary"),
            ("nodename nor servname provided, or not known", "dns-not-found"),
            ("dns error: arbitrary host", "dns-resolution"),
            ("certificate verify failed for arbitrary host", "tls-certificate"),
            (secret, "unclassified"),
        ] { assert_eq!(transport_message_class(message), expected); }
    }

    #[test]
    fn transport_cause_walk_is_bounded() {
        #[derive(Debug)] struct Cycle;
        impl std::fmt::Display for Cycle {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "private-error") }
        }
        impl Error for Cycle { fn source(&self) -> Option<&(dyn Error + 'static)> { Some(self) } }
        let value = transport_causes(Some(&Cycle));
        assert_eq!(value["causes"].as_array().unwrap().len(), 16);
        assert_eq!(value["causesTruncated"], true);
        assert!(!value.to_string().contains("private-error"));
    }

    #[test]
    fn real_tls_handshake_failure_has_safe_diagnostics_and_unchanged_retry_decision() {
        use std::{io::Read, net::TcpListener, time::Duration};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("https://user:must-not-echo@{}/private-must-not-echo", listener.local_addr().unwrap());
        let peer = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let until = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                        let mut hello = [0u8; 4096]; let _ = stream.read(&mut hello);
                        break; // close during TLS handshake; no RPC or external I/O
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock && std::time::Instant::now() < until =>
                        std::thread::sleep(Duration::from_millis(1)),
                    Err(e) => panic!("loopback accept: {e}"),
                }
            }
        });
        let client = reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(3)).build().unwrap();
        let error = client.post(&url).json(&json!({"method":"eth_chainId"})).send().unwrap_err();
        peer.join().unwrap();
        assert!(error.is_connect());
        let retryable = crate::retryable_rpc_transport_error(&error);
        let details = transport_details(&error, 1, true, retryable);
        assert_eq!(details["retryableTransport"], retryable);
        assert_eq!(details["attemptsRemaining"], true);
        assert!(!details["causes"].as_array().unwrap().is_empty());
        assert!(!details.to_string().contains("must-not-echo"));
        #[cfg(target_os = "macos")]
        assert!(details["causes"].as_array().unwrap().iter().any(|row| row["nativeSecurityStatusHint"].is_i64()),
            "native TLS status must survive opaque connection wrappers");
    }
}
