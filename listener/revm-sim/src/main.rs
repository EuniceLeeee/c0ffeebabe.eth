use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    env, fmt, fs,
    error::Error as _,
    io::{self, BufRead, Write as IoWrite},
    path::PathBuf,
    rc::Rc,
    str::FromStr,
    time::{Duration, Instant},
};

use anyhow::{Context as AnyhowContext, Result, anyhow, bail};
use clap::{Parser, Subcommand};
use reqwest::blocking::Client;
use revm::{
    Database, DatabaseCommit, ExecuteEvm, MainBuilder, MainContext,
    bytecode::Bytecode,
    context::{BlockEnv, Context, TxEnv},
    context_interface::{ContextTr, JournalTr, LocalContextTr, Transaction,
        journaled_state::account::JournaledAccountTr,
        result::{ExecutionResult, EVMError, HaltReason, ResultGas}},
    handler::{Handler, EvmTr, EvmTrError, FrameTr, FrameResult, MainnetHandler},
    interpreter::{FrameInput, InitialAndFloorGas, interpreter_action::FrameInit},
    database::{AccountState, CacheDB},
    database_interface::{DBErrorMarker, DatabaseRef},
    primitives::{Address, B256, Bytes, U256, hardfork::SpecId, keccak256},
    state::{AccountInfo, EvmState},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
mod diagnostic;
use diagnostic::Phase;

const BALANCE_OF_SELECTOR: [u8; 4] = [0x70, 0xa0, 0x82, 0x31];
const TOTAL_SUPPLY_SELECTOR: [u8; 4] = [0x18, 0x16, 0x0d, 0xdd];
const APPROVE_SELECTOR: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];
const DEFAULT_GAS_LIMIT: u64 = 0x1000000;
const RPC_ATTEMPT_DELAYS: [Duration; 3] = [Duration::ZERO, Duration::from_secs(1), Duration::from_secs(3)];

// Bound server-requested waits within the existing simulation timeout. Never
// retry earlier than Retry-After; unsupported/long values retain fatal handling.
fn rate_retry_after(value: Option<&reqwest::header::HeaderValue>) -> Option<Duration> {
    let Some(value) = value else { return Some(Duration::ZERO); };
    let seconds = value.to_str().ok()?.trim().parse::<u64>().ok()?;
    (seconds <= 10).then(|| Duration::from_secs(seconds))
}

fn retryable_rpc_transport_error(error: &reqwest::Error) -> bool {
    if error.is_timeout() { return true; }
    let mut cause = error.source();
    while let Some(inner) = cause {
        if let Some(error) = inner.downcast_ref::<io::Error>() {
            if matches!(error.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
                | io::ErrorKind::ConnectionRefused | io::ErrorKind::TimedOut | io::ErrorKind::UnexpectedEof
                | io::ErrorKind::BrokenPipe | io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                | io::ErrorKind::NotConnected | io::ErrorKind::NetworkDown | io::ErrorKind::NetworkUnreachable
                | io::ErrorKind::HostUnreachable) { return true; }
        }
        // Hyper's header-EOF error has no io::Error source. Match only this
        // fixed transport diagnostic, not arbitrary request/connect failures
        // (which also include permanent TLS and HTTP protocol errors).
        if inner.to_string() == "connection closed before message completed" { return true; }
        cause = inner.source();
    }
    false
}

#[derive(Debug, Parser)]
#[command(name = "revm-sim")]
#[command(about = "Local revm simulator sidecar for the MEV searcher")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Validate the sidecar binary starts and can emit JSON.
    Health,
    /// Simulate one prepared BotVM/backrun fixture (one-shot, cold cache).
    Simulate {
        /// JSON input file.
        input: PathBuf,
    },
    /// Resident daemon: JSON-lines requests on stdin, JSON responses on stdout.
    /// Keeps a per-block warm chain cache so repeated quote/simulate calls in one
    /// hint reuse fetched account/code/storage instead of re-hitting the RPC.
    Serve,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimRequest {
    block_number: u64,
    executor: String,
    owner: String,
    calldata: String,
    profit_token: String,
    #[serde(default)]
    gas_limit: Option<u64>,
    #[serde(default)]
    rpc_url: Option<String>,
    #[serde(default)]
    state_overrides: Vec<StateOverride>,
    #[serde(default)]
    pre_calls: Vec<PreCall>,
    #[serde(default)]
    token_deals: Vec<TokenDeal>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateOverride {
    address: String,
    slot: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreCall {
    from: String,
    to: String,
    calldata: String,
    #[serde(default)]
    gas_limit: Option<u64>,
    #[serde(default)]
    allowance_slot: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenDeal {
    token: String,
    to: String,
    amount: String,
    #[serde(default)]
    balance_slot: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenBalanceHint {
    token: String,
    account: String,
    #[serde(default)]
    balance_slot: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenAllowanceHint {
    token: String,
    owner: String,
    spender: String,
    #[serde(default)]
    allowance_slot: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SimResponse {
    success: bool,
    profit: String,
    gas_used: String,
    revert_reason: Option<String>,
    latency_ms: u128,
    missing_state_keys: Vec<String>,
}

#[derive(Debug, Clone)]
struct RpcError(String);

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RpcError {}
impl DBErrorMarker for RpcError {}

/// Physical transport evidence only. Never infer quota from contract/revert text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum FatalReason {
    SourceFault,
    RpcThrottle {
        category: ThrottleCategory,
        #[serde(skip_serializing_if = "Option::is_none")]
        http_status: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        rpc_code: Option<i64>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ThrottleCategory {
    Http429,
    RpcLimitCode,
    RpcRateLimit,
    RpcQuota,
}

impl fmt::Display for FatalReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::SourceFault => "revm-sim fatal source-fault",
            Self::RpcThrottle { .. } => "revm-sim fatal rpc-throttle",
        })
    }
}
impl std::error::Error for FatalReason {}
type FatalLatch = Rc<Cell<Option<FatalReason>>>;

#[derive(Debug)]
struct RpcClient {
    url: String,
    client: Client,
    /// Count of HTTP round trips (single calls + batches each count once). This
    /// is the RPC-latency-independent cost metric for `prepare`: on a warm
    /// keep-alive connection wall time is roughly round_trips × warm RTT, so the
    /// lever is keeping this number minimal while preserving batch structure.
    round_trips: std::cell::Cell<u64>,
    fatal: FatalLatch,
    pinned: bool,
}

impl RpcClient {
    fn new(url: String, client: Client, fatal: FatalLatch) -> Result<Self> {
        Ok(Self {
            url,
            client,
            round_trips: std::cell::Cell::new(0),
            fatal,
            pinned: false,
        })
    }

    fn round_trips(&self) -> u64 {
        self.round_trips.get()
    }

    fn check_fatal(&self) -> Result<()> {
        if let Some(reason) = self.fatal.get() {
            return Err(reason.into());
        }
        Ok(())
    }

    fn latch(&self, reason: FatalReason) {
        if self.fatal.get().is_none() {
            diagnostic::emit("fatal-latch", json!({"fatal":reason}));
            self.fatal.set(Some(reason));
        }
    }

    #[track_caller]
    fn checked_source<T>(&self, result: Result<T>) -> Result<T> {
        if self.pinned && self.fatal.get().is_none() {
            if let Err(error) = &result {
                diagnostic::emit("source-check", json!({"category":diagnostic::source_category(error),
                    "callerLine":std::panic::Location::caller().line()}));
            }
        }
        if self.pinned && result.is_err() { self.latch(FatalReason::SourceFault); }
        self.check_fatal()?;
        result
    }

    fn rpc_error_reason(&self, response: &Value) -> Option<FatalReason> {
        let Some(error) = response.get("error").filter(|error| error.is_object()) else {
            return None;
        };
        let code = error.get("code").and_then(Value::as_i64);
        let hex_data = error
            .get("data")
            .and_then(Value::as_str)
            .is_some_and(|data| {
                data.get(..2)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("0x"))
                    && data[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
            });
        if code == Some(3)
            || error.get("code").and_then(Value::as_str) == Some("CALL_EXCEPTION")
            || (code == Some(-32000) && hex_data)
        {
            return None;
        }
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        // Inspect only structured RPC errors, never result/revert output. Also
        // keep explicitly marked execution reverts out of message classification.
        let words: Vec<&str> = message
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|word| !word.is_empty())
            .collect();
        let explicit_revert = words.windows(2).any(|pair| pair == ["execution", "reverted"])
            || words.first().is_some_and(|word| *word == "revert" || *word == "reverted");
        // Source selection failures are fatal even in optional trace responses,
        // including whole-batch and unknown-ID items scanned by send_json.
        // Diagnostic metadata (including objects) is not revert output. Typed
        // reverts, direct hex data (including empty 0x) and explicit revert
        // messages remain domain outcomes, not evidence about the source.
        if self.pinned && !hex_data && !explicit_revert
            && matches!(code, Some(-32000 | -32001))
            && source_selection_diagnostic(message.trim()) {
            return Some(FatalReason::SourceFault);
        }
        let category = if matches!(code, Some(429 | -32005)) {
            ThrottleCategory::RpcLimitCode
        } else if explicit_revert {
            return None;
        } else if words
            .windows(3)
            .any(|phrase| phrase == ["too", "many", "requests"])
            || words
                .windows(2)
                .any(|pair| pair == ["rate", "limit"] || pair == ["http", "429"])
            || words.contains(&"ratelimit")
        {
            ThrottleCategory::RpcRateLimit
        } else if words.iter().enumerate().any(|(i, word)| {
            (*word == "quota"
                || *word == "throughput"
                || (*word == "compute" && matches!(words.get(i + 1), Some(&"unit" | &"units"))))
                && words[i + 1..].iter().any(|tail| {
                    tail.starts_with("exceed")
                        || tail.starts_with("limit")
                        || *tail == "capacity"
                        || tail.starts_with("exhaust")
                        || tail.starts_with("deplet")
                })
        }) {
            ThrottleCategory::RpcQuota
        } else {
            return None;
        };
        Some(FatalReason::RpcThrottle {
            category,
            http_status: None,
            rpc_code: code,
        })
    }

    fn inspect_rpc_error(&self, response: &Value) {
        if let Some(reason) = self.rpc_error_reason(response) { self.latch(reason); }
    }

    // Only replay a binding-valid response with temporary rate errors. Do not
    // hide bad IDs, state values, domain/source failures or hard quota failures.
    fn retryable_rate_response(&self, request: &Value, response: &Value) -> bool {
        let requests: Vec<&Value> = request.as_array().map(|v| v.iter().collect())
            .unwrap_or_else(|| vec![request]);
        let responses: Vec<&Value> = response.as_array().map(|v| v.iter().collect())
            .unwrap_or_else(|| vec![response]);
        if request.is_array() != response.is_array() || requests.len() != responses.len() { return false; }
        let mut seen = HashSet::new();
        let mut rate_limited = false;
        for item in responses {
            let Some(id) = item.get("id").and_then(Value::as_u64) else { return false; };
            let Some(original) = requests.iter().find(|r| r.get("id").and_then(Value::as_u64) == Some(id)) else { return false; };
            if !seen.insert(id) || item.get("jsonrpc").and_then(Value::as_str) != Some("2.0") { return false; }
            if let Some(error) = item.get("error") {
                if item.get("result").is_some() { return false; }
                let Some(FatalReason::RpcThrottle { .. }) = self.rpc_error_reason(item) else { return false; };
                let Some(code) = error.get("code").and_then(Value::as_i64) else { return false; };
                let Some(message) = error.get("message").and_then(Value::as_str) else { return false; };
                let message = message.to_ascii_lowercase();
                let words: Vec<_> = message.split(|c: char| !c.is_ascii_alphanumeric()).collect();
                if words.iter().any(|w| matches!(*w, "quota" | "credit" | "credits" | "billing" | "monthly" | "daily")
                    || w.starts_with("exhaust") || w.starts_with("deplet") || w.starts_with("revert")) { return false; }
                if error.get("data").and_then(Value::as_str).is_some_and(|d| d.starts_with("0x") || d.starts_with("0X")) { return false; }
                let explicit_rate = words.windows(2).any(|p| p == ["rate", "limit"])
                    || words.windows(3).any(|p| p == ["too", "many", "requests"])
                    || words.contains(&"ratelimit") || words.contains(&"throughput")
                    || (words.contains(&"compute") && words.contains(&"capacity"));
                if code != 429 && !explicit_rate { return false; }
                rate_limited = true;
            } else {
                let Some(value) = item.get("result") else { return false; };
                if self.pinned && validate_state_value(original["method"].as_str().unwrap_or(""), value).is_err() { return false; }
            }
        }
        rate_limited
    }

    fn send_json(&self, body: &Value) -> Result<Value> {
        // Retry the identical read before checked_source can latch a transient
        // transport failure. The caller's operation timeout remains unchanged.
        let mut rate_wait = Duration::ZERO;
        let mut rate_reason = None;
        for (attempt, delay) in RPC_ATTEMPT_DELAYS.iter().enumerate() {
            self.check_fatal()?;
            let delay = (*delay).max(rate_wait);
            rate_wait = Duration::ZERO;
            if !delay.is_zero() { std::thread::sleep(delay); }
            let can_retry = attempt + 1 < RPC_ATTEMPT_DELAYS.len();
            self.round_trips.set(self.round_trips.get() + 1);
            let _attempt_progress = diagnostic::rpc_attempt_scope(body);
            let response = match self.client.post(&self.url).json(body).send() {
                Ok(response) => response,
                Err(error) if can_retry && retryable_rpc_transport_error(&error) => {
                    diagnostic::rpc_transport_failure("rpc-send", body, attempt + 1, None,
                        &error, true, true);
                    continue;
                }
                Err(error) => {
                    diagnostic::rpc_transport_failure("rpc-send", body, attempt + 1, None,
                        &error, true, false);
                    if let Some(reason) = rate_reason { self.latch(reason); }
                    self.check_fatal()?;
                    bail!("rpc send failed");
                }
            };
            let status = response.status();
            let retry_after = rate_retry_after(response.headers().get(reqwest::header::RETRY_AFTER));
            let transient_status = matches!(status.as_u16(), 502 | 503 | 504);
            let json_content = response.headers().get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()).is_some_and(|v| v.to_ascii_lowercase().contains("json"));
            // Read the body separately: interrupted transfers may retry, but a
            // complete malformed JSON response on HTTP success must not retry.
            // Never expose reqwest errors, endpoint credentials or remote text.
            let bytes = match response.bytes() {
                Ok(bytes) => bytes,
                Err(error) if can_retry && (status.is_success() || transient_status)
                    && retryable_rpc_transport_error(&error) => {
                    diagnostic::rpc_transport_failure("rpc-body", body, attempt + 1, Some(status.as_u16()),
                        &error, status.is_success() || transient_status, true);
                    continue;
                }
                Err(error) if status.as_u16() == 429 => {
                    diagnostic::rpc_transport_failure("rpc-body", body, attempt + 1, Some(429),
                        &error, false, false);
                    self.latch(FatalReason::RpcThrottle { category: ThrottleCategory::Http429,
                        http_status: Some(429), rpc_code: None });
                    self.check_fatal()?;
                    unreachable!("429 is latched")
                }
                Err(error) => {
                    diagnostic::rpc_transport_failure("rpc-body", body, attempt + 1, Some(status.as_u16()),
                        &error, status.is_success() || transient_status, false);
                    if let Some(reason) = rate_reason { self.latch(reason); }
                    self.check_fatal()?;
                    bail!("rpc json decode failed");
                }
            };
            let decoded = serde_json::from_slice::<Value>(&bytes);
            let json_looking = bytes.iter().find(|byte| !byte.is_ascii_whitespace())
                .is_some_and(|byte| matches!(*byte, b'{' | b'[' | b'"'));
            let mut has_rpc_response = false;
            if let Ok(value) = &decoded {
                // A JSON-RPC-shaped reply must not be hidden by an HTTP retry,
                // including wrong IDs/versions, incomplete batches and reverts.
                has_rpc_response = value.is_array() || ["jsonrpc", "id", "result"].iter()
                    .any(|key| value.get(*key).is_some()) || value.get("error").is_some_and(Value::is_object);
                if can_retry && retry_after.is_some() && self.retryable_rate_response(body, value)
                    && (status.is_success() || transient_status || status.as_u16() == 429) {
                    rate_wait = retry_after.unwrap();
                    rate_reason = value.as_array().and_then(|items| items.iter().find_map(|item| self.rpc_error_reason(item)))
                        .or_else(|| self.rpc_error_reason(value));
                    diagnostic::emit("rpc-rate-retry", json!({"methods":diagnostic::methods(body),
                        "attempt":attempt + 1,"httpStatus":status.as_u16(),"fatal":rate_reason,
                        "waitMs":(*RPC_ATTEMPT_DELAYS.get(attempt + 1).unwrap_or(&Duration::ZERO)).max(rate_wait).as_millis()}));
                    continue;
                }
                let items = value.as_array().map(|v| v.iter().collect::<Vec<_>>()).unwrap_or_else(|| vec![value]);
                for item in items {
                    if item.get("error").is_some() && (self.rpc_error_reason(item).is_some()
                        || diagnostic::methods(body).keys().any(|method| *method != "debug_traceCall")) {
                        diagnostic::rpc_failure("rpc-error", body, attempt + 1, Some(status.as_u16()),
                            item["error"]["code"].as_i64(),
                            if self.rpc_error_reason(item).is_some() { "fatal-rpc-error" } else { "rpc-error" }, false);
                    }
                }
                self.inspect_rpc_error(value);
                if let Some(items) = value.as_array() {
                    // Scan EVERY item, including unknown/duplicate IDs, before
                    // considering an HTTP retry or selecting batch results.
                    for item in items {
                        self.inspect_rpc_error(item);
                    }
                }
            }
            if status.as_u16() == 429 {
                if can_retry && retry_after.is_some() && !has_rpc_response
                    && (decoded.is_ok() || bytes.is_empty() || (!json_content && !json_looking)) {
                    rate_wait = retry_after.unwrap();
                    rate_reason = Some(FatalReason::RpcThrottle { category: ThrottleCategory::Http429,
                        http_status: Some(429), rpc_code: None });
                    diagnostic::rpc_failure("rpc-http", body, attempt + 1, Some(429), None, "http429", true);
                    continue;
                }
                diagnostic::rpc_failure("rpc-http", body, attempt + 1, Some(429), None, "http429", false);
                self.latch(FatalReason::RpcThrottle { category: ThrottleCategory::Http429,
                    http_status: Some(429), rpc_code: None });
            }
            self.check_fatal()?;
            if can_retry && transient_status && !has_rpc_response {
                diagnostic::rpc_failure("rpc-http", body, attempt + 1, Some(status.as_u16()), None, "http-status", true);
                continue;
            }
            if !status.is_success() || decoded.is_err() {
                diagnostic::rpc_failure("rpc-response", body, attempt + 1, Some(status.as_u16()), None,
                    if decoded.is_err() { "invalid-json" } else { "http-status" }, false);
            }
            if let Some(reason) = rate_reason {
                // Optional traces do not pass through checked_source. A retry
                // is recovered only by a valid bound response, never by a
                // malformed body/ID that the optional caller could swallow.
                if !status.is_success() || !decoded.as_ref().is_ok_and(|value|
                    self.valid_rate_recovery(body, value)) {
                    self.latch(reason);
                    self.check_fatal()?;
                }
            }
            let value = decoded.map_err(|_| anyhow!("rpc json decode failed"))?;
            if !status.is_success() {
                bail!("rpc http status {}", status.as_u16());
            }
            return Ok(value);
        }
        unreachable!("last RPC attempt returns without retrying")
    }

    fn valid_rate_recovery(&self, request: &Value, response: &Value) -> bool {
        let requests: Vec<&Value> = request.as_array().map(|v| v.iter().collect())
            .unwrap_or_else(|| vec![request]);
        let responses: Vec<&Value> = response.as_array().map(|v| v.iter().collect())
            .unwrap_or_else(|| vec![response]);
        if request.is_array() != response.is_array() || requests.len() != responses.len() { return false; }
        let mut seen = HashSet::new();
        responses.iter().all(|item| {
            let Some(id) = item.get("id").and_then(Value::as_u64) else { return false; };
            let Some(original) = requests.iter().find(|r| r.get("id").and_then(Value::as_u64) == Some(id)) else { return false; };
            if !seen.insert(id) || item.get("jsonrpc").and_then(Value::as_str) != Some("2.0") { return false; }
            match (item.get("result"), item.get("error")) {
                (Some(value), None) => !self.pinned || validate_state_value(original["method"].as_str().unwrap_or(""), value).is_ok(),
                (None, Some(error)) => error.get("code").and_then(Value::as_i64).is_some()
                    && error.get("message").and_then(Value::as_str).is_some()
                    && self.rpc_error_reason(item).is_none(),
                _ => false,
            }
        })
    }

    fn call(&self, method: &str, params: Value) -> Result<Value> {
        let result = (|| {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let response = self.send_json(&body)?;
        if self.pinned && (response.get("id") != Some(&json!(1)) || response.get("jsonrpc") != Some(&json!("2.0"))) {
            bail!("rpc response identity mismatch");
        }
        if let Some(error) = response.get("error") {
            bail!(
                "rpc {method} error code {:?}",
                error.get("code").and_then(Value::as_i64)
            );
        }
        let value = response
            .get("result")
            .cloned()
            .ok_or_else(|| anyhow!("rpc {method} response missing result"))?;
        if self.pinned { validate_state_value(method, &value)?; }
        Ok(value)
        })();
        if method != "debug_traceCall" && result.is_err() && self.fatal.get().is_none() {
            diagnostic::emit("rpc-call-validation", json!({"method":diagnostic::method(method),
                "category":diagnostic::source_category(result.as_ref().unwrap_err())}));
        }
        if method == "debug_traceCall" { result } else { self.checked_source(result) }
    }

    /// Many JSON-RPC calls in one HTTP round trip. Results are returned in the
    /// same order as `calls`; a per-call error becomes an `Err` entry while a
    /// transport failure fails the whole batch.
    fn batch_call(&self, calls: &[(&str, Value)]) -> Result<Vec<Result<Value>>> {
        let result = (|| {
        self.check_fatal()?;
        if calls.is_empty() {
            return Ok(Vec::new());
        }
        let body: Vec<Value> = calls
            .iter()
            .enumerate()
            .map(|(id, (method, params))| {
                json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
            })
            .collect();
        let response = self.send_json(&Value::Array(body))?;
        let items = response
            .as_array()
            .ok_or_else(|| anyhow!("rpc batch: non-array response"))?;
        let mut by_id: HashMap<u64, &Value> = HashMap::new();
        for item in items {
            if let Some(id) = item.get("id").and_then(Value::as_u64) {
                if self.pinned && (id >= calls.len() as u64 || by_id.contains_key(&id)
                    || item.get("jsonrpc") != Some(&json!("2.0"))) { bail!("rpc batch identity mismatch"); }
                by_id.insert(id, item);
            } else if self.pinned { bail!("rpc batch identity missing");
            }
        }
        let results: Vec<Result<Value>> = (0..calls.len() as u64)
            .map(|id| match by_id.get(&id) {
                None => Err(anyhow!("rpc batch: missing response for id {id}")),
                Some(item) => {
                    if let Some(error) = item.get("error") {
                        Err(anyhow!(
                            "rpc batch error code {:?}",
                            error.get("code").and_then(Value::as_i64)
                        ))
                    } else {
                        let value = item.get("result")
                            .cloned()
                            .ok_or_else(|| anyhow!("rpc batch: missing result for id {id}"))?;
                        if self.pinned { validate_state_value(calls[id as usize].0, &value)?; }
                        Ok(value)
                    }
                }
            })
            .collect();
        if self.pinned && calls.iter().any(|(m, _)| *m != "debug_traceCall") && results.iter().any(Result::is_err) {
            for (index, result) in results.iter().enumerate() {
                if let Err(error) = result {
                    diagnostic::emit("rpc-batch-item", json!({"method":diagnostic::method(calls[index].0),
                        "itemIndex":index,"category":diagnostic::source_category(error)}));
                }
            }
            bail!("pinned state batch incomplete");
        }
        Ok(results)
        })();
        if calls.iter().all(|(m, _)| *m == "debug_traceCall") { result } else { self.checked_source(result) }
    }
}

fn source_selection_diagnostic(message: &str) -> bool {
    ["hash is not currently canonical", "header not found", "block not found",
        "unknown block", "state unavailable", "state is not available", "historical state unavailable"]
        .iter().any(|diagnostic| {
            message == *diagnostic || message.strip_prefix(diagnostic)
                .and_then(|suffix| suffix.strip_prefix(':'))
                .and_then(|suffix| suffix.trim().strip_prefix("0x"))
                .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()))
        })
}

fn strict_hex(value: &Value, bytes: Option<usize>) -> Result<&str> {
    let s = value.as_str().ok_or_else(|| anyhow!("invalid pinned hex"))?;
    let digits = s.strip_prefix("0x").ok_or_else(|| anyhow!("invalid pinned hex"))?;
    if !digits.bytes().all(|c| c.is_ascii_hexdigit()) || digits.len() % 2 != 0
        || bytes.is_some_and(|n| digits.len() != n * 2) { bail!("invalid pinned hex width"); }
    Ok(s)
}

fn strict_quantity(value: &Value, max_digits: usize) -> Result<&str> {
    let s = value.as_str().ok_or_else(|| anyhow!("invalid pinned quantity"))?;
    let d = s.strip_prefix("0x").ok_or_else(|| anyhow!("invalid pinned quantity"))?;
    if d.is_empty() || d.len() > max_digits || (d.len() > 1 && d.starts_with('0'))
        || !d.bytes().all(|c| c.is_ascii_hexdigit()) { bail!("invalid pinned quantity"); }
    Ok(s)
}

fn validate_state_value(method: &str, value: &Value) -> Result<()> {
    match method {
        "eth_getBalance" => { strict_quantity(value, 64)?; }
        "eth_getTransactionCount" | "eth_chainId" => { strict_quantity(value, 16)?; }
        "eth_getStorageAt" => { strict_hex(value, Some(32))?; }
        "eth_getCode" => {
            let bytes = parse_hex_bytes(strict_hex(value, None)?)?;
            Bytecode::new_raw_checked(Bytes::from(bytes)).map_err(|_| anyhow!("invalid pinned bytecode"))?;
        }
        _ => {}
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourcePin {
    chain_id: u64,
    block_hash: String,
    #[serde(default)]
    state_root: Option<String>,
}

fn deserialize_source_pin<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<SourcePin>, D::Error> {
    SourcePin::deserialize(d).map(Some) // Explicit null is not absence.
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceAttestation {
    kind: &'static str,
    chain_id: u64,
    block_number: u64,
    block_hash: B256,
    state_root: B256,
    parent_hash: B256,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VerifiedSource {
    attestation: SourceAttestation,
    env: BlockEnv,
    profile: MainnetProfile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MainnetProfile {
    spec: SpecId,
    blob_fraction: u64,
    max_block_blobs: u64,
}

fn mainnet_profile(timestamp: u64) -> Result<MainnetProfile> {
    // Same reviewed mainnet schedule as shared/state/ethereum-block-activity.ts,
    // geth 48a7c17281a617ddc0fac7bda277b3641e4c1fc0 params/config.go.
    // BPO constants also match locally installed alloy-eips eip7892. REVM has
    // Osaka but intentionally leaves network BPO scheduling to its caller.
    // No future fork inference: this profile needs review on consensus upgrades.
    if timestamp < 1_746_612_311 { bail!("unsupported pre-Prague pinned profile"); }
    let spec = if timestamp >= 1_764_798_551 { SpecId::OSAKA } else { SpecId::PRAGUE };
    let (blob_fraction, max_block_blobs) = if timestamp >= 1_767_747_671 {
        (11_684_671, 21)
    } else if timestamp >= 1_765_290_071 {
        (8_346_193, 15)
    } else { (5_007_716, 9) };
    Ok(MainnetProfile { spec, blob_fraction, max_block_blobs })
}

// Same integer exponential as REVM's BlobExcessGasAndPrice::new, with checked
// arithmetic: malformed remote quantities must reject, not overflow/panic or
// wrap in a release binary. No custom header hashing or proof verification.
fn pinned_blob_price(excess: u64, fraction: u64) -> Result<u128> {
    let denominator = u128::from(fraction);
    let mut term = denominator;
    let mut output = 0u128;
    let mut i = 1u128;
    while term > 0 {
        output = output.checked_add(term).ok_or_else(|| anyhow!("blob fee overflow"))?;
        term = term.checked_mul(u128::from(excess)).ok_or_else(|| anyhow!("blob fee overflow"))?
            / denominator.checked_mul(i).ok_or_else(|| anyhow!("blob fee overflow"))?;
        i += 1;
    }
    Ok(output / denominator)
}

fn header_identity(header: &Value, number: u64, hash: B256) -> Result<(B256, B256)> {
    if parse_u64(strict_quantity(&header["number"], 16)?)? != number
        || parse_b256(strict_hex(&header["hash"], Some(32))?)? != hash {
        bail!("pinned header identity mismatch");
    }
    Ok((parse_b256(strict_hex(&header["parentHash"], Some(32))?)?,
        parse_b256(strict_hex(&header["stateRoot"], Some(32))?)?))
}

fn verified_header(header: &Value, number: u64, pin: &SourcePin) -> Result<VerifiedSource> {
    let hash = parse_b256(strict_hex(&json!(pin.block_hash), Some(32))?)?;
    let (parent_hash, state_root) = header_identity(header, number, hash)?;
    if let Some(root) = &pin.state_root {
        if parse_b256(strict_hex(&json!(root), Some(32))?)? != state_root { bail!("pinned state root mismatch"); }
    }
    let quantity = |key: &str| parse_u64(strict_quantity(&header[key], 16)?);
    let mut env = BlockEnv::default();
    env.number = U256::from(number);
    env.timestamp = U256::from(quantity("timestamp")?);
    let profile = mainnet_profile(quantity("timestamp")?)?;
    env.gas_limit = quantity("gasLimit")?;
    if env.gas_limit == 0 || quantity("gasUsed")? > env.gas_limit { bail!("invalid pinned gas limits"); }
    env.basefee = quantity("baseFeePerGas")?;
    env.beneficiary = parse_address(strict_hex(&header["miner"], Some(20))?)?;
    env.prevrandao = Some(parse_b256(strict_hex(&header["mixHash"], Some(32))?)?);
    env.difficulty = parse_u256(strict_quantity(&header["difficulty"], 64)?)?;
    if !env.difficulty.is_zero() || strict_hex(&header["nonce"], Some(8))? != "0x0000000000000000"
        || strict_hex(&header["sha3Uncles"], Some(32))?.to_ascii_lowercase()
            != "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347"
        || header["uncles"].as_array().is_none_or(|u| !u.is_empty()) {
        bail!("invalid post-merge pinned header");
    }
    for key in ["transactionsRoot", "receiptsRoot", "withdrawalsRoot", "parentBeaconBlockRoot", "requestsHash"] {
        strict_hex(&header[key], Some(32))?;
    }
    strict_hex(&header["logsBloom"], Some(256))?;
    if strict_hex(&header["extraData"], None)?.len() > 66 { bail!("invalid pinned extraData"); }
    let blob_used = quantity("blobGasUsed")?;
    let excess = quantity("excessBlobGas")?;
    if blob_used % 131_072 != 0 || blob_used > profile.max_block_blobs * 131_072 {
        bail!("invalid pinned blob gas");
    }
    env.blob_excess_gas_and_price = Some(revm::context_interface::block::BlobExcessGasAndPrice {
        excess_blob_gas: excess, blob_gasprice: pinned_blob_price(excess, profile.blob_fraction)?,
    });
    Ok(VerifiedSource { env, profile, attestation: SourceAttestation { kind: "node-attested",
        chain_id: pin.chain_id, block_number: number, block_hash: hash, state_root, parent_hash } })
}

fn verify_source(rpc: &RpcClient, number: u64, pin: &SourcePin) -> Result<VerifiedSource> {
    let result = (|| {
        // Context::mainnet below is chain 1. Do not mislabel another chain.
        if pin.chain_id != 1 { bail!("pinned chain mismatch"); }
        let hash = strict_hex(&json!(pin.block_hash), Some(32))?.to_owned();
        let results = rpc.batch_call(&[
            ("eth_chainId", json!([])),
            ("eth_getBlockByHash", json!([hash, false])),
            ("eth_getBlockByNumber", json!([hex_quantity_u64(number), false])),
        ])?.into_iter().collect::<Result<Vec<_>>>()?;
        if parse_u64(strict_quantity(&results[0], 16)?)? != pin.chain_id { bail!("pinned chain mismatch"); }
        let source = verified_header(&results[1], number, pin)?;
        if verified_header(&results[2], number, pin)? != source { bail!("pinned canonical header changed"); }
        Ok(source)
    })();
    rpc.checked_source(result)
}

fn verify_canonical(rpc: &RpcClient, source: &VerifiedSource) -> Result<()> {
    let result = (|| {
        let att = &source.attestation;
        let header = rpc.call("eth_getBlockByNumber", json!([hex_quantity_u64(att.block_number), false]))?;
        let pin = SourcePin { chain_id: att.chain_id, block_hash: format!("{:#x}", att.block_hash),
            state_root: Some(format!("{:#x}", att.state_root)) };
        if verified_header(&header, att.block_number, &pin)? != *source { bail!("pinned canonical header changed"); }
        Ok(())
    })();
    rpc.checked_source(result)
}

fn build_http_client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(45))
        .pool_max_idle_per_host(8)
        .tcp_keepalive(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(300))
        .build()
        .context("failed to build blocking rpc client")
}

// All four checks are fresh and identity-bound. Even the equal-looking number
// lookups are separate logical calls: post(A) is never reused as pre(B).
fn verify_pair_bridge(rpc: &RpcClient, first: &VerifiedSource, number: u64, pin: &SourcePin) -> Result<VerifiedSource> {
    let result = (|| {
        if pin.chain_id != 1 { bail!("pinned chain mismatch"); }
        let hash = strict_hex(&json!(pin.block_hash), Some(32))?.to_owned();
        let att = &first.attestation;
        let results = rpc.batch_call(&[
            ("eth_getBlockByNumber", json!([hex_quantity_u64(att.block_number), false])),
            ("eth_chainId", json!([])),
            ("eth_getBlockByHash", json!([hash, false])),
            ("eth_getBlockByNumber", json!([hex_quantity_u64(number), false])),
        ])?.into_iter().collect::<Result<Vec<_>>>()?;
        let first_pin = SourcePin { chain_id: att.chain_id, block_hash: format!("{:#x}", att.block_hash),
            state_root: Some(format!("{:#x}", att.state_root)) };
        if verified_header(&results[0], att.block_number, &first_pin)? != *first {
            bail!("pinned canonical header changed");
        }
        if parse_u64(strict_quantity(&results[1], 16)?)? != pin.chain_id { bail!("pinned chain mismatch"); }
        let second = verified_header(&results[2], number, pin)?;
        if verified_header(&results[3], number, pin)? != second { bail!("pinned canonical header changed"); }
        Ok(second)
    })();
    rpc.checked_source(result)
}

/// Legacy unpinned calls retain their daemon-lifetime bytecode cache. Address
/// associations are NOT hash-stable: each pinned session owns a separate instance
/// and drops it on any endpoint/source change, along with state and slot hints.
#[derive(Debug, Default)]
struct PersistentCache {
    codes_by_addr: HashMap<Address, Bytecode>,
    codes_by_hash: HashMap<B256, Bytecode>,
}

#[derive(Debug)]
struct RemoteRevmDb {
    rpc: RpcClient,
    block_tag: Value,
    source: Option<VerifiedSource>,
    funded: HashSet<Address>,
    persist: Rc<RefCell<PersistentCache>>,
    inner: RefCell<RemoteRevmDbInner>,
}

#[derive(Debug, Default)]
struct RemoteRevmDbInner {
    accounts: HashMap<Address, Option<AccountInfo>>,
    codes_by_hash: HashMap<B256, Bytecode>,
    storage: HashMap<(Address, U256), U256>,
    block_hashes: HashMap<u64, B256>,
    ancestors: HashMap<u64, (B256, B256)>,
    missing_state_keys: Vec<String>,
    stats: CacheStats,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheStats {
    warm_hits: u64,
    cold_misses: u64,
}

impl CacheStats {
    fn delta_since(&self, before: &CacheStats) -> Self {
        Self {
            warm_hits: self.warm_hits.saturating_sub(before.warm_hits),
            cold_misses: self.cold_misses.saturating_sub(before.cold_misses),
        }
    }
}

/// What the trace-driven prefetch seeded into the warm cache during `prepare`.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeedStats {
    traced_calls: usize,
    trace_errors: usize,
    seeded_accounts: usize,
    seeded_slots: usize,
    trace_ms: u128,
    /// Sequential RPC round trips this whole `prepare` cost (the RPC-independent
    /// budget; wall time = round_trips × endpoint RTT).
    round_trips: u64,
}

#[derive(Debug)]
#[derive(Clone)]
struct ParsedPreCall {
    from: Address,
    to: Address,
    calldata: Vec<u8>,
    gas_limit: u64,
    allowance_slot: Option<u64>,
}

impl RemoteRevmDb {
    fn new(
        rpc_url: String,
        block_number: u64,
        funded: HashSet<Address>,
        persist: Rc<RefCell<PersistentCache>>,
        http: Client,
        fatal: FatalLatch,
    ) -> Result<Self> {
        Ok(Self {
            rpc: RpcClient::new(rpc_url, http, fatal)?,
            block_tag: json!(hex_quantity_u64(block_number)),
            source: None,
            funded,
            persist,
            inner: RefCell::new(RemoteRevmDbInner::default()),
        })
    }

    fn missing_state_keys(&self) -> Vec<String> {
        self.inner.borrow().missing_state_keys.clone()
    }

    fn stats(&self) -> CacheStats {
        self.inner.borrow().stats.clone()
    }

    fn rpc_call_db(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.rpc
            .call(method, params)
            .map_err(|err| RpcError(err.to_string()))
    }

    fn load_account(&self, address: Address) -> Result<Option<AccountInfo>, RpcError> {
        {
            let mut inner = self.inner.borrow_mut();
            if let Some(cached) = inner.accounts.get(&address).cloned() {
                inner.stats.warm_hits += 1;
                return Ok(cached);
            }
            inner.stats.cold_misses += 1;
        }

        // One batched round trip; code comes from the persistent cross-block
        // cache when this address was seen before (bytecode is block-stable).
        let address_hex = format!("{address:#x}");
        let known_code = self.persist.borrow().codes_by_addr.get(&address).cloned();
        let mut calls: Vec<(&str, Value)> = vec![
            ("eth_getBalance", json!([address_hex, self.block_tag])),
            (
                "eth_getTransactionCount",
                json!([address_hex, self.block_tag]),
            ),
        ];
        if known_code.is_none() {
            calls.push(("eth_getCode", json!([address_hex, self.block_tag])));
        }
        let results = self
            .rpc
            .batch_call(&calls)
            .map_err(|err| RpcError(err.to_string()))?;
        let take = |idx: usize| -> Result<Value, RpcError> {
            results
                .get(idx)
                .ok_or_else(|| RpcError(format!("batch result {idx} missing")))?
                .as_ref()
                .map_err(|err| RpcError(err.to_string()))
                .cloned()
        };

        let mut balance = parse_u256(value_as_str(&take(0)?)?)?;
        if self.funded.contains(&address) {
            balance = U256::MAX;
        }
        let nonce = parse_u64(value_as_str(&take(1)?)?).map_err(|err| RpcError(err.to_string()))?;
        let bytecode = match known_code {
            Some(code) => Some(code),
            None => {
                let code_bytes = parse_hex_bytes(value_as_str(&take(2)?)?)
                    .map_err(|err| RpcError(err.to_string()))?;
                if code_bytes.is_empty() {
                    None
                } else {
                    Some(Bytecode::new_raw(Bytes::from(code_bytes)))
                }
            }
        };

        let account = if balance.is_zero() && nonce == 0 && bytecode.is_none() {
            None
        } else {
            let mut info = AccountInfo::default()
                .with_balance(balance)
                .with_nonce(nonce);
            if let Some(bytecode) = bytecode {
                info = info.with_code(bytecode.clone());
                self.register_code(address, info.code_hash, bytecode);
            }
            Some(info)
        };

        self.inner
            .borrow_mut()
            .accounts
            .insert(address, account.clone());
        Ok(account)
    }

    fn register_code(&self, address: Address, code_hash: B256, bytecode: Bytecode) {
        self.inner
            .borrow_mut()
            .codes_by_hash
            .insert(code_hash, bytecode.clone());
        let mut persist = self.persist.borrow_mut();
        persist.codes_by_hash.insert(code_hash, bytecode.clone());
        persist.codes_by_addr.insert(address, bytecode);
    }

    /// Seed an account read from a prestate trace. No-op when already cached
    /// (trace values equal fetched values at the same block). Returns whether
    /// a new entry was written.
    fn seed_account(
        &self,
        address: Address,
        balance: U256,
        nonce: u64,
        bytecode: Option<Bytecode>,
    ) -> bool {
        if self.inner.borrow().accounts.contains_key(&address) {
            return false;
        }
        let balance = if self.funded.contains(&address) {
            U256::MAX
        } else {
            balance
        };
        let account = if balance.is_zero() && nonce == 0 && bytecode.is_none() {
            None
        } else {
            let mut info = AccountInfo::default()
                .with_balance(balance)
                .with_nonce(nonce);
            if let Some(bytecode) = bytecode {
                info = info.with_code(bytecode.clone());
                self.register_code(address, info.code_hash, bytecode);
            }
            Some(info)
        };
        self.inner.borrow_mut().accounts.insert(address, account);
        true
    }

    /// Seed a storage slot read from a prestate trace. Returns whether a new
    /// entry was written.
    fn seed_storage(&self, address: Address, slot: U256, value: U256) -> bool {
        let mut inner = self.inner.borrow_mut();
        if inner.storage.contains_key(&(address, slot)) {
            return false;
        }
        inner.storage.insert((address, slot), value);
        true
    }

    /// Warm a named set of accounts and (address, slot) storage keys in ONE
    /// batched round trip, optionally also fetching the block header so the
    /// block env comes for free in the same trip. Used at the top of `prepare`
    /// so the deal-slot trials, funding, and approve don't each serial-fault.
    /// Already-cached keys are skipped (no RPC entry emitted) so cross-block
    /// code reuse stays cheap.
    fn warm_batch(
        &self,
        accounts: &[Address],
        storage: &[(Address, U256)],
        fetch_block: Option<u64>,
    ) -> Result<Option<BlockEnv>> {
        let result = self.warm_batch_inner(accounts, storage, fetch_block);
        self.rpc.checked_source(result)
    }

    fn warm_batch_inner(&self, accounts: &[Address], storage: &[(Address, U256)], fetch_block: Option<u64>) -> Result<Option<BlockEnv>> {
        let mut calls: Vec<(&str, Value)> = Vec::new();
        // (kind, key) parallel to `calls`, for routing results back.
        enum Slot {
            Block,
            Balance(Address),
            Nonce(Address),
            Code(Address),
            Storage(Address, U256),
        }
        let mut slots: Vec<Slot> = Vec::new();

        if let Some(block_number) = fetch_block {
            if self.source.is_some() { bail!("numeric pinned warm header forbidden"); }
            calls.push((
                "eth_getBlockByNumber",
                json!([hex_quantity_u64(block_number), false]),
            ));
            slots.push(Slot::Block);
        }

        for &address in accounts {
            if self.inner.borrow().accounts.contains_key(&address) {
                continue;
            }
            let addr_hex = format!("{address:#x}");
            calls.push(("eth_getBalance", json!([addr_hex, self.block_tag])));
            slots.push(Slot::Balance(address));
            calls.push(("eth_getTransactionCount", json!([addr_hex, self.block_tag])));
            slots.push(Slot::Nonce(address));
            if !self.persist.borrow().codes_by_addr.contains_key(&address) {
                calls.push(("eth_getCode", json!([addr_hex, self.block_tag])));
                slots.push(Slot::Code(address));
            }
        }
        for &(address, slot) in storage {
            if self.inner.borrow().storage.contains_key(&(address, slot)) {
                continue;
            }
            calls.push((
                "eth_getStorageAt",
                json!([
                    format!("{address:#x}"),
                    format!("{slot:#x}"),
                    self.block_tag
                ]),
            ));
            slots.push(Slot::Storage(address, slot));
        }
        if calls.is_empty() {
            return Ok(None);
        }

        let results = self.rpc.batch_call(&calls)?;
        let mut block_env = None;
        // Assemble account fields, then commit whole accounts once.
        let mut acc: HashMap<Address, (U256, u64, Option<Bytecode>, bool, bool, bool)> =
            HashMap::new();
        for (slot, result) in slots.iter().zip(results.into_iter()) {
            let value = match result {
                Ok(v) => v,
                Err(_) => continue,
            };
            match slot {
                Slot::Block => {
                    if let Some(number) = fetch_block {
                        block_env = Some(block_env_from_value(&value, number)?);
                    }
                }
                Slot::Balance(address) => {
                    let bal = parse_u256(value_as_str(&value).map_err(|e| anyhow!(e.to_string()))?)
                        .map_err(|e| anyhow!(e.to_string()))?;
                    let e =
                        acc.entry(*address)
                            .or_insert((U256::ZERO, 0, None, false, false, false));
                    e.0 = bal;
                    e.3 = true;
                }
                Slot::Nonce(address) => {
                    let nonce =
                        parse_u64(value_as_str(&value).map_err(|e| anyhow!(e.to_string()))?)?;
                    let e =
                        acc.entry(*address)
                            .or_insert((U256::ZERO, 0, None, false, false, false));
                    e.1 = nonce;
                    e.4 = true;
                }
                Slot::Code(address) => {
                    let bytes =
                        parse_hex_bytes(value_as_str(&value).map_err(|e| anyhow!(e.to_string()))?)?;
                    let code = if bytes.is_empty() {
                        None
                    } else {
                        Some(Bytecode::new_raw(Bytes::from(bytes)))
                    };
                    let e =
                        acc.entry(*address)
                            .or_insert((U256::ZERO, 0, None, false, false, false));
                    e.2 = code;
                    e.5 = true;
                }
                Slot::Storage(address, key) => {
                    let v = parse_u256(value_as_str(&value).map_err(|e| anyhow!(e.to_string()))?)
                        .map_err(|e| anyhow!(e.to_string()))?;
                    self.seed_storage(*address, *key, v);
                }
            }
        }
        for (address, (balance, nonce, code, has_bal, has_nonce, has_code)) in acc {
            // Only seed accounts we fully resolved balance+nonce for; code may
            // come from the persistent cache instead of this batch.
            if !(has_bal && has_nonce) {
                if self.source.is_some() { bail!("incomplete pinned account"); }
                continue;
            }
            if self.source.is_some() && !has_code && !self.persist.borrow().codes_by_addr.contains_key(&address) {
                bail!("missing pinned account code");
            }
            let code = if has_code {
                code
            } else {
                self.persist.borrow().codes_by_addr.get(&address).cloned()
            };
            self.seed_account(address, balance, nonce, code);
        }
        Ok(block_env)
    }
}

impl DatabaseRef for RemoteRevmDb {
    type Error = RpcError;

    fn basic_ref(&self, address: Address) -> Result<Option<AccountInfo>, Self::Error> {
        let result = self.load_account(address).map_err(anyhow::Error::from);
        self.rpc.checked_source(result).map_err(|e| RpcError(e.to_string()))
    }

    fn code_by_hash_ref(&self, code_hash: B256) -> Result<Bytecode, Self::Error> {
        self.rpc.check_fatal().map_err(|e| RpcError(e.to_string()))?;
        {
            let mut inner = self.inner.borrow_mut();
            if let Some(code) = inner.codes_by_hash.get(&code_hash).cloned() {
                inner.stats.warm_hits += 1;
                return Ok(code);
            }
            inner.stats.cold_misses += 1;
        }
        if let Some(code) = self.persist.borrow().codes_by_hash.get(&code_hash).cloned() {
            self.inner
                .borrow_mut()
                .codes_by_hash
                .insert(code_hash, code.clone());
            return Ok(code);
        }
        self.inner
            .borrow_mut()
            .missing_state_keys
            .push(format!("code_hash:{code_hash:#x}"));
        if self.source.is_some() {
            diagnostic::emit("source-code-cache", json!({"category":"missing-code-hash","codeHash":format!("{code_hash:#x}")}));
            self.rpc.latch(FatalReason::SourceFault);
        }
        Err(RpcError(format!("code not cached for hash {code_hash:#x}")))
    }

    fn storage_ref(&self, address: Address, index: U256) -> Result<U256, Self::Error> {
        self.rpc.check_fatal().map_err(|e| RpcError(e.to_string()))?;
        {
            let mut inner = self.inner.borrow_mut();
            if let Some(value) = inner.storage.get(&(address, index)).copied() {
                inner.stats.warm_hits += 1;
                return Ok(value);
            }
            inner.stats.cold_misses += 1;
        }
        let value = self.rpc_call_db(
            "eth_getStorageAt",
            json!([
                format!("{address:#x}"),
                format!("{index:#x}"),
                self.block_tag
            ]),
        )?;
        let value = parse_u256(value_as_str(&value)?)?;
        self.inner
            .borrow_mut()
            .storage
            .insert((address, index), value);
        Ok(value)
    }

    fn block_hash_ref(&self, number: u64) -> Result<B256, Self::Error> {
        if let Some(source) = &self.source {
            let current = source.attestation.block_number;
            if number >= current || current - number > 256 { return Ok(B256::ZERO); }
            let result = (|| {
                self.rpc.check_fatal()?;
                if let Some((hash, _)) = self.inner.borrow().ancestors.get(&number) { return Ok(*hash); }
                let (mut height, mut parent) = self.inner.borrow().ancestors.iter()
                    .filter(|(height, _)| **height > number).min_by_key(|(height, _)| **height)
                    .map(|(height, (_, parent))| (*height, *parent)).expect("pinned root seeded");
                while height > number {
                    height -= 1;
                    let header = self.rpc.call("eth_getBlockByHash", json!([format!("{parent:#x}"), false]))?;
                    let (next_parent, _) = header_identity(&header, height, parent)?;
                    self.inner.borrow_mut().ancestors.insert(height, (parent, next_parent));
                    parent = next_parent;
                }
                Ok(self.inner.borrow().ancestors[&number].0)
            })();
            return self.rpc.checked_source(result).map_err(|e| RpcError(e.to_string()));
        }
        {
            let mut inner = self.inner.borrow_mut();
            if let Some(hash) = inner.block_hashes.get(&number).copied() {
                inner.stats.warm_hits += 1;
                return Ok(hash);
            }
            inner.stats.cold_misses += 1;
        }
        let block = self.rpc_call_db(
            "eth_getBlockByNumber",
            json!([hex_quantity_u64(number), false]),
        )?;
        let hash =
            parse_b256(value_as_str(block.get("hash").ok_or_else(|| {
                RpcError(format!("block {number} missing hash"))
            })?)?)?;
        self.inner.borrow_mut().block_hashes.insert(number, hash);
        Ok(hash)
    }
}

/// Shareable handle to a warm `RemoteRevmDb` so many per-hint `CacheDB`s can be
/// stacked on the same fetched chain state without re-reading from the RPC. The
/// daemon keeps one of these alive per block; each request builds a fresh
/// `CacheDB::new(SharedRemote(rc.clone()))` whose mutations stay request-local
/// while reads fall through to the shared, warm `RemoteRevmDb` cache.
#[derive(Debug, Clone)]
struct SharedRemote(Rc<RemoteRevmDb>);

// Carry the verified profile through every nested balance/probe/preCall/main
// execution without a global setting or changing legacy unpinned semantics.
trait ExecutionProfile: DatabaseRef<Error = RpcError> {
    fn execution_profile(&self) -> Option<MainnetProfile>;
}

impl ExecutionProfile for RemoteRevmDb {
    fn execution_profile(&self) -> Option<MainnetProfile> { self.source.as_ref().map(|s| s.profile) }
}

impl ExecutionProfile for SharedRemote {
    fn execution_profile(&self) -> Option<MainnetProfile> { self.0.execution_profile() }
}

impl<D: ExecutionProfile> ExecutionProfile for CacheDB<D> {
    fn execution_profile(&self) -> Option<MainnetProfile> { self.db.execution_profile() }
}

impl<D: ExecutionProfile + ?Sized> ExecutionProfile for &D {
    fn execution_profile(&self) -> Option<MainnetProfile> { (**self).execution_profile() }
}

impl SharedRemote {
    fn missing_state_keys(&self) -> Vec<String> {
        self.0.missing_state_keys()
    }

    fn stats(&self) -> CacheStats {
        self.0.stats()
    }
}

impl DatabaseRef for SharedRemote {
    type Error = RpcError;

    fn basic_ref(&self, address: Address) -> Result<Option<AccountInfo>, Self::Error> {
        self.0.basic_ref(address)
    }

    fn code_by_hash_ref(&self, code_hash: B256) -> Result<Bytecode, Self::Error> {
        self.0.code_by_hash_ref(code_hash)
    }

    fn storage_ref(&self, address: Address, index: U256) -> Result<U256, Self::Error> {
        self.0.storage_ref(address, index)
    }

    fn block_hash_ref(&self, number: u64) -> Result<B256, Self::Error> {
        self.0.block_hash_ref(number)
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Health => {
            println!(
                "{}",
                serde_json::to_string(&json!({
                    "ok": true,
                    "engine": "revm",
                    "implemented": true
                }))?
            );
            Ok(())
        }
        Command::Simulate { input } => {
            let started = Instant::now();
            let text = fs::read_to_string(&input)
                .with_context(|| format!("failed to read {}", input.display()))?;
            let req: SimRequest = serde_json::from_str(&text)
                .with_context(|| format!("failed to parse {}", input.display()))?;
            let response = match simulate(req, started) {
                Ok(response) => response,
                Err(err) => SimResponse {
                    success: false,
                    profit: "0".to_string(),
                    gas_used: "0".to_string(),
                    revert_reason: Some(err.to_string()),
                    latency_ms: started.elapsed().as_millis(),
                    missing_state_keys: Vec::new(),
                },
            };
            println!("{}", serde_json::to_string_pretty(&response)?);
            Ok(())
        }
        Command::Serve => serve(),
    }
}

fn simulate(req: SimRequest, started: Instant) -> Result<SimResponse> {
    let rpc_url = req
        .rpc_url
        .or_else(|| env::var("MAINNET_RPC_URL").ok())
        .ok_or_else(|| anyhow!("MAINNET_RPC_URL is required for revm-sim"))?;

    let executor = parse_address(&req.executor)?;
    let owner = parse_address(&req.owner)?;
    let profit_token = parse_address(&req.profit_token)?;
    let calldata = Bytes::from(parse_hex_bytes(&req.calldata)?);
    let gas_limit = req.gas_limit.unwrap_or(DEFAULT_GAS_LIMIT);
    let pre_calls = parse_pre_calls(&req.pre_calls)?;

    let funded = funded_accounts(owner, &pre_calls);
    let remote = RemoteRevmDb::new(
        rpc_url,
        req.block_number,
        funded,
        Rc::new(RefCell::new(PersistentCache::default())),
        build_http_client()?,
        FatalLatch::default(),
    )?;
    let block_env = load_block_env(&remote.rpc, req.block_number)?;
    let mut db = CacheDB::new(remote);
    let mut balance_slots = HashMap::new();
    apply_state_overrides(&mut db, &req.state_overrides)?;
    apply_token_deals(
        &mut db,
        &block_env,
        &req.token_deals,
        &mut balance_slots,
        None,
        false,
    )?;
    for call in pre_calls {
        let pre = execute_call(
            &mut db,
            &block_env,
            call.from,
            call.to,
            Bytes::from(call.calldata),
            call.gas_limit,
            true,
            false,
        )?;
        if !pre.result.is_success() {
            bail!("preCall failed: {}", format_execution_result(&pre.result));
        }
        db.commit(pre.state);
    }

    let pre = erc20_balance_of(&mut db, &block_env, profit_token, executor)?;
    let main = execute_call(
        &mut db, &block_env, owner, executor, calldata, gas_limit, true, false,
    )?;
    let gas_used = main.result.tx_gas_used();
    let success = main.result.is_success();
    let revert_reason = if success {
        None
    } else {
        Some(format_execution_result(&main.result))
    };
    if success {
        db.commit(main.state);
    }
    let post = erc20_balance_of(&mut db, &block_env, profit_token, executor)?;
    let profit = post.saturating_sub(pre);

    db.db.rpc.check_fatal()?;
    Ok(SimResponse {
        success: success && profit > U256::ZERO,
        profit: profit.to_string(),
        gas_used: gas_used.to_string(),
        revert_reason,
        latency_ms: started.elapsed().as_millis(),
        missing_state_keys: db.db.missing_state_keys(),
    })
}

// ─── Resident daemon ──────────────────────────────────────────────
//
// Protocol: one JSON request object per stdin line, one JSON response per
// stdout line (strictPair streams two child responses). The daemon holds a per-block warm `RemoteRevmDb` (shared chain
// reads) and a `prepared` `CacheDB` carrying the victim overlay for the current
// hint. `quote`/`simulate` clone the prepared base so each call is isolated but
// every chain read after the first is served from the warm cache.

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum DaemonRequest {
    Health,
    Reset,
    #[serde(rename_all = "camelCase")]
    Prepare {
        block_number: u64,
        #[serde(default)]
        rpc_url: Option<String>,
        #[serde(default)]
        funded: Vec<String>,
        #[serde(default)]
        state_overrides: Vec<StateOverride>,
        #[serde(default)]
        token_deals: Vec<TokenDeal>,
        #[serde(default)]
        pre_calls: Vec<PreCall>,
        #[serde(default)]
        prewarm: Vec<String>,
        /// View calls (e.g. route-hop quoter calls) traced alongside the last
        /// preCall so the solver's first quotes start warm. Results discarded.
        #[serde(default)]
        prewarm_calls: Vec<PreCall>,
    },
    /// Proactive per-block warm of recurring hot pools: ensure the block is
    /// forked, then trace a representative quote view-call per pool so its slots
    /// are already in the warm cache when a hint's prepare/solve touches them.
    /// No overlay — pure reads against real chain state.
    #[serde(rename_all = "camelCase")]
    Warm {
        block_number: u64,
        #[serde(default)]
        rpc_url: Option<String>,
        #[serde(default)]
        prewarm: Vec<String>,
        #[serde(default)]
        token_balance_hints: Vec<TokenBalanceHint>,
        #[serde(default)]
        token_allowance_hints: Vec<TokenAllowanceHint>,
        #[serde(default)]
        prewarm_calls: Vec<PreCall>,
    },
    #[serde(rename_all = "camelCase")]
    Quote {
        #[serde(default)]
        from: Option<String>,
        to: String,
        data: String,
        #[serde(default)]
        gas_limit: Option<u64>,
    },
    StrictSimulate(StrictRequest),
    #[serde(rename_all = "camelCase")]
    Simulate {
        owner: String,
        executor: String,
        calldata: String,
        profit_token: String,
        #[serde(default)]
        gas_limit: Option<u64>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrictRequest {
    block_number: u64,
    #[serde(default, deserialize_with = "deserialize_source_pin")]
    source_pin: Option<SourcePin>,
    #[serde(default, deserialize_with = "deserialize_executor_runtime_code")]
    executor_runtime_code: Option<ExecutorRuntimeCode>,
    #[serde(default, deserialize_with = "deserialize_trial_prefix")]
    trial_prefix: Option<StrictTrialPrefix>,
    #[serde(default, deserialize_with = "deserialize_state_read")]
    state_read: Option<StrictStateRead>,
    rpc_url: Option<String>,
    from: String,
    to: String,
    data: String,
    gas_limit: Option<u64>,
    execution_gas_limit: Option<u64>,
    transaction_origin: Option<String>,
    native_balance_wei: Option<String>,
    observe_token_balances: Option<Vec<ExactTokenObservation>>,
    observe_native_balances: Option<Vec<String>>,
    observe_tokens: Option<Vec<String>>,
    observe_accounts: Option<Vec<String>>,
    #[serde(default)]
    observe_total_supply: Vec<String>,
    #[serde(default)]
    observe_logs: bool,
    #[serde(default)]
    pre_calls: Vec<PreCall>,
    #[serde(default)]
    token_deals: Vec<TokenDeal>,
    caller_mode: Option<String>,
}

const STRICT_PAIR_MAX_BYTES: usize = 1_048_576;

struct StrictPair {
    epoch: String,
    ids: [u64; 2],
    requests: [StrictRequest; 2],
    plans: [StrictPlan; 2],
}

impl StrictPair {
    fn validate(mut value: Value, bytes: usize) -> Result<Self> {
        fn has_null(value: &Value) -> bool {
            match value {
                Value::Null => true,
                Value::Array(items) => items.iter().any(has_null),
                Value::Object(fields) => fields.values().any(has_null),
                _ => false,
            }
        }
        if bytes > STRICT_PAIR_MAX_BYTES || has_null(&value) { bail!("bad strict pair"); }
        let object = value.as_object_mut().ok_or_else(|| anyhow!("bad strict pair"))?;
        if object.len() != 3 || object.get("op").and_then(Value::as_str) != Some("strictPair") {
            bail!("bad strict pair");
        }
        let epoch = object.get("epoch").and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 128).ok_or_else(|| anyhow!("bad strict pair"))?.to_owned();
        let children = object.remove("requests").and_then(|v| v.as_array().cloned())
            .ok_or_else(|| anyhow!("bad strict pair"))?;
        let [mut a, mut b]: [Value; 2] = children.try_into().map_err(|_| anyhow!("bad strict pair"))?;
        // Conservative equality of the entire shared wire context. Only main
        // target/data/stateRead and child identity may differ.
        for key in ["blockNumber", "rpcUrl", "sourcePin", "trialPrefix", "from", "transactionOrigin",
            "callerMode", "gasLimit", "executionGasLimit"] {
            if a.get(key) != b.get(key) { bail!("bad strict pair"); }
        }
        let parse = |child: &mut Value| -> Result<(u64, StrictRequest, StrictPlan)> {
            let object = child.as_object_mut().ok_or_else(|| anyhow!("bad strict pair"))?;
            let id = object.remove("requestId").and_then(|v| v.as_str().map(str::to_owned))
                .ok_or_else(|| anyhow!("bad strict pair"))?;
            let number = id.parse::<u64>()?;
            if number == 0 || number.to_string() != id { bail!("bad strict pair"); }
            let req: StrictRequest = serde_json::from_value(child.take())?;
            let plan = StrictPlan::validate(&req)?;
            let pin = req.source_pin.as_ref().ok_or_else(|| anyhow!("bad strict pair"))?;
            if pin.chain_id != 1 || req.rpc_url.as_ref().is_none_or(|s| s.trim().is_empty()) {
                bail!("bad strict pair");
            }
            strict_hex(&json!(pin.block_hash), Some(32))?;
            if let Some(root) = &pin.state_root { strict_hex(&json!(root), Some(32))?; }
            if !plan.inner || req.trial_prefix.is_none() || !req.pre_calls.is_empty() || !req.token_deals.is_empty()
                || req.native_balance_wei.is_some() || req.executor_runtime_code.is_some() || req.observe_logs
                || !req.observe_total_supply.is_empty() || !plan.native.is_empty() || !plan.pairs.is_empty()
                || !req.observe_accounts.as_deref().unwrap_or(&[]).is_empty() {
                bail!("bad strict pair");
            }
            Ok((number, req, plan))
        };
        let (a_id, a, a_plan) = parse(&mut a)?;
        let (b_id, b, b_plan) = parse(&mut b)?;
        if a_id >= b_id { bail!("bad strict pair"); }
        Ok(Self { epoch, ids: [a_id, b_id], requests: [a, b], plans: [a_plan, b_plan] })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExactTokenObservation { token: String, account: String }

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutorRuntimeCode { code: String, keccak256: String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrictTrialPrefix {
    executor: String,
    calldata: String,
    input_token: String,
    input_amount: String,
    #[serde(default, deserialize_with = "deserialize_executor_runtime_code")]
    executor_runtime_code: Option<ExecutorRuntimeCode>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum StrictStateRead {
    #[serde(rename = "get-storage")]
    Storage { address: String, slot: String },
    #[serde(rename = "get-code")]
    Code { address: String },
}

fn deserialize_trial_prefix<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<StrictTrialPrefix>, D::Error> {
    StrictTrialPrefix::deserialize(d).map(Some)
}

fn deserialize_state_read<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<StrictStateRead>, D::Error> {
    StrictStateRead::deserialize(d).map(Some)
}

fn deserialize_executor_runtime_code<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<ExecutorRuntimeCode>, D::Error> {
    ExecutorRuntimeCode::deserialize(d).map(Some)
}

#[derive(Debug, Serialize)]
struct CounterfactualExecutorCode { address: String, keccak256: String }

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum StrictFailureKind { Validation, Execution, Observation }
#[derive(Debug)]
struct StrictFailure(StrictFailureKind);
impl fmt::Display for StrictFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "strict {:?} failure", self.0) }
}
impl std::error::Error for StrictFailure {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonResponseEnvelope {
    // Missing/invalid framing has no usable identity and must poison the client.
    epoch: Option<String>,
    request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fatal: Option<FatalReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_attestation: Option<SourceAttestation>,
    #[serde(flatten)]
    response: DaemonResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_kind: Option<StrictFailureKind>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gas_used: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revert_reason: Option<String>,
    latency_ms: u128,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    missing_state_keys: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_stats: Option<CacheStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    seed_stats: Option<SeedStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    strict: Option<StrictSimulateEffects>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StrictSimulateEffects {
    #[serde(skip_serializing_if = "Option::is_none")]
    counterfactual_executor_code: Option<CounterfactualExecutorCode>,
    outcome: StrictOutcome,
    execution_gas_used: String,
    native_deltas: Vec<SimNativeDelta>,
    token_deltas: Vec<SimTokenDelta>,
    total_supply_deltas: Vec<SimTotalSupplyDelta>,
    logs: Vec<SimLog>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
enum StrictOutcome {
    Success { output: String, #[serde(flatten)] stage: StrictStage },
    Revert { output: String, #[serde(flatten)] stage: StrictStage },
    Halt { reason: String, #[serde(flatten)] stage: StrictStage },
}
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "phase")]
enum StrictStage {
    #[serde(rename = "main")]
    Main,
    #[serde(rename = "preCall")]
    PreCall { #[serde(rename = "preCallIndex")] index: usize },
}
#[derive(Debug, Serialize)]
struct SimNativeDelta { account: String, before: String, after: String, delta: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SimTokenDelta {
    token: String,
    account: String,
    delta: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SimTotalSupplyDelta {
    token: String,
    delta: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SimLog {
    address: String,
    topics: Vec<String>,
    data: String,
}

impl DaemonResponse {
    fn err(message: String, started: Instant) -> Self {
        Self {
            ok: false,
            error: Some(message),
            success: None,
            output: None,
            profit: None,
            gas_used: None,
            revert_reason: None,
            latency_ms: started.elapsed().as_millis(),
            missing_state_keys: Vec::new(),
            cache_stats: None,
            seed_stats: None,
            strict: None,
        }
    }
}

struct WarmBlock {
    number: u64,
    remote: Rc<RemoteRevmDb>,
    /// Lazily populated: a fresh block defers the block header fetch so it can
    /// be batched with the prepare's account/slot warm-up (one round trip, not
    /// two). `prepare` fills this on first use via `ensure_block_env`.
    block_env: Option<BlockEnv>,
    /// True once a between-block Warm has seeded accounts/storage for this
    /// block. A later prepare on the same block can skip debug_traceCall
    /// prefetch and let local execution read the already-hot cache directly.
    proactive_seeded: bool,
}

struct PinnedSession {
    remote: Rc<RemoteRevmDb>,
    balance_slots: HashMap<Address, u64>,
    allowance_slots: HashMap<Address, u64>,
}

#[derive(Default)]
struct Daemon {
    last_strict_error: Option<StrictFailureKind>,
    epoch: Option<String>,
    last_request_id: u64,
    // Shared by every RemoteRevmDb, including after reset/new block/cache reuse.
    fatal: FatalLatch,
    pinned: Option<PinnedSession>,
    last_source_attestation: Option<SourceAttestation>,
    warm: Option<WarmBlock>,
    prepared: Option<CacheDB<SharedRemote>>,
    block_env: Option<BlockEnv>,
    /// Discovered ERC20 mapping base slots. Unknown tokens are probed once in
    /// the local overlay; a hit is cached so later same-daemon prepares/warms do
    /// not serial-try every candidate slot again.
    balance_slots: HashMap<Address, u64>,
    allowance_slots: HashMap<Address, u64>,
    /// Cross-block cache (contract bytecode). Survives `ensure_warm` re-forks so
    /// a new block never re-downloads router/pool/token code.
    persist: Rc<RefCell<PersistentCache>>,
    /// Daemon-lifetime HTTP client. Clones share reqwest's connection pool, so
    /// new blocks no longer rebuild the TCP/TLS/proxy tunnel.
    http: Option<Client>,
}

fn write_daemon_response(out: &mut impl IoWrite, response: &DaemonResponseEnvelope) -> Result<()> {
    serde_json::to_writer(&mut *out, response)?;
    out.write_all(b"\n")?;
    out.flush()?;
    Ok(())
}

fn serve() -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut daemon = Daemon::default();

    for line in stdin.lock().lines() {
        let line = line.context("failed reading daemon stdin")?;
        if line.trim().is_empty() {
            continue;
        }
        daemon.handle_line_streaming(&line,
            env::var("SEARCHER_STATE_LATENCY_DIAGNOSTICS").is_ok_and(|value| value == "1"), &mut stdout)?;
    }
    Ok(())
}

impl Daemon {
    #[cfg(test)]
    fn handle_line(&mut self, line: &str) -> DaemonResponseEnvelope {
        self.handle_line_with_diagnostics(line,
            env::var("SEARCHER_STATE_LATENCY_DIAGNOSTICS").is_ok_and(|value| value == "1"))
    }

    #[cfg(test)]
    fn handle_line_with_diagnostics(&mut self, line: &str, diagnostics: bool) -> DaemonResponseEnvelope {
        let started = Instant::now();
        self.handle_value_with_diagnostics(serde_json::from_str::<Value>(line).unwrap_or(Value::Null), diagnostics, started)
    }

    fn handle_line_streaming(&mut self, line: &str, diagnostics: bool, out: &mut impl IoWrite) -> Result<()> {
        let started = Instant::now();
        let value = serde_json::from_str::<Value>(line).unwrap_or(Value::Null);
        if value.get("op").and_then(Value::as_str) == Some("strictPair") {
            let epoch = value.get("epoch").and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= 128).map(str::to_owned);
            match StrictPair::validate(value, line.len()) {
                Ok(pair) if self.epoch.as_ref().is_none_or(|bound| bound == &pair.epoch)
                    && pair.ids[0] > self.last_request_id => {
                    self.epoch = Some(pair.epoch.clone());
                    self.last_request_id = pair.ids[1]; // Reserve both once, before any I/O.
                    self.strict_pair(pair, started, diagnostics, out)
                }
                _ => write_daemon_response(out, &self.pair_response(epoch, None,
                    Err(StrictFailure(StrictFailureKind::Validation).into()), None, started)),
            }
        } else {
            write_daemon_response(out, &self.handle_value_with_diagnostics(value, diagnostics, started))
        }
    }

    fn handle_value_with_diagnostics(&mut self, mut value: Value, diagnostics: bool, started: Instant) -> DaemonResponseEnvelope {
        self.last_source_attestation = None;
        self.last_strict_error = None;
        let strict_request = value.get("op").and_then(Value::as_str) == Some("strictSimulate");
        let epoch = value
            .get("epoch")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .map(str::to_owned);
        let request_id = value
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|s| {
                s.parse::<u64>()
                    .is_ok_and(|id| id > 0 && id.to_string() == *s)
            })
            .map(str::to_owned);
        diagnostic::begin_strict(diagnostics && strict_request, started);
        let timing_identity = (diagnostics && strict_request).then(|| diagnostic::StrictTimingIdentity {
            request_id: request_id.as_deref().and_then(|id| id.parse().ok()),
            source_block: value.get("blockNumber").and_then(Value::as_u64),
            prefix_present: value.get("trialPrefix").is_some(),
            prefix_calldata_bytes: value.get("trialPrefix").and_then(|prefix| prefix.get("calldata"))
                .and_then(Value::as_str).and_then(|data| data.strip_prefix("0x"))
                .filter(|data| data.len() % 2 == 0 && data.bytes().all(|b| b.is_ascii_hexdigit()))
                .map(|data| data.len() / 2),
        });
        if let Some(identity) = &timing_identity { diagnostic::bind_strict_identity(identity, started); }
        let response = match (&epoch, &request_id) {
            (Some(epoch), Some(id)) => {
                let id = id.parse::<u64>().expect("validated above");
                if self.epoch.as_ref().is_some_and(|bound| bound != epoch)
                    || id <= self.last_request_id
                {
                    DaemonResponse::err("request identity violation".into(), started)
                } else {
                    self.epoch = Some(epoch.clone());
                    self.last_request_id = id;
                    let illegal_pin = value.get("sourcePin").is_some()
                        && (value.get("op").and_then(Value::as_str) != Some("strictSimulate")
                            || value["sourcePin"].get("stateRoot").is_some_and(Value::is_null));
                    // Envelope identity is not part of the strict execution contract.
                    let null_strict_field = strict_request && (value.as_object().is_some_and(|v| v.values().any(Value::is_null))
                        || [("preCalls", &["from", "to", "calldata", "gasLimit", "allowanceSlot"][..]),
                            ("tokenDeals", &["token", "to", "amount", "balanceSlot"][..])].iter().any(|(field, keys)| {
                            value.get(field).and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| {
                                item.as_object().is_none_or(|object| object.iter().any(|(key, val)| !keys.contains(&key.as_str()) || val.is_null()))
                            }))
                        }));
                    if let Some(object) = value.as_object_mut() { object.remove("epoch"); object.remove("requestId"); }
                    match if illegal_pin || null_strict_field { Err(serde::de::Error::custom("invalid source pin")) }
                        else { serde_json::from_value::<DaemonRequest>(value) } {
                        Ok(req) => self.handle(req, started),
                        // Do not echo serde's untrusted field values (including URLs).
                        Err(_) => DaemonResponse::err("bad daemon request".into(), started),
                    }
                }
            }
            _ => DaemonResponse::err("bad request envelope".into(), started),
        };
        let fatal = self.fatal.get();
        if fatal.is_some() {
            // Numeric request identity only; epoch is caller-provided text.
            diagnostic::emit("daemon-response", json!({"requestId":request_id.as_deref().and_then(|id| id.parse::<u64>().ok()),
                "fatal":fatal}));
        }
        if let Some(identity) = timing_identity {
            diagnostic::finish_strict(identity, fatal.is_none() && response.ok,
                if fatal.is_none() { response.success } else { None }, fatal.is_some());
        }
        DaemonResponseEnvelope {
            epoch,
            request_id,
            error_kind: if strict_request && !response.ok && fatal.is_none() {
                Some(self.last_strict_error.unwrap_or(StrictFailureKind::Validation))
            } else { None },
            fatal,
            source_attestation: if fatal.is_none() && response.ok { self.last_source_attestation.take() } else { None },
            response: match fatal {
                Some(reason) => DaemonResponse::err(reason.to_string(), started),
                None => response,
            },
        }
    }

    fn http_client(&mut self) -> Result<Client> {
        if self.http.is_none() {
            self.http = Some(build_http_client()?);
        }
        Ok(self.http.as_ref().expect("http initialized above").clone())
    }

    fn handle(&mut self, req: DaemonRequest, started: Instant) -> DaemonResponse {
        if let Some(reason) = self.fatal.get() {
            return DaemonResponse::err(reason.to_string(), started);
        }
        let result = self.dispatch(req, started);
        // Optional prefetch/probes may intentionally swallow ordinary errors.
        // They may NEVER turn a physically latched throttle into success/revert.
        if let Some(reason) = self.fatal.get() {
            return DaemonResponse::err(reason.to_string(), started);
        }
        match result {
            Ok(resp) => resp,
            Err(err) => {
                if let Some(kind) = err.downcast_ref::<StrictFailure>().map(|e| e.0) { self.last_strict_error = Some(kind); }
                DaemonResponse::err(err.to_string(), started)
            },
        }
    }

    fn dispatch(&mut self, req: DaemonRequest, started: Instant) -> Result<DaemonResponse> {
        match req {
            DaemonRequest::Health => Ok(DaemonResponse {
                ok: true,
                error: None,
                success: Some(true),
                output: None,
                profit: None,
                gas_used: None,
                revert_reason: None,
                latency_ms: started.elapsed().as_millis(),
                missing_state_keys: Vec::new(),
                cache_stats: None,
                seed_stats: None,
                strict: None,
            }),
            DaemonRequest::Reset => {
                self.prepared = None;
                self.block_env = None;
                self.pinned = None; // Explicitly discard pinned state AND its discovered hints.
                Ok(ok_response(started))
            }
            DaemonRequest::Prepare {
                block_number,
                rpc_url,
                funded,
                state_overrides,
                token_deals,
                pre_calls,
                prewarm,
                prewarm_calls,
            } => self.prepare(
                block_number,
                rpc_url,
                funded,
                state_overrides,
                token_deals,
                pre_calls,
                prewarm,
                prewarm_calls,
                started,
            ),
            DaemonRequest::Warm {
                block_number,
                rpc_url,
                prewarm,
                token_balance_hints,
                token_allowance_hints,
                prewarm_calls,
            } => self.warm(
                block_number,
                rpc_url,
                prewarm,
                token_balance_hints,
                token_allowance_hints,
                prewarm_calls,
                started,
            ),
            DaemonRequest::Quote {
                from,
                to,
                data,
                gas_limit,
            } => self.quote(from, to, data, gas_limit, started),
            DaemonRequest::StrictSimulate(req) => {
                self.last_strict_error = Some(StrictFailureKind::Execution);
                self.strict_simulate(req, started)
            },
            DaemonRequest::Simulate {
                owner,
                executor,
                calldata,
                profit_token,
                gas_limit,
            } => self.simulate(owner, executor, calldata, profit_token, gas_limit, started),
        }
    }

    /// Proactive between-block warm: fork `block_number` (reusing the warm
    /// remote if already on it) and trace one representative quote view-call per
    /// recurring hot pool so its slots land in the shared cache. A later hint's
    /// prepare/solve on the same block then hits warm state instead of paying a
    /// cold route-hop trace inside the TTL window. Pure reads, no overlay.
    fn warm(
        &mut self,
        block_number: u64,
        rpc_url: Option<String>,
        prewarm: Vec<String>,
        token_balance_hints: Vec<TokenBalanceHint>,
        token_allowance_hints: Vec<TokenAllowanceHint>,
        prewarm_calls: Vec<PreCall>,
        started: Instant,
    ) -> Result<DaemonResponse> {
        self.ensure_warm(block_number, rpc_url)?;
        let remote_rc = Rc::clone(&self.warm.as_ref().expect("warm set above").remote);
        let parsed = parse_pre_calls(&prewarm_calls)?;
        let need_block = self
            .warm
            .as_ref()
            .and_then(|w| w.block_env.clone())
            .is_none();

        let mut accounts: Vec<Address> = vec![Address::ZERO];
        for addr in &prewarm {
            accounts.push(parse_address(addr)?);
        }
        let mut storage: Vec<(Address, U256)> = Vec::new();
        for hint in &token_balance_hints {
            let token = parse_address(&hint.token)?;
            let account = parse_address(&hint.account)?;
            if let Some(slot) = hint.balance_slot {
                self.balance_slots.insert(token, slot);
            }
            accounts.push(token);
            accounts.push(account);
            for idx in
                mapping_slot_candidates(hint.balance_slot, self.balance_slots.get(&token).copied())
            {
                storage.push((token, erc20_balance_slot(account, idx)));
            }
        }
        for hint in &token_allowance_hints {
            let token = parse_address(&hint.token)?;
            let owner = parse_address(&hint.owner)?;
            let spender = parse_address(&hint.spender)?;
            if let Some(slot) = hint.allowance_slot {
                self.allowance_slots.insert(token, slot);
            }
            accounts.push(token);
            accounts.push(owner);
            accounts.push(spender);
            for idx in mapping_slot_candidates(
                hint.allowance_slot,
                self.allowance_slots.get(&token).copied(),
            ) {
                storage.push((token, erc20_allowance_slot(owner, spender, idx)));
            }
        }
        match remote_rc.warm_batch(
            &accounts,
            &storage,
            if need_block { Some(block_number) } else { None },
        ) {
            Ok(Some(env)) => {
                if let Some(w) = self.warm.as_mut() {
                    w.block_env = Some(env);
                }
            }
            Ok(None) => {}
            Err(err) => eprintln!("[revm-sim] warm upfront batch failed: {err}"),
        }
        if (!storage.is_empty() || !parsed.is_empty()) && self.warm.is_some() {
            if let Some(w) = self.warm.as_mut() {
                w.proactive_seeded = true;
            }
        }

        let mut seed_stats = SeedStats::default();
        if !parsed.is_empty() {
            // Empty overlay: build_trace_overrides over a fresh CacheDB yields
            // {} so the trace runs against real chain state.
            let db = CacheDB::new(SharedRemote(Rc::clone(&remote_rc)));
            let refs: Vec<&ParsedPreCall> = parsed.iter().collect();
            match trace_prefetch(&remote_rc, &db, &refs) {
                Ok(stats) => seed_stats = stats,
                Err(err) => eprintln!("[revm-sim] warm trace prefetch failed: {err}"),
            }
        }
        seed_stats.round_trips = remote_rc.rpc.round_trips();
        eprintln!(
            "[revm-sim] warm block={block_number} pools={} balanceHints={} allowanceHints={} seeded {} accounts + {} slots (wall {}ms)",
            parsed.len(),
            token_balance_hints.len(),
            token_allowance_hints.len(),
            seed_stats.seeded_accounts,
            seed_stats.seeded_slots,
            started.elapsed().as_millis(),
        );

        Ok(DaemonResponse {
            ok: true,
            error: None,
            success: Some(true),
            output: None,
            profit: None,
            gas_used: None,
            revert_reason: None,
            latency_ms: started.elapsed().as_millis(),
            missing_state_keys: Vec::new(),
            cache_stats: None,
            seed_stats: Some(seed_stats),
            strict: None,
        })
    }

    fn ensure_warm(&mut self, block_number: u64, rpc_url: Option<String>) -> Result<()> {
        if self.warm.as_ref().map(|w| w.number) == Some(block_number) {
            return Ok(());
        }
        let rpc_url = rpc_url
            .or_else(|| env::var("MAINNET_RPC_URL").ok())
            .ok_or_else(|| anyhow!("MAINNET_RPC_URL required for revm-sim daemon"))?;
        let http = self.http_client()?;
        let remote = RemoteRevmDb::new(
            rpc_url,
            block_number,
            HashSet::new(),
            Rc::clone(&self.persist),
            http,
            Rc::clone(&self.fatal),
        )?;
        // block_env left None — fetched lazily, batched with the prepare warm-up.
        self.warm = Some(WarmBlock {
            number: block_number,
            remote: Rc::new(remote),
            block_env: None,
            proactive_seeded: false,
        });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn prepare(
        &mut self,
        block_number: u64,
        rpc_url: Option<String>,
        funded: Vec<String>,
        state_overrides: Vec<StateOverride>,
        token_deals: Vec<TokenDeal>,
        pre_calls: Vec<PreCall>,
        prewarm: Vec<String>,
        prewarm_calls: Vec<PreCall>,
        started: Instant,
    ) -> Result<DaemonResponse> {
        let mut phase = Instant::now();
        let phase_ms = |label: &str, phase: &mut Instant| {
            let ms = phase.elapsed().as_millis();
            if ms > 50 {
                eprintln!("[revm-sim] prepare phase {label}: {ms}ms");
            }
            *phase = Instant::now();
        };

        // Round-trip baseline: a same-block re-prepare reuses the warm remote
        // (carrying prior hints' count). Capture the live remote's count before
        // any fetch so the reported delta covers every round trip this prepare
        // causes. A new block re-forks a fresh remote (count starts at 0).
        let same_block = self.warm.as_ref().map(|w| w.number) == Some(block_number);
        let rt_base = if same_block {
            self.warm
                .as_ref()
                .map(|w| w.remote.rpc.round_trips())
                .unwrap_or(0)
        } else {
            0
        };
        self.ensure_warm(block_number, rpc_url)?;
        let warm = self.warm.as_ref().expect("warm set above");
        let remote_rc = Rc::clone(&warm.remote);
        let need_block = warm.block_env.is_none();
        let parsed = parse_pre_calls(&pre_calls)?;
        let parsed_prewarm = parse_pre_calls(&prewarm_calls)?;
        let proactive_same_block = same_block
            && self
                .warm
                .as_ref()
                .map(|w| w.proactive_seeded)
                .unwrap_or(false);
        let skip_upfront_warm_batch = proactive_same_block
            && env::var("SEARCHER_REVM_SKIP_WARM_UPFRONT_BATCH")
                .map(|v| v != "0")
                .unwrap_or(true)
            && token_deals_have_known_slots(&token_deals, &self.balance_slots)?
            && approve_calls_have_known_slots(&parsed, &self.allowance_slots);

        // T2a upfront batch: in ONE round trip warm every nameable account
        // (funded, deal tokens + recipients, prewarm targets), the deal tokens'
        // candidate balance slots, AND (on a fresh block) the block header — so
        // funding / deal-slot trials / approve below all hit the warm cache
        // instead of serial-faulting (each fault is one RPC RTT). The swap's
        // deep pool/tick slots are seeded by the trace.
        if skip_upfront_warm_batch {
            eprintln!("[revm-sim] prepare phase warm_batch: skipped (same-block warm slots)");
        } else {
            // Address::ZERO is the caller for every balanceOf/quote view call;
            // its account is loaded (for gas) on the first execute_call and would
            // otherwise serial-fault inside token_deals. Seed it here.
            let mut accounts: Vec<Address> = vec![Address::ZERO];
            let push_acc = |s: &str, v: &mut Vec<Address>| -> Result<()> {
                v.push(parse_address(s)?);
                Ok(())
            };
            for a in &funded {
                push_acc(a, &mut accounts)?;
            }
            for d in &token_deals {
                push_acc(&d.token, &mut accounts)?;
                push_acc(&d.to, &mut accounts)?;
            }
            for a in &prewarm {
                push_acc(a, &mut accounts)?;
            }
            let mut storage: Vec<(Address, U256)> = Vec::new();
            for d in &token_deals {
                let token = parse_address(&d.token)?;
                let to = parse_address(&d.to)?;
                for idx in
                    mapping_slot_candidates(d.balance_slot, self.balance_slots.get(&token).copied())
                {
                    storage.push((token, erc20_balance_slot(to, idx)));
                }
            }
            for call in &parsed {
                if let Some(spender) = decode_approve_spender(&call.calldata) {
                    if let Some(slot) = call.allowance_slot {
                        self.allowance_slots.insert(call.to, slot);
                    }
                    for idx in mapping_slot_candidates(
                        call.allowance_slot,
                        self.allowance_slots.get(&call.to).copied(),
                    ) {
                        storage.push((call.to, erc20_allowance_slot(call.from, spender, idx)));
                    }
                }
            }
            let fetch_block = if need_block { Some(block_number) } else { None };
            match remote_rc.warm_batch(&accounts, &storage, fetch_block) {
                Ok(Some(env)) => {
                    if let Some(w) = self.warm.as_mut() {
                        w.block_env = Some(env);
                    }
                }
                Ok(None) => {}
                Err(err) => {
                    eprintln!("[revm-sim] upfront warm_batch failed (serial fallback): {err}");
                }
            }
        }
        phase_ms("warm_batch", &mut phase);

        // Block env: from the batch above on a fresh block, else the cached one;
        // fall back to a dedicated fetch only if the batch path was skipped.
        let block_env = match self.warm.as_ref().and_then(|w| w.block_env.clone()) {
            Some(env) => env,
            None => {
                let env = load_block_env(&remote_rc.rpc, block_number)?;
                if let Some(w) = self.warm.as_mut() {
                    w.block_env = Some(env.clone());
                }
                env
            }
        };
        let warm = self.warm.as_ref().expect("warm set above");
        let shared = SharedRemote(Rc::clone(&warm.remote));
        let mut db = CacheDB::new(shared);

        // Fund owner + whale at the overlay layer so the shared chain cache is
        // never poisoned with synthetic balances.
        for addr in &funded {
            let address = parse_address(addr)?;
            let mut info = db
                .basic(address)
                .map_err(|err| anyhow!("fund basic {address:#x}: {err}"))?
                .unwrap_or_default();
            info.balance = U256::MAX;
            db.insert_account_info(address, info);
            mark_account_touched(&mut db, address);
        }
        phase_ms("fund", &mut phase);

        apply_state_overrides(&mut db, &state_overrides)?;
        apply_token_deals(
            &mut db,
            &block_env,
            &token_deals,
            &mut self.balance_slots,
            None,
            false,
        )?;
        phase_ms("token_deals", &mut phase);

        // Execute every preCall but the last one (the approve) locally first:
        // they are cheap, and their writes (deal slots, allowance) must be part
        // of the trace overrides so the remote trace of the swap passes its
        // balance/allowance checks and walks the full execution path.
        let split = parsed.len().saturating_sub(1);
        for call in &parsed[..split] {
            let pre = execute_call(
                &mut db,
                &block_env,
                call.from,
                call.to,
                Bytes::from(call.calldata.clone()),
                call.gas_limit,
                true,
                false,
            )?;
            if !pre.result.is_success() {
                bail!("preCall failed: {}", format_execution_result(&pre.result));
            }
            db.commit(pre.state);
        }
        phase_ms("pre_calls_local", &mut phase);

        // T2a: prefetch every account/code/slot the victim swap and the route's
        // first quotes will touch, in ONE batched debug_traceCall round trip,
        // instead of serial-faulting each slot at one RPC read apiece (measured
        // 21-22.5s cold overlay live). Failure falls back to serial faulting.
        let mut seed_stats = None;
        let mut trace_calls: Vec<&ParsedPreCall> = parsed[split..].iter().collect();
        trace_calls.extend(parsed_prewarm.iter());
        let skip_trace_prefetch = proactive_same_block
            && env::var("SEARCHER_REVM_SKIP_WARM_TRACE_PREFETCH")
                .map(|v| v != "0")
                .unwrap_or(true);
        if !trace_calls.is_empty() && !skip_trace_prefetch {
            match trace_prefetch(&remote_rc, &db, &trace_calls) {
                Ok(stats) => seed_stats = Some(stats),
                Err(err) => eprintln!(
                    "[revm-sim] trace prefetch failed; falling back to serial faults: {err}"
                ),
            }
        } else if !trace_calls.is_empty() {
            eprintln!("[revm-sim] prepare phase trace_prefetch: skipped (same-block warm cache)");
        }
        phase_ms("trace_prefetch", &mut phase);

        for call in &parsed[split..] {
            let pre = execute_call(
                &mut db,
                &block_env,
                call.from,
                call.to,
                Bytes::from(call.calldata.clone()),
                call.gas_limit,
                true,
                false,
            )?;
            if !pre.result.is_success() {
                bail!("preCall failed: {}", format_execution_result(&pre.result));
            }
            db.commit(pre.state);
        }
        phase_ms("victim_swap_local", &mut phase);

        // Prewarm: pull code/account for hot addresses so the first quote in the
        // amount search is already warm.
        for addr in &prewarm {
            let address = parse_address(addr)?;
            let _ = db.basic(address);
        }
        phase_ms("prewarm_basic", &mut phase);

        let missing = db.db.missing_state_keys();
        let stats = db.db.stats();
        let round_trips = remote_rc.rpc.round_trips().saturating_sub(rt_base);
        let seed_stats = Some({
            let mut s = seed_stats.unwrap_or_default();
            s.round_trips = round_trips;
            s
        });
        eprintln!(
            "[revm-sim] prepare round_trips={round_trips} (wall {}ms)",
            started.elapsed().as_millis()
        );
        self.prepared = Some(db);
        self.block_env = Some(block_env);
        Ok(DaemonResponse {
            ok: true,
            error: None,
            success: Some(true),
            output: None,
            profit: None,
            gas_used: None,
            revert_reason: None,
            latency_ms: started.elapsed().as_millis(),
            missing_state_keys: missing,
            cache_stats: Some(stats),
            seed_stats,
            strict: None,
        })
    }

    fn quote(
        &mut self,
        from: Option<String>,
        to: String,
        data: String,
        gas_limit: Option<u64>,
        started: Instant,
    ) -> Result<DaemonResponse> {
        let block_env = self
            .block_env
            .clone()
            .ok_or_else(|| anyhow!("quote before prepare"))?;
        let base = self
            .prepared
            .as_ref()
            .ok_or_else(|| anyhow!("quote before prepare"))?;
        let stats_before = base.db.stats();
        let mut db = base.clone();
        let caller = match from {
            Some(value) => parse_address(&value)?,
            None => Address::ZERO,
        };
        let target = parse_address(&to)?;
        let calldata = Bytes::from(parse_hex_bytes(&data)?);
        let out = execute_call(
            &mut db,
            &block_env,
            caller,
            target,
            calldata,
            gas_limit.unwrap_or(3_000_000),
            false,
            false,
        )?;
        let success = out.result.is_success();
        let output = out
            .result
            .output()
            .map(|b| format!("0x{}", hex::encode(b.as_ref())));
        let missing = db.db.missing_state_keys();
        let stats = db.db.stats().delta_since(&stats_before);
        Ok(DaemonResponse {
            ok: true,
            error: None,
            success: Some(success),
            output,
            profit: None,
            gas_used: Some(out.result.tx_gas_used().to_string()),
            revert_reason: if success {
                None
            } else {
                Some(format_execution_result(&out.result))
            },
            latency_ms: started.elapsed().as_millis(),
            missing_state_keys: missing,
            cache_stats: Some(stats),
            seed_stats: None,
            strict: None,
        })
    }

    fn simulate(
        &mut self,
        owner: String,
        executor: String,
        calldata: String,
        profit_token: String,
        gas_limit: Option<u64>,
        started: Instant,
    ) -> Result<DaemonResponse> {
        let block_env = self
            .block_env
            .clone()
            .ok_or_else(|| anyhow!("simulate before prepare"))?;
        let base = self
            .prepared
            .as_ref()
            .ok_or_else(|| anyhow!("simulate before prepare"))?;
        let stats_before = base.db.stats();
        let mut db = base.clone();

        let owner = parse_address(&owner)?;
        let executor = parse_address(&executor)?;
        let profit_token = parse_address(&profit_token)?;
        let calldata = Bytes::from(parse_hex_bytes(&calldata)?);

        let pre = erc20_balance_of(&mut db, &block_env, profit_token, executor)?;
        let main = execute_call(
            &mut db,
            &block_env,
            owner,
            executor,
            calldata,
            gas_limit.unwrap_or(DEFAULT_GAS_LIMIT),
            true,
            false,
        )?;
        let gas_used = main.result.tx_gas_used();
        let success = main.result.is_success();
        let revert_reason = if success {
            None
        } else {
            Some(format_execution_result(&main.result))
        };
        if success {
            db.commit(main.state);
        }
        let post = erc20_balance_of(&mut db, &block_env, profit_token, executor)?;
        let profit = post.saturating_sub(pre);
        let missing = db.db.missing_state_keys();
        let stats = db.db.stats().delta_since(&stats_before);
        Ok(DaemonResponse {
            ok: true,
            error: None,
            success: Some(success && profit > U256::ZERO),
            output: None,
            profit: Some(profit.to_string()),
            gas_used: Some(gas_used.to_string()),
            revert_reason,
            latency_ms: started.elapsed().as_millis(),
            missing_state_keys: missing,
            cache_stats: Some(stats),
            seed_stats: None,
            strict: None,
        })
    }

    fn strict_simulate(&mut self, req: StrictRequest, started: Instant) -> Result<DaemonResponse> {
        let plan = StrictPlan::validate(&req).map_err(|_| StrictFailure(StrictFailureKind::Validation))?;
        if let Some(pin) = &req.source_pin {
            let url = req.rpc_url.as_ref().filter(|u| !u.trim().is_empty())
                .ok_or(StrictFailure(StrictFailureKind::Validation))?;
            if pin.chain_id != 1 { bail!(StrictFailure(StrictFailureKind::Validation)); }
            strict_hex(&json!(pin.block_hash), Some(32))?;
            if let Some(root) = &pin.state_root { strict_hex(&json!(root), Some(32))?; }
            let mut rpc = RpcClient::new(url.clone(), self.http_client()?, Rc::clone(&self.fatal))?;
            rpc.pinned = true;
            let source = {
                let _phase = diagnostic::phase(Phase::SourcePrecheck);
                verify_source(&rpc, req.block_number, pin)?
            };
            let mut session = self.take_pinned_session(rpc, &source);
            let result = Self::strict_simulate_at(Rc::clone(&session.remote), source.env.clone(),
                &mut session.balance_slots, &mut session.allowance_slots, &req, &plan, started);
            // All outcomes (including probe failure, Revert and Halt) retain the
            // canonical post-check. Optional paths cannot clear the fatal latch.
            {
                let _phase = diagnostic::phase(Phase::CanonicalPostcheck);
                verify_canonical(&session.remote.rpc, &source)?;
            }
            self.pinned = Some(session);
            let response = result?;
            self.last_source_attestation = Some(source.attestation);
            return Ok(response);
        }
        self.ensure_warm(req.block_number, req.rpc_url.clone())?;
        let remote = Rc::clone(&self.warm.as_ref().expect("warm set above").remote);
        let env = load_block_env(&remote.rpc, req.block_number)?;
        Self::strict_simulate_at(remote, env, &mut self.balance_slots, &mut self.allowance_slots, &req, &plan, started)
    }

    fn take_pinned_session(&mut self, rpc: RpcClient, source: &VerifiedSource) -> PinnedSession {
        match self.pinned.take() {
            Some(session) if session.remote.rpc.url == rpc.url
                && session.remote.source.as_ref() == Some(source) => session,
            _ => {
                let mut inner = RemoteRevmDbInner::default();
                inner.ancestors.insert(source.attestation.block_number,
                    (source.attestation.block_hash, source.attestation.parent_hash));
                PinnedSession { remote: Rc::new(RemoteRevmDb {
                    rpc, block_tag: json!({"blockHash":source.attestation.block_hash,"requireCanonical":true}),
                    source: Some(source.clone()), funded: HashSet::new(),
                    persist: Rc::new(RefCell::new(PersistentCache::default())), inner: RefCell::new(inner),
                }), balance_slots: HashMap::new(), allowance_slots: HashMap::new() }
            }
        }
    }

    fn pair_response(&self, epoch: Option<String>, id: Option<u64>, result: Result<DaemonResponse>,
        source: Option<SourceAttestation>, started: Instant) -> DaemonResponseEnvelope {
        let fatal = self.fatal.get();
        let (response, error_kind) = match (fatal, result) {
            (Some(reason), _) => (DaemonResponse::err(reason.to_string(), started), None),
            (None, Ok(response)) => (response, None),
            (None, Err(error)) => {
                let kind = error.downcast_ref::<StrictFailure>().map(|e| e.0).unwrap_or(StrictFailureKind::Validation);
                (DaemonResponse::err(error.to_string(), started), Some(kind))
            }
        };
        DaemonResponseEnvelope { epoch, request_id: id.map(|id| id.to_string()), fatal,
            source_attestation: if response.ok && fatal.is_none() { source } else { None }, response, error_kind }
    }

    fn strict_pair(&mut self, pair: StrictPair, started: Instant, diagnostics: bool, out: &mut impl IoWrite) -> Result<()> {
        let [a, b] = &pair.requests;
        let [a_plan, b_plan] = &pair.plans;
        let mut timing = diagnostic::PairTiming::begin(diagnostics, pair.ids, a.block_number, started);
        let first = (|| -> Result<_> {
            if let Some(reason) = self.fatal.get() { return Err(reason.into()); }
            let mut rpc = RpcClient::new(a.rpc_url.clone().expect("validated pair"), self.http_client()?, Rc::clone(&self.fatal))?;
            rpc.pinned = true;
            let source = {
                let _phase = diagnostic::phase(Phase::SourcePrecheck);
                verify_source(&rpc, a.block_number, a.source_pin.as_ref().expect("validated pair"))?
            };
            let mut session = self.take_pinned_session(rpc, &source);
            let result = Self::strict_simulate_at(Rc::clone(&session.remote), source.env.clone(),
                &mut session.balance_slots, &mut session.allowance_slots, a, a_plan, started);
            Ok((source, session, result))
        })();
        // B's response latency includes its bridge precheck; pair diagnostics
        // still charge that shared interval only once, outside both children.
        let second_started = Instant::now();
        let first = match first {
            Ok((source, session, result)) => {
                timing.advance(); // A's execution interval ends; bridge is group-owned.
                match verify_pair_bridge(&session.remote.rpc, &source, b.block_number, b.source_pin.as_ref().expect("validated pair")) {
                    Ok(second_source) => Ok((source, second_source, session, result)),
                    Err(error) => Err(error),
                }
            }
            Err(error) => Err(error),
        };
        let (source, second_source, session, result) = match first {
            Ok(first) => first,
            Err(error) => {
                write_daemon_response(out, &self.pair_response(Some(pair.epoch.clone()), Some(pair.ids[0]), Err(error), None, started))?;
                write_daemon_response(out, &self.pair_response(Some(pair.epoch), Some(pair.ids[1]),
                    Err(StrictFailure(StrictFailureKind::Execution).into()), None, started))?;
                timing.finish(2, self.fatal.get().is_some());
                return Ok(());
            }
        };
        // A is terminal and physically flushed BEFORE any B execution. A broken
        // output pipe returns here; it cannot cause unobservable sibling work.
        write_daemon_response(out, &self.pair_response(Some(pair.epoch.clone()), Some(pair.ids[0]),
            result, Some(source.attestation), started))?;
        timing.advance();
        self.pinned = Some(session);
        let result = (|| -> Result<_> {
            if let Some(reason) = self.fatal.get() { return Err(reason.into()); }
            let mut rpc = RpcClient::new(b.rpc_url.clone().expect("validated pair"), self.http_client()?, Rc::clone(&self.fatal))?;
            rpc.pinned = true;
            // Fresh, one-use bridge evidence, not A's verified source. Only the
            // existing immutable source-value cache may be reused.
            let mut session = self.take_pinned_session(rpc, &second_source);
            let result = Self::strict_simulate_at(Rc::clone(&session.remote), second_source.env.clone(),
                &mut session.balance_slots, &mut session.allowance_slots, b, b_plan, second_started);
            {
                let _phase = diagnostic::phase(Phase::CanonicalPostcheck);
                verify_canonical(&session.remote.rpc, &second_source)?;
            }
            self.pinned = Some(session);
            result
        })();
        write_daemon_response(out, &self.pair_response(Some(pair.epoch), Some(pair.ids[1]),
            result, Some(second_source.attestation), second_started))?;
        timing.finish(2, self.fatal.get().is_some());
        Ok(())
    }

    fn strict_simulate_at(
        remote: Rc<RemoteRevmDb>, env: BlockEnv, balance_slots: &mut HashMap<Address, u64>,
        allowance_slots: &mut HashMap<Address, u64>,
        req: &StrictRequest, plan: &StrictPlan, started: Instant,
    ) -> Result<DaemonResponse> {
        // Hydrate only source values before local overrides and deal-slot trials.
        // Remote cache warmth is separate from EVM transaction warmth.
        let hydration_phase = diagnostic::phase(Phase::Hydration);
        let mut accounts: Vec<_> = plan.calls.iter().flat_map(|c| [c.from, c.to])
            .chain([Address::ZERO, plan.actor, plan.origin])
            .chain(plan.native.iter().copied())
            .chain(plan.pairs.iter().flat_map(|(token, account)| [*token, *account]))
            .chain(plan.supply.iter().copied()).collect();
        let mut storage = Vec::new();
        let prefix_deals = req.trial_prefix.as_ref().map(|p| vec![TokenDeal {
            token: p.input_token.clone(), to: p.executor.clone(), amount: p.input_amount.clone(), balance_slot: None,
        }]);
        let token_deals = prefix_deals.as_deref().unwrap_or(&req.token_deals);
        for deal in token_deals {
            let token = parse_address(&deal.token)?;
            let to = parse_address(&deal.to)?;
            accounts.extend([token, to]);
            for index in mapping_slot_candidates(deal.balance_slot, balance_slots.get(&token).copied()) {
                storage.push((token, erc20_balance_slot(to, index)));
            }
        }
        for call in &plan.calls[..plan.calls.len() - 1] {
            if let Some(spender) = decode_approve_spender(&call.calldata) {
                for index in mapping_slot_candidates(call.allowance_slot, allowance_slots.get(&call.to).copied()) {
                    storage.push((call.to, erc20_allowance_slot(plan.actor, spender, index)));
                }
            }
        }
        accounts.sort_unstable(); accounts.dedup();
        storage.sort_unstable(); storage.dedup();
        let warmed = remote.warm_batch(&accounts, &storage, None).is_ok();
        remote.rpc.check_fatal()?;
        drop(hydration_phase);

        // Each request owns a fresh source view. The only trial funding is its
        // explicitly declared root input; never replenish a later route leg.
        let mut db = CacheDB::new(SharedRemote(Rc::clone(&remote)));
        apply_executor_runtime_code(&mut db, plan)?;
        if let Some(prefix) = &req.trial_prefix {
            let account = db.basic(parse_address(&prefix.executor)?)?.unwrap_or_default();
            let code = match account.code { Some(code) => code, None => db.code_by_hash(account.code_hash)? };
            if code.is_empty() { return Err(StrictFailure(StrictFailureKind::Execution).into()); }
        }
        if let Some(balance) = plan.native_balance {
            let mut info = db.basic(plan.actor)?.unwrap_or_default();
            info.balance = balance;
            db.insert_account_info(plan.actor, info);
        }
        {
            let _phase = diagnostic::phase(Phase::TokenDeal);
            apply_token_deals(&mut db, &env, token_deals, balance_slots, Some(&remote), true)
                .map_err(|_| StrictFailure(StrictFailureKind::Observation))?;
        }
        for call in &plan.calls[..plan.calls.len() - 1] {
            if decode_approve_spender(&call.calldata).is_some() {
                if let Some(slot) = call.allowance_slot { allowance_slots.insert(call.to, slot); }
            }
        }

        // Trace hints must see the completed local deal/override state. Trace
        // values never enter pinned state; missed hints retain lazy source reads.
        if warmed {
            // The legacy warm-hint overlay has no code field. Do not trace old
            // chain code for a counterfactual request; normal lazy reads suffice.
            if plan.executor_code.is_none() {
                let _phase = diagnostic::phase(Phase::TraceHints);
                let refs: Vec<_> = plan.calls.iter().collect();
                let _ = trace_prefetch(&remote, &db, &refs);
            }
        }
        remote.rpc.check_fatal()?;

        // A quote's effects begin after the earlier route hops, but before its
        // own setup/main. Prefix execution captures this baseline without
        // ending the transaction or changing its warm/transient state.
        let mut before = if req.trial_prefix.is_none() {
            let _phase = diagnostic::phase(Phase::EffectsObservations);
            Some(strict_observation_baseline(&db, &env, plan)?)
        } else { None };
        let (outcome, gas_used, logs) = strict_execute_observed(&mut db, &env, req, plan, &mut before)?;
        let _phase = diagnostic::phase(Phase::EffectsObservations);
        let success = matches!(outcome, StrictOutcome::Success { .. });
        let output = match &outcome {
            StrictOutcome::Success { output, .. } | StrictOutcome::Revert { output, .. } => Some(output.clone()),
            StrictOutcome::Halt { .. } => None,
        };
        let revert_reason = match &outcome { StrictOutcome::Revert { output, .. } => Some(output.clone()), _ => None };
        let mut effects = StrictSimulateEffects { outcome, execution_gas_used: gas_used.to_string(),
            counterfactual_executor_code: plan.executor_code.as_ref().map(|(target, code)| CounterfactualExecutorCode {
                address: format!("{target:#x}"), keccak256: format!("{:#x}", code.hash_slow()),
            }),
            native_deltas: Vec::new(), token_deltas: Vec::new(), total_supply_deltas: Vec::new(),
            logs: if success && req.observe_logs { logs } else { Vec::new() } };
        // A failed sibling has no accepted effects, not partial setup effects.
        if success {
            let before = before.ok_or(StrictFailure(StrictFailureKind::Observation))?;
            for (i, account) in plan.native.iter().enumerate() {
                let after = db.basic(*account)?.unwrap_or_default().balance;
                effects.native_deltas.push(SimNativeDelta { account: format!("{account:#x}"),
                    before: before.native[i].to_string(), after: after.to_string(), delta: signed_delta(after, before.native[i]) });
            }
            for (i, (token, account)) in plan.pairs.iter().enumerate() {
                let after = strict_balance_of(&db, &env, *token, *account)?;
                effects.token_deltas.push(SimTokenDelta { token: format!("{token:#x}"), account: format!("{account:#x}"),
                    delta: signed_delta(after, before.tokens[i]) });
            }
            for (i, token) in plan.supply.iter().enumerate() {
                let after = strict_probe(&db, &env, *token, Bytes::from_static(&TOTAL_SUPPLY_SELECTOR))?;
                effects.total_supply_deltas.push(SimTotalSupplyDelta { token: format!("{token:#x}"),
                    delta: signed_delta(after, before.supply[i]) });
            }
        }
        Ok(DaemonResponse { ok: true, error: None, success: Some(success), output, profit: None,
            gas_used: Some(gas_used.to_string()), revert_reason, latency_ms: started.elapsed().as_millis(),
            missing_state_keys: db.db.missing_state_keys(), cache_stats: None, seed_stats: None, strict: Some(effects) })
    }
}

struct StrictPlan {
    executor_code: Option<(Address, Bytecode)>,
    actor: Address,
    origin: Address,
    inner: bool,
    native_balance: Option<U256>,
    native: Vec<Address>,
    pairs: Vec<(Address, Address)>,
    supply: Vec<Address>,
    calls: Vec<ParsedPreCall>,
    state_read: Option<ParsedStateRead>,
}

enum ParsedStateRead { Storage(Address, U256), Code(Address) }

impl StrictPlan {
    fn validate(req: &StrictRequest) -> Result<Self> {
        let address = |s: &str| -> Result<Address> { strict_hex(&json!(s), Some(20))?; parse_address(s) };
        let uint = |s: &str| -> Result<U256> {
            if s.is_empty() || s.len() > 78 || !s.bytes().all(|c| c.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0')) { bail!("invalid uint256"); }
            Ok(U256::from_str(s)?)
        };
        let addresses = |items: &[String]| -> Result<Vec<Address>> {
            let out = items.iter().map(|s| address(s)).collect::<Result<Vec<_>>>()?;
            if out.iter().collect::<HashSet<_>>().len() != out.len() { bail!("duplicate observation"); }
            Ok(out)
        };
        let actor = address(&req.from)?;
        let code_override = req.trial_prefix.as_ref().and_then(|p| p.executor_runtime_code.as_ref()
            .map(|code| (code, p.executor.as_str()))).or_else(|| req.executor_runtime_code.as_ref().map(|code| (code, req.to.as_str())));
        let executor_code = if let Some((v, target)) = code_override {
            let target = address(target)?;
            if req.source_pin.is_none() || (req.trial_prefix.is_none() && target == actor) { bail!("counterfactual code requires pinned target"); }
            strict_hex(&json!(v.code), None)?;
            strict_hex(&json!(v.keccak256), Some(32))?;
            let bytes = parse_hex_bytes(&v.code)?;
            if bytes.is_empty() || format!("{:#x}", keccak256(&bytes)) != v.keccak256.to_lowercase() {
                bail!("counterfactual code hash mismatch");
            }
            Some((target, Bytecode::new_raw_checked(Bytes::from(bytes))
                .map_err(|_| anyhow!("invalid counterfactual bytecode"))?))
        } else { None };
        let inner = match req.caller_mode.as_deref() { None | Some("top-level") => false,
            Some("impersonated-call-frame") => true, _ => bail!("invalid caller mode") };
        let origin = req.transaction_origin.as_deref().map(address).transpose()?;
        if inner && (origin.is_none() || req.execution_gas_limit.is_none()) { bail!("missing inner context"); }
        if !inner && origin.is_some_and(|o| o != actor) { bail!("top-level origin differs"); }
        for gas in [req.gas_limit, req.execution_gas_limit].into_iter().flatten() {
            if gas == 0 || gas > 9_007_199_254_740_991 { bail!("invalid gas limit"); }
        }
        let mut calls = Vec::new();
        if let Some(prefix) = &req.trial_prefix {
            if !inner || req.source_pin.is_none() || req.executor_runtime_code.is_some() ||
                req.native_balance_wei.is_some() || !req.token_deals.is_empty() { bail!("invalid trial prefix context"); }
            let executor = address(&prefix.executor)?;
            if executor == Address::ZERO || address(&prefix.input_token)? == Address::ZERO || uint(&prefix.input_amount)?.is_zero() {
                bail!("invalid trial prefix input");
            }
            strict_hex(&json!(prefix.calldata), None)?;
            let calldata = parse_hex_bytes(&prefix.calldata)?;
            if calldata.is_empty() { bail!("empty trial prefix"); }
            calls.push(ParsedPreCall { from: executor, to: executor, calldata,
                gas_limit: req.execution_gas_limit.expect("validated inner context"), allowance_slot: None });
        }
        for c in &req.pre_calls {
            if address(&c.from)? != actor || c.gas_limit.is_some_and(|g| g == 0 || g > 9_007_199_254_740_991) { bail!("invalid preCall"); }
            strict_hex(&json!(c.calldata), None)?;
            calls.push(ParsedPreCall { from: actor, to: address(&c.to)?, calldata: parse_hex_bytes(&c.calldata)?,
                gas_limit: c.gas_limit.unwrap_or(DEFAULT_GAS_LIMIT), allowance_slot: c.allowance_slot });
        }
        strict_hex(&json!(req.data), None)?;
        calls.push(ParsedPreCall { from: actor, to: address(&req.to)?, calldata: parse_hex_bytes(&req.data)?,
            gas_limit: req.gas_limit.unwrap_or(DEFAULT_GAS_LIMIT), allowance_slot: None });
        let mut seen_deals = HashSet::new();
        for d in &req.token_deals {
            if address(&d.to)? != actor || !seen_deals.insert(address(&d.token)?) { bail!("invalid token deal"); }
            uint(&d.amount)?;
        }
        let pairs = if let Some(pairs) = &req.observe_token_balances {
            if req.observe_tokens.is_some() || req.observe_accounts.is_some() { bail!("mixed observation forms"); }
            let out = pairs.iter().map(|p| Ok((address(&p.token)?, address(&p.account)?))).collect::<Result<Vec<_>>>()?;
            if out.iter().collect::<HashSet<_>>().len() != out.len() { bail!("duplicate pair"); }
            out
        } else {
            // Legacy API alone retains Cartesian lists; absent tokens means no
            // observations, absent/empty accounts means the declared caller.
            let tokens = addresses(req.observe_tokens.as_deref().unwrap_or(&[]))?;
            let mut accounts = addresses(req.observe_accounts.as_deref().unwrap_or(&[]))?;
            if accounts.is_empty() { accounts.push(actor); }
            tokens.iter().flat_map(|t| accounts.iter().map(move |a| (*t, *a))).collect()
        };
        let state_read = req.state_read.as_ref().map(|read| -> Result<ParsedStateRead> {
            if req.trial_prefix.is_none() || req.data != "0x" || req.observe_logs || !pairs.is_empty() ||
                !req.observe_native_balances.as_deref().unwrap_or(&[]).is_empty() || !req.observe_total_supply.is_empty() ||
                !req.observe_accounts.as_deref().unwrap_or(&[]).is_empty() { bail!("invalid trial state read context"); }
            let target = address(&req.to)?;
            match read {
                StrictStateRead::Storage { address: addr, slot } => {
                    if address(addr)? != target { bail!("state read target differs"); }
                    strict_hex(&json!(slot), Some(32))?;
                    Ok(ParsedStateRead::Storage(target, parse_u256(slot)?))
                }
                StrictStateRead::Code { address: addr } => {
                    if address(addr)? != target { bail!("state read target differs"); }
                    Ok(ParsedStateRead::Code(target))
                }
            }
        }).transpose()?;
        Ok(Self { executor_code, actor, origin: origin.unwrap_or(actor), inner,
            native_balance: req.native_balance_wei.as_deref().map(uint).transpose()?,
            native: addresses(req.observe_native_balances.as_deref().unwrap_or(&[]))?, pairs,
            supply: addresses(&req.observe_total_supply)?, calls, state_read })
    }
}

/// Request-local code only, before all baseline probes. Preserve the source
/// account's balance, nonce and storage; never mutate the remote/pinned cache.
fn apply_executor_runtime_code<D: ExecutionProfile>(db: &mut CacheDB<D>, plan: &StrictPlan) -> Result<()> {
    if let Some((target, code)) = &plan.executor_code {
        let mut info = db.basic(*target)?.unwrap_or_default();
        info.code_hash = code.hash_slow();
        info.code = Some(code.clone());
        db.insert_account_info(*target, info);
    }
    Ok(())
}

/// Ordinary mainnet execution with fee bookkeeping removed, not balances
/// restored afterward. Validation/delegated code and internal transfers remain.
struct StrictHandler<EVM, ERROR, FRAME> {
    entry: Option<(Address, usize, bool)>,
    marker: std::marker::PhantomData<(EVM, ERROR, FRAME)>,
}
impl<EVM, ERROR, FRAME> StrictHandler<EVM, ERROR, FRAME> {
    fn new(entry: Option<(Address, usize, bool)>) -> Self { Self { entry, marker: std::marker::PhantomData } }
}
impl<EVM, ERROR, FRAME> Handler for StrictHandler<EVM, ERROR, FRAME>
where
    EVM: EvmTr<Context: ContextTr<Journal: JournalTr<State = EvmState>>, Frame = FRAME>,
    ERROR: EvmTrError<EVM>,
    FRAME: FrameTr<FrameResult = FrameResult, FrameInit = FrameInit>,
{
    type Evm = EVM;
    type Error = ERROR;
    type HaltReason = HaltReason;
    fn validate_against_state_and_deduct_caller(&self, evm: &mut EVM, _: &mut InitialAndFloorGas) -> Result<(), ERROR> {
        let (_, tx, cfg, journal, _, _) = evm.ctx().all_mut();
        let mut caller = journal.load_account_with_code_mut(tx.caller())?.data;
        revm::handler::pre_execution::validate_account_nonce_and_code_with_components(&caller.account().info, tx, cfg)?;
        // Only top-level setup/main transactions use this hook. Inner entries
        // bypass transaction pre-execution: neither actor nor origin is bumped.
        caller.bump_nonce();
        Ok(())
    }
    fn reimburse_caller(&self, _: &mut EVM, _: &mut FrameResult) -> Result<(), ERROR> { Ok(()) }
    fn reward_beneficiary(&self, _: &mut EVM, _: &mut FrameResult) -> Result<(), ERROR> { Ok(()) }
    fn first_frame_input(&mut self, evm: &mut EVM, gas: u64, reservoir: u64) -> Result<FrameInit, ERROR> {
        let mut frame = MainnetHandler::<EVM, ERROR, FRAME>::default().first_frame_input(evm, gas, reservoir)?;
        if let Some((actor, depth, is_static)) = self.entry {
            evm.ctx().journal_mut().load_account_with_code(actor)?;
            let FrameInput::Call(call) = &mut frame.frame_input else { unreachable!("strict accepts CALL only") };
            call.caller = actor;
            call.is_static = is_static;
            frame.depth = depth;
            // Actual known bytecode, target/storage address, value(0), scheme
            // and every descendant's inputs are untouched.
        }
        Ok(frame)
    }
}

fn strict_cfg(cfg: &mut revm::context::CfgEnv, profile: Option<MainnetProfile>) {
    cfg.set_spec_and_mainnet_gas_params(profile.map_or(SpecId::PRAGUE, |p| p.spec));
    if let Some(profile) = profile {
        cfg.blob_base_fee_update_fraction = Some(profile.blob_fraction);
        cfg.max_blobs_per_tx = Some(if profile.spec == SpecId::OSAKA { 6 } else { 9 });
    }
    cfg.disable_nonce_check = false;
    cfg.disable_eip3607 = false;
    cfg.tx_chain_id_check = true;
}

fn strict_tx(env: &BlockEnv, caller: Address, target: Address, data: Bytes, gas: u64, nonce: u64) -> TxEnv {
    let mut tx = TxEnv::builder().caller(caller).to(target).data(data).value(U256::ZERO)
        .gas_limit(gas).gas_price(env.basefee as u128).gas_priority_fee(Some(0)).chain_id(Some(1)).build_fill();
    tx.nonce = nonce;
    tx
}

#[derive(Default)]
struct StrictObservationBaseline {
    native: Vec<U256>,
    tokens: Vec<U256>,
    supply: Vec<U256>,
}

fn strict_observation_baseline<D: ExecutionProfile>(db: &CacheDB<D>, env: &BlockEnv, plan: &StrictPlan)
    -> Result<StrictObservationBaseline> {
    Ok(StrictObservationBaseline {
        native: plan.native.iter().map(|a| db.basic_ref(*a).map(|v| v.unwrap_or_default().balance))
            .collect::<Result<Vec<_>, _>>()?,
        tokens: plan.pairs.iter().map(|(t, a)| strict_balance_of(db, env, *t, *a)).collect::<Result<Vec<_>>>()?,
        supply: plan.supply.iter().map(|t| strict_probe(db, env, *t, Bytes::from_static(&TOTAL_SUPPLY_SELECTOR)))
            .collect::<Result<Vec<_>>>()?,
    })
}

#[cfg(test)]
fn strict_execute<D: ExecutionProfile>(db: &mut CacheDB<D>, env: &BlockEnv, req: &StrictRequest, plan: &StrictPlan)
    -> Result<(StrictOutcome, u64, Vec<SimLog>)> {
    strict_execute_observed(db, env, req, plan, &mut None)
}

fn strict_execute_observed<D: ExecutionProfile>(db: &mut CacheDB<D>, env: &BlockEnv, req: &StrictRequest, plan: &StrictPlan,
    baseline: &mut Option<StrictObservationBaseline>)
    -> Result<(StrictOutcome, u64, Vec<SimLog>)> {
    let profile = db.db.execution_profile();
    let ctx = Context::mainnet().modify_cfg_chained(|cfg| strict_cfg(cfg, profile)).with_block(env.clone()).with_db(&mut *db);
    let mut evm = ctx.build_mainnet();
    let mut handler = StrictHandler::<_, EVMError<RpcError>, _>::new(if plan.inner { Some((plan.actor, 1, false)) } else { None });
    let mut used = 0u64;
    let mut logs = Vec::new();
    for (index, call) in plan.calls.iter().enumerate() {
        let _phase = diagnostic::phase(if index == 0 && req.trial_prefix.is_some() {
            Phase::PrefixExecution
        } else { Phase::MainReadSetup });
        let stage = if index + 1 == plan.calls.len() { StrictStage::Main } else { StrictStage::PreCall { index } };
        if index + 1 == plan.calls.len() {
            if let Some(read) = &plan.state_read {
                // Read the same post-prefix journal, not the remote baseline.
                // This never executes the target's fallback or mutates storage.
                let output = match read {
                    ParsedStateRead::Storage(address, slot) => {
                        evm.ctx.journaled_state.load_account_with_code(*address)?;
                        let value = evm.ctx.journaled_state.sload(*address, *slot)?.data;
                        format!("0x{}", hex::encode(value.to_be_bytes::<32>()))
                    }
                    ParsedStateRead::Code(address) => {
                        let code = evm.ctx.journaled_state.code(*address)?.data;
                        format!("0x{}", hex::encode(code))
                    }
                };
                let state = evm.ctx.journaled_state.finalize();
                drop(evm);
                db.commit(state);
                return Ok((StrictOutcome::Success { output, stage }, used, logs));
            }
        }
        let cap = req.execution_gas_limit.map_or(call.gas_limit, |budget| call.gas_limit.min(budget.saturating_sub(used)));
        if cap == 0 { return Ok((StrictOutcome::Halt { reason: "OutOfGas".into(), stage }, used, Vec::new())); }
        let nonce = evm.ctx.journaled_state.load_account_with_code(plan.origin)?.info.nonce;
        // TxEnv supplies opcode environment for isolated CALLs, not a signed
        // transaction. Its unused nonce is zero; actual account nonces are never
        // overridden. Top-level messages instead consume the current nonce.
        evm.ctx.tx = strict_tx(env, plan.origin, call.to, Bytes::from(call.calldata.clone()), cap, if plan.inner { 0 } else { nonce });
        let result = if plan.inner {
            // Prefix execution is executor->executor; the quote retains its
            // original actor. ORIGIN remains the separately bound transaction.
            handler.entry = Some((call.from, 1, false));
            if index == 0 {
                // Validate the whole envelope's admitted gas bound, not just
                // the first sibling's possibly smaller individual cap.
                evm.ctx.tx.gas_limit = req.execution_gas_limit.expect("validated inner budget");
                handler.validate_env(&mut evm).map_err(|_| StrictFailure(StrictFailureKind::Validation))?;
                evm.ctx.tx.gas_limit = cap;
                let origin = &evm.ctx.journaled_state.load_account_with_code(plan.origin)?.info;
                revm::handler::pre_execution::validate_account_nonce_and_code(origin, nonce, false, true)
                    .map_err(|_| StrictFailure(StrictFailureKind::Validation))?;
                handler.load_accounts(&mut evm)?;
            }
            // The inner loop skips Handler::execution_result to preserve the
            // transaction journal. Reset only CALL-local memory/context before
            // each sibling; storage, transient storage and warmth stay shared.
            evm.ctx.local_mut().clear();
            let frame = handler.first_frame_input(&mut evm, cap, 0)?;
            let mut result = handler.run_exec_loop(&mut evm, frame)?;
            revm::context_interface::context::take_error::<EVMError<RpcError>, _>(evm.ctx.error())?;
            // No transaction intrinsic/floor cost per sibling. Refunds never
            // replenish the common execution budget; a Halt spends its cap.
            if result.instruction_result().is_halt() { result.gas_mut().spend_all(); }
            let spent = cap - result.gas().remaining();
            result.gas_mut().set_refund(0);
            revm::handler::post_execution::output(&mut evm.ctx, result, ResultGas::default().with_total_gas_spent(spent))
        } else {
            handler.run(&mut evm).map_err(|error| match error {
                EVMError::Transaction(_) | EVMError::Header(_) => StrictFailure(StrictFailureKind::Validation),
                _ => StrictFailure(StrictFailureKind::Execution),
            })?
        };
        used = used.checked_add(result.gas().total_gas_spent()).ok_or(StrictFailure(StrictFailureKind::Execution))?;
        let hex_output = |b: &Bytes| format!("0x{}", hex::encode(b));
        let outcome = match &result {
            ExecutionResult::Success { output, .. } => StrictOutcome::Success { output: hex_output(output.data()), stage },
            ExecutionResult::Revert { output, .. } => StrictOutcome::Revert { output: hex_output(output), stage },
            ExecutionResult::Halt { reason, .. } => StrictOutcome::Halt { reason: format!("{reason:?}"), stage },
        };
        if !result.is_success() { return Ok((outcome, used, Vec::new())); }
        if index == 0 && req.trial_prefix.is_some() {
            let _phase = diagnostic::phase(Phase::EffectsObservations);
            // Detached observation snapshot: commit a COPY of current writes
            // over a read-only view, never finalize/replace the live journal.
            // Probes cannot change its transient storage, access warmth or gas.
            *baseline = Some(if plan.native.is_empty() && plan.pairs.is_empty() && plan.supply.is_empty() {
                StrictObservationBaseline::default()
            } else {
                let mut snapshot = CacheDB::new(&*evm.ctx.journaled_state.database);
                snapshot.commit(evm.ctx.journaled_state.inner.state.clone());
                strict_observation_baseline(&snapshot, env, plan)?
            });
        } else {
            logs.extend(result.logs().iter().map(|log| SimLog { address: format!("{:#x}", log.address),
                topics: log.data.topics().iter().map(|t| format!("{t:#x}")).collect(), data: hex_output(&log.data.data) }));
        }
        if index + 1 == plan.calls.len() {
            // Commit only after every sibling succeeds. The db remains at its
            // post-override baseline on any failure; even preCall logs vanish.
            let state = evm.ctx.journaled_state.finalize();
            drop(evm);
            db.commit(state);
            return Ok((outcome, used, logs));
        }
        // Inner: retain the same transaction journal/transient/warm set. Top
        // level: Handler::execution_result already committed/reset tx-local
        // state while preserving persistent state/nonce in this sandbox.
    }
    unreachable!("strict plan always includes main")
}

fn strict_probe<D: ExecutionProfile>(db: &CacheDB<D>, env: &BlockEnv, token: Address, data: Bytes) -> Result<U256> {
    let probe = || -> Result<U256> {
        let profile = db.db.execution_profile();
        // Read-through snapshot: even observation SLOAD warmness/transient
        // storage/logs are separate. No synthetic balance, fee or nonce writes.
        let ctx = Context::mainnet().modify_cfg_chained(|cfg| strict_cfg(cfg, profile)).with_block(env.clone())
            .with_db(CacheDB::new(db)).with_tx(strict_tx(env, Address::ZERO, token, data, 300_000, 0));
        let mut evm = ctx.build_mainnet();
        let mut handler = StrictHandler::<_, EVMError<RpcError>, _>::new(Some((Address::ZERO, 0, true)));
        handler.load_accounts(&mut evm)?;
        let frame = handler.first_frame_input(&mut evm, 300_000, 0)?;
        let result = handler.run_exec_loop(&mut evm, frame)?;
        revm::context_interface::context::take_error::<EVMError<RpcError>, _>(evm.ctx.error())?;
        let bytes = result.output().into_data();
        if !result.instruction_result().is_ok() || bytes.len() != 32 { return Err(BalanceProbeRejected.into()); }
        Ok(U256::from_be_slice(&bytes))
    };
    // Keep the underlying DB/engine error: a failed speculative storage trial
    // may skip a local probe rejection, never a missing/failed source read.
    probe().context(StrictFailure(StrictFailureKind::Observation))
}

fn strict_balance_of<D: ExecutionProfile>(db: &CacheDB<D>, env: &BlockEnv, token: Address, account: Address) -> Result<U256> {
    let mut data = BALANCE_OF_SELECTOR.to_vec();
    data.extend_from_slice(&[0u8; 12]); data.extend_from_slice(account.as_slice());
    strict_probe(db, env, token, Bytes::from(data))
}

/// Pre-fetch the touched-state set of `calls` in one batched `debug_traceCall`
/// (prestateTracer) round trip and seed the shared warm cache with the returned
/// pre-values. The local overlay in `db.cache` (funded balances, token deals,
/// prior preCall writes) is sent as `stateOverrides` so the remote trace walks
/// the same path local execution will; locally-written keys are excluded from
/// seeding so synthetic values never reach the shared cache.
fn trace_prefetch(
    remote: &RemoteRevmDb,
    db: &CacheDB<SharedRemote>,
    calls: &[&ParsedPreCall],
) -> Result<SeedStats> {
    let started = Instant::now();
    let overrides = build_trace_overrides(db);
    let trace_params: Vec<(&str, Value)> = calls
        .iter()
        .map(|call| {
            (
                "debug_traceCall",
                json!([
                    {
                        "from": format!("{:#x}", call.from),
                        "to": format!("{:#x}", call.to),
                        "gas": hex_quantity_u64(call.gas_limit),
                        "data": format!("0x{}", hex::encode(&call.calldata)),
                    },
                    remote.block_tag,
                    { "tracer": "prestateTracer", "stateOverrides": overrides }
                ]),
            )
        })
        .collect();
    let results = remote.rpc.batch_call(&trace_params)?;

    let mut stats = SeedStats {
        traced_calls: calls.len(),
        ..SeedStats::default()
    };
    for result in results {
        match result {
            Err(err) => {
                stats.trace_errors += 1;
                eprintln!("[revm-sim] trace call failed: {err}");
            }
            Ok(prestate) => seed_from_prestate(remote, db, &prestate, &mut stats)?,
        }
    }
    stats.trace_ms = started.elapsed().as_millis();
    Ok(stats)
}

/// The local overlay encoded as debug_traceCall stateOverrides.
///
/// `CacheDB` also contains read-through values fetched by warm_batch/local
/// execution. Sending those real chain values back as overrides is semantically
/// harmless but expensive: the JSON-RPC server has to parse a large stateDiff
/// before tracing. We mark only synthetic/local writes as AccountState::Touched
/// (funded balances, token deals, explicit state overrides, and committed
/// preCall writes), then send only those touched accounts.
fn build_trace_overrides(db: &CacheDB<SharedRemote>) -> Value {
    let mut overrides = serde_json::Map::new();
    for (address, account) in &db.cache.accounts {
        if account.account_state == AccountState::None {
            continue;
        }

        let mut entry = serde_json::Map::new();
        entry.insert(
            "balance".to_string(),
            json!(format!("{:#x}", account.info.balance)),
        );
        if !account.storage.is_empty() {
            let mut diff = serde_json::Map::new();
            for (slot, value) in &account.storage {
                diff.insert(format!("{slot:#066x}"), json!(format!("{value:#066x}")));
            }
            entry.insert("stateDiff".to_string(), Value::Object(diff));
        }
        overrides.insert(format!("{address:#x}"), Value::Object(entry));
    }
    Value::Object(overrides)
}

/// Seed the shared remote cache from one prestateTracer result. Skips account
/// info for locally-overlaid accounts and skips (address, slot) pairs the local
/// overlay wrote, because the trace reports our synthetic override values for
/// those keys.
fn seed_from_prestate(
    remote: &RemoteRevmDb,
    db: &CacheDB<SharedRemote>,
    prestate: &Value,
    stats: &mut SeedStats,
) -> Result<()> {
    let map = prestate
        .as_object()
        .ok_or_else(|| anyhow!("prestate trace returned non-object result"))?;
    if remote.source.is_some() {
        // A trace is an optional access-key hint, never state attestation. Parse
        // all keys before hydration; malformed hints simply lose the speedup.
        let mut accounts = Vec::new();
        let mut storage = Vec::new();
        for (raw_address, fields) in map {
            let address = parse_address(strict_hex(&json!(raw_address), Some(20))?)?;
            let fields = fields.as_object().ok_or_else(|| anyhow!("invalid prestate account hint"))?;
            accounts.push(address);
            if let Some(slots) = fields.get("storage") {
                for key in slots.as_object().ok_or_else(|| anyhow!("invalid prestate storage hint"))?.keys() {
                    storage.push((address, parse_u256(strict_hex(&json!(key), Some(32))?)?));
                }
            }
        }
        let before = { let inner = remote.inner.borrow(); (inner.accounts.len(), inner.storage.len()) };
        remote.warm_batch(&accounts, &storage, None)?;
        let inner = remote.inner.borrow();
        stats.seeded_accounts += inner.accounts.len() - before.0;
        stats.seeded_slots += inner.storage.len() - before.1;
        return Ok(());
    }
    for (addr_str, fields) in map {
        let address = parse_address(addr_str)?;
        let local = db.cache.accounts.get(&address);

        if local.is_none() {
            let balance = match fields.get("balance").and_then(Value::as_str) {
                Some(value) => parse_u256(value).map_err(|err| anyhow!(err.to_string()))?,
                None => U256::ZERO,
            };
            let nonce = fields.get("nonce").and_then(Value::as_u64).unwrap_or(0);
            let bytecode = match fields.get("code").and_then(Value::as_str) {
                Some(code_hex) => {
                    let bytes = parse_hex_bytes(code_hex)?;
                    if bytes.is_empty() {
                        None
                    } else {
                        Some(Bytecode::new_raw(Bytes::from(bytes)))
                    }
                }
                None => None,
            };
            if remote.seed_account(address, balance, nonce, bytecode) {
                stats.seeded_accounts += 1;
            }
        }

        if let Some(storage) = fields.get("storage").and_then(Value::as_object) {
            for (slot_str, value) in storage {
                let slot = parse_u256(slot_str).map_err(|err| anyhow!(err.to_string()))?;
                if let Some(account) = local {
                    if account.storage.contains_key(&slot) {
                        continue;
                    }
                }
                let value_str = value
                    .as_str()
                    .ok_or_else(|| anyhow!("prestate slot value is not a string"))?;
                let parsed = parse_u256(value_str).map_err(|err| anyhow!(err.to_string()))?;
                if remote.seed_storage(address, slot, parsed) {
                    stats.seeded_slots += 1;
                }
            }
        }
    }
    Ok(())
}

fn ok_response(started: Instant) -> DaemonResponse {
    DaemonResponse {
        ok: true,
        error: None,
        success: Some(true),
        output: None,
        profit: None,
        gas_used: None,
        revert_reason: None,
        latency_ms: started.elapsed().as_millis(),
        missing_state_keys: Vec::new(),
        cache_stats: None,
        seed_stats: None,
        strict: None,
    }
}

fn erc20_balance_of<D>(
    db: &mut CacheDB<D>,
    block_env: &BlockEnv,
    token: Address,
    account: Address,
) -> Result<U256>
where
    D: ExecutionProfile,
{
    let mut data = Vec::with_capacity(36);
    data.extend_from_slice(&BALANCE_OF_SELECTOR);
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(account.as_slice());
    let output = execute_call(
        db,
        block_env,
        Address::ZERO,
        token,
        Bytes::from(data),
        300_000,
        false,
        false,
    )?;
    if !output.result.is_success() {
        return Err(anyhow!(BalanceProbeRejected).context(format!(
            "balanceOf({token:#x},{account:#x}) failed: {}", format_execution_result(&output.result)
        )));
    }
    let bytes = output
        .result
        .output()
        .ok_or(BalanceProbeRejected)?;
    Ok(parse_u256_from_evm_output(bytes.as_ref()))
}


fn signed_delta(post: U256, pre: U256) -> String {
    if post >= pre {
        (post - pre).to_string()
    } else {
        format!("-{}", pre - post)
    }
}

fn parse_pre_calls(calls: &[PreCall]) -> Result<Vec<ParsedPreCall>> {
    calls
        .iter()
        .map(|call| {
            Ok(ParsedPreCall {
                from: parse_address(&call.from)?,
                to: parse_address(&call.to)?,
                calldata: parse_hex_bytes(&call.calldata)?,
                gas_limit: call.gas_limit.unwrap_or(DEFAULT_GAS_LIMIT),
                allowance_slot: call.allowance_slot,
            })
        })
        .collect()
}

fn funded_accounts(owner: Address, pre_calls: &[ParsedPreCall]) -> HashSet<Address> {
    let mut funded = HashSet::new();
    funded.insert(owner);
    for call in pre_calls {
        funded.insert(call.from);
    }
    funded
}

fn apply_state_overrides<D>(db: &mut CacheDB<D>, overrides: &[StateOverride]) -> Result<()>
where
    D: DatabaseRef<Error = RpcError>,
{
    for item in overrides {
        let address = parse_address(&item.address)?;
        let slot = parse_u256(&item.slot).map_err(|err| anyhow!(err.to_string()))?;
        let value = parse_u256(&item.value).map_err(|err| anyhow!(err.to_string()))?;
        db.insert_account_storage(address, slot, value)
            .map_err(|err| {
                anyhow!("failed to insert storage override {address:#x}:{slot:#x}: {err}")
            })?;
        mark_account_touched(db, address);
    }
    Ok(())
}

fn apply_token_deals<D>(
    db: &mut CacheDB<D>,
    block_env: &BlockEnv,
    deals: &[TokenDeal],
    balance_slots: &mut HashMap<Address, u64>,
    remote: Option<&RemoteRevmDb>,
    strict: bool,
) -> Result<()>
where
    D: ExecutionProfile,
{
    for deal in deals {
        let token = parse_address(&deal.token)?;
        let to = parse_address(&deal.to)?;
        let amount = parse_u256(&deal.amount).map_err(|err| anyhow!(err.to_string()))?;
        if amount.is_zero() {
            continue;
        }
        if let Some(remote) = remote { remote.rpc.check_fatal()?; }
        let current = {
            let _phase = diagnostic::phase(Phase::TokenDealInitialProbe);
            deal_balance(db, block_env, token, to, strict)
        };
        if let Some(remote) = remote { remote.rpc.check_fatal()?; }
        if current? >= amount {
            continue;
        }

        let mut applied = false;
        for slot_index in
            mapping_slot_candidates(deal.balance_slot, balance_slots.get(&token).copied())
        {
            let slot = erc20_balance_slot(to, slot_index);
            if try_token_deal_slot(db, block_env, token, to, token, slot, amount, remote, strict, 1)? {
                balance_slots.insert(token, slot_index);
                applied = true;
                break;
            }
        }
        if !applied {
            // Prestate diff discovery can return nothing when both the probe
            // account and the control (0xdead) have zero balance: the tracer
            // records no storage read for an absent mapping slot, so there is
            // no observed-vs-control diff. Fall back to write-verify-restore
            // over the common mapping slots, tried on both the token itself
            // and its EIP-1967 implementation (proxy tokens keep balances in
            // the implementation's storage).
            if let Some(remote) = remote {
                let _phase = diagnostic::phase(Phase::TokenDealFallback);
                let implementation = read_eip1967_implementation(remote, token)?;
                let mut owners: Vec<Address> = vec![token];
                if let Some(impl_addr) = implementation {
                    if impl_addr != token {
                        owners.push(impl_addr);
                    }
                }
                'fallback_outer: for owner in &owners {
                    for slot_index in
                        mapping_slot_candidates(deal.balance_slot, balance_slots.get(&token).copied())
                    {
                        let slot = erc20_balance_slot(to, slot_index);
                        if try_token_deal_slot(db, block_env, token, to, *owner, slot, amount, Some(remote), strict, 1)? {
                            balance_slots.insert(token, slot_index);
                            applied = true;
                            break 'fallback_outer;
                        }
                    }
                }
            }
        }
        if !applied {
            if let Some(remote) = remote {
                let _phase = diagnostic::phase(Phase::TokenDealFallback);
                for (storage_owner, slot) in
                    discover_erc20_balance_storage_candidates(remote, token, to)?
                {
                    // Warm code for external storage owners; source errors are
                    // not a reason to try another speculative balance slot.
                    db.basic_ref(token)?;
                    db.basic_ref(storage_owner)?;
                    if try_token_deal_slot(db, block_env, token, to, storage_owner, slot, amount, Some(remote), strict, 4)? {
                        applied = true;
                        break;
                    }
                }
            }
        }
        if !applied {
            bail!("could not locate ERC20 balance slot for token {token:#x}");
        }
    }
    Ok(())
}

const EIP1967_IMPLEMENTATION_SLOT: &str =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

#[derive(Debug)]
struct BalanceProbeRejected;
impl fmt::Display for BalanceProbeRejected {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("invalid balance probe result") }
}
impl std::error::Error for BalanceProbeRejected {}

// All three candidate loops use the same speculative write boundary. Restoring
// the account snapshot also restores absent keys/account_state, so rejected
// trials cannot leak into trace overrides. Earlier accepted funding is retained.
fn try_token_deal_slot<D: ExecutionProfile>(
    db: &mut CacheDB<D>, env: &BlockEnv, token: Address, account: Address,
    owner: Address, slot: U256, amount: U256, remote: Option<&RemoteRevmDb>,
    strict: bool, attempts: usize,
) -> Result<bool> {
    let _phase = diagnostic::phase(Phase::TokenDealTrials);
    if let Some(remote) = remote { remote.rpc.check_fatal()?; }
    let original = db.cache.accounts.get(&owner).cloned();
    let result = (|| -> Result<bool> {
        db.storage(owner, slot)?;
        let mut value = amount;
        for attempt in 0..attempts {
            db.insert_account_storage(owner, slot, value)?;
            mark_account_touched(db, owner);
            let observed = if strict { strict_balance_of(db, env, token, account) }
                else { erc20_balance_of(db, env, token, account) };
            // A latched physical fault wins even over a cached successful read.
            if let Some(remote) = remote { remote.rpc.check_fatal()?; }
            let balance = match observed {
                Ok(balance) => balance,
                Err(error) if error.is::<BalanceProbeRejected>() => return Ok(false),
                Err(error) => return Err(error),
            };
            if balance >= amount { return Ok(true); }
            let Some(next) = next_discovered_balance_override(amount, value, balance, attempt) else { break; };
            value = next;
        }
        Ok(false)
    })();
    let result = if let Some(remote) = remote { remote.rpc.check_fatal().and(result) } else { result };
    if !matches!(result, Ok(true)) {
        match original {
            Some(original) => { db.cache.accounts.insert(owner, original); }
            None => { db.cache.accounts.remove(&owner); }
        }
    }
    result
}

fn deal_balance<D: ExecutionProfile>(db: &mut CacheDB<D>, env: &BlockEnv, token: Address, account: Address, strict: bool) -> Result<U256> {
    if strict { strict_balance_of(db, env, token, account) }
    else {
        match erc20_balance_of(db, env, token, account) {
            Err(error) if error.is::<BalanceProbeRejected>() => Ok(U256::ZERO),
            result => result,
        }
    }
}

/// Read the EIP-1967 implementation slot for a possibly-proxied token.
/// Returns None when the slot is empty (non-proxy) or the read fails.
fn read_eip1967_implementation(remote: &RemoteRevmDb, token: Address) -> Result<Option<Address>> {
    let value = remote.rpc.call(
        "eth_getStorageAt",
        json!([
            format!("{token:#x}"),
            EIP1967_IMPLEMENTATION_SLOT,
            remote.block_tag
        ]),
    )?;
    let raw = value_as_str(&value)?;
    let normalized = raw.strip_prefix("0x").unwrap_or(&raw);
    if normalized.chars().all(|c| c == '0') {
        return Ok(None);
    }
    // The implementation slot holds a 20-byte address right-aligned in 32
    // bytes; take the last 40 hex chars (20 bytes).
    let address_hex = &normalized[normalized.len().saturating_sub(40)..];
    let address = parse_address(&format!("0x{address_hex}"))?;
    if address.is_zero() {
        return Ok(None);
    }
    Ok(Some(address))
}

/// Exact ERC20 balance-slot discovery: trace `balanceOf(account)` with
/// prestateTracer and return every `(storage owner, slot)` the call reads.
/// Proxy metadata may sit beside the balance mapping, while some tokens keep
/// balances in an external ledger, so callers verify and restore every pair.
fn discover_erc20_balance_storage_candidates(
    remote: &RemoteRevmDb,
    token: Address,
    account: Address,
) -> Result<Vec<(Address, U256)>> {
    // Every storage slot read by balanceOf(account) is a candidate. We do
    // NOT diff against a control account: when both the probe account and
    // the control have zero balance, the tracer records the same mapping
    // slot with value 0 for both, and the diff removes the one correct
    // slot. The caller write-verifies each candidate and keeps the first
    // slot whose written value is read back as balanceOf >= amount.
    let observed = trace_erc20_balance_prestate(remote, token, account)?;
    Ok(prestate_storage_candidates(&observed, token))
}

fn trace_erc20_balance_prestate(
    remote: &RemoteRevmDb,
    token: Address,
    account: Address,
) -> Result<Value> {
    let mut data = Vec::with_capacity(36);
    data.extend_from_slice(&BALANCE_OF_SELECTOR);
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(account.as_slice());
    remote.rpc.call(
        "debug_traceCall",
        json!([
            {
                "from": format!("{:#x}", Address::ZERO),
                "to": format!("{:#x}", token),
                "data": format!("0x{}", hex::encode(&data)),
            },
            remote.block_tag,
            { "tracer": "prestateTracer" }
        ]),
    )
}

fn account_specific_storage_candidates(
    observed: &Value,
    control: &Value,
    token: Address,
) -> Vec<(Address, U256)> {
    let control_candidates = prestate_storage_candidates(control, token)
        .into_iter()
        .collect::<HashSet<_>>();
    prestate_storage_candidates(observed, token)
        .into_iter()
        .filter(|candidate| !control_candidates.contains(candidate))
        .collect()
}

fn prestate_storage_candidates(result: &Value, token: Address) -> Vec<(Address, U256)> {
    let mut candidates = result
        .as_object()
        .into_iter()
        .flat_map(|accounts| accounts.iter())
        .filter_map(|(address, entry)| {
            Some((
                parse_address(&address.to_ascii_lowercase()).ok()?,
                entry.get("storage")?.as_object()?,
            ))
        })
        .flat_map(|(address, storage)| {
            storage
                .keys()
                .filter_map(move |key| Some((address, parse_u256(key).ok()?)))
        })
        .collect::<Vec<_>>();
    candidates.sort_unstable_by(|left, right| {
        (left.0 != token)
            .cmp(&(right.0 != token))
            .then_with(|| left.0.as_slice().cmp(right.0.as_slice()))
            .then_with(|| left.1.cmp(&right.1))
    });
    candidates.dedup();
    candidates
}

fn next_discovered_balance_override(
    amount: U256,
    current: U256,
    observed: U256,
    attempt: usize,
) -> Option<U256> {
    let factor = if observed.is_zero() {
        if attempt > 0 {
            return None;
        }
        U256::from(256)
    } else {
        let quotient = amount / observed;
        quotient
            + if amount % observed == U256::ZERO {
                U256::ZERO
            } else {
                U256::from(1)
            }
    };
    if factor <= U256::from(1) {
        return None;
    }
    let next = current.checked_mul(factor)?;
    (next > current).then_some(next)
}

fn token_deals_have_known_slots(
    deals: &[TokenDeal],
    balance_slots: &HashMap<Address, u64>,
) -> Result<bool> {
    for deal in deals {
        if deal.balance_slot.is_some() {
            continue;
        }
        let token = parse_address(&deal.token)?;
        if !balance_slots.contains_key(&token) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn approve_calls_have_known_slots(
    calls: &[ParsedPreCall],
    allowance_slots: &HashMap<Address, u64>,
) -> bool {
    for call in calls {
        if decode_approve_spender(&call.calldata).is_none() {
            continue;
        }
        if call.allowance_slot.is_none() && !allowance_slots.contains_key(&call.to) {
            return false;
        }
    }
    true
}

const ERC20_MAPPING_SLOT_CANDIDATES: [u64; 10] = [0, 1, 2, 3, 4, 5, 9, 10, 11, 51];

fn mapping_slot_candidates(primary: Option<u64>, cached: Option<u64>) -> Vec<u64> {
    let mut out = Vec::with_capacity(ERC20_MAPPING_SLOT_CANDIDATES.len() + 2);
    if let Some(idx) = primary {
        push_unique_slot(&mut out, idx);
    }
    if let Some(idx) = cached {
        push_unique_slot(&mut out, idx);
    }
    for idx in ERC20_MAPPING_SLOT_CANDIDATES {
        push_unique_slot(&mut out, idx);
    }
    out
}

fn push_unique_slot(out: &mut Vec<u64>, idx: u64) {
    if !out.contains(&idx) {
        out.push(idx);
    }
}

fn mark_account_touched<D>(db: &mut CacheDB<D>, address: Address) {
    if let Some(account) = db.cache.accounts.get_mut(&address) {
        account.account_state = AccountState::Touched;
    }
}

fn erc20_balance_slot(account: Address, slot_index: u64) -> U256 {
    let mut encoded = [0u8; 64];
    encoded[12..32].copy_from_slice(account.as_slice());
    encoded[56..64].copy_from_slice(&slot_index.to_be_bytes());
    U256::from_be_slice(keccak256(encoded).as_slice())
}

fn erc20_allowance_slot(owner: Address, spender: Address, slot_index: u64) -> U256 {
    let mut inner = [0u8; 64];
    inner[12..32].copy_from_slice(owner.as_slice());
    inner[56..64].copy_from_slice(&slot_index.to_be_bytes());
    let owner_map = keccak256(inner);

    let mut outer = [0u8; 64];
    outer[12..32].copy_from_slice(spender.as_slice());
    outer[32..64].copy_from_slice(owner_map.as_slice());
    U256::from_be_slice(keccak256(outer).as_slice())
}

fn decode_approve_spender(calldata: &[u8]) -> Option<Address> {
    if calldata.len() < 4 + 32 * 2 || calldata.get(..4)? != APPROVE_SELECTOR {
        return None;
    }
    Some(Address::from_slice(calldata.get(4 + 12..4 + 32)?))
}

fn execute_call<D>(
    db: &mut CacheDB<D>,
    block_env: &BlockEnv,
    caller: Address,
    target: Address,
    data: Bytes,
    gas_limit: u64,
    stateful: bool,
    disable_eip3607: bool,
) -> Result<revm::context_interface::result::ResultAndState>
where
    D: ExecutionProfile,
{
    let mut tx = TxEnv::builder()
        .caller(caller)
        .to(target)
        .gas_limit(gas_limit)
        .gas_price(block_env.basefee as u128)
        .gas_priority_fee(Some(0))
        .value(U256::ZERO)
        .data(data)
        .chain_id(Some(1))
        .build_fill();
    tx.nonce = 0;

    let profile = db.db.execution_profile();
    let ctx = Context::mainnet()
        .modify_cfg_chained(|cfg| {
            cfg.set_spec_and_mainnet_gas_params(profile.map_or(SpecId::PRAGUE, |p| p.spec));
            if let Some(profile) = profile {
                cfg.blob_base_fee_update_fraction = Some(profile.blob_fraction);
                cfg.max_blobs_per_tx = Some(if profile.spec == SpecId::OSAKA { 6 } else { 9 });
            }
            cfg.disable_nonce_check = true;
            cfg.tx_chain_id_check = false;
            // EIP-3607 rejects a contract address as tx.origin. The
            // impersonated-call-frame mode simulates the observed actor as
            // an inner CALL msg.sender (router/executor contract that
            // internally invokes the target), which must not be blocked by
            // the top-level rule. Top-level simulations keep EIP-3607.
            cfg.disable_eip3607 = disable_eip3607;
        })
        .with_block(block_env.clone())
        .with_db(db);
    let mut evm = ctx.build_mainnet();
    let result = evm
        .transact(tx)
        .context("revm transact failed")?;
    if stateful { Ok(result) } else { Ok(result) }
}

fn load_block_env(rpc: &RpcClient, block_number: u64) -> Result<BlockEnv> {
    let block = rpc.call(
        "eth_getBlockByNumber",
        json!([hex_quantity_u64(block_number), false]),
    )?;
    block_env_from_value(&block, block_number)
}

fn block_env_from_value(block: &Value, block_number: u64) -> Result<BlockEnv> {
    if block.is_null() {
        bail!("block {block_number} not found");
    }
    let basefee = optional_hex_u64(block.get("baseFeePerGas")).unwrap_or(0);
    let mut env = BlockEnv::default();
    env.number = U256::from(block_number);
    env.timestamp = U256::from(hex_field_u64(&block, "timestamp")?);
    env.gas_limit = hex_field_u64(&block, "gasLimit")?;
    env.basefee = basefee;
    env.beneficiary = block
        .get("miner")
        .and_then(Value::as_str)
        .or_else(|| block.get("author").and_then(Value::as_str))
        .map(parse_address)
        .transpose()?
        .unwrap_or(Address::ZERO);
    env.prevrandao = block
        .get("mixHash")
        .and_then(Value::as_str)
        .map(parse_b256)
        .transpose()?;
    Ok(env)
}

fn format_execution_result(result: &ExecutionResult) -> String {
    match result {
        ExecutionResult::Success { .. } => "success".to_string(),
        ExecutionResult::Revert { output, .. } => {
            format!("revert: 0x{}", hex::encode(output.as_ref()))
        }
        ExecutionResult::Halt { reason, .. } => format!("halt: {reason:?}"),
    }
}

fn parse_u256_from_evm_output(bytes: &[u8]) -> U256 {
    if bytes.len() >= 32 {
        U256::from_be_slice(&bytes[bytes.len() - 32..])
    } else {
        U256::from_be_slice(bytes)
    }
}

fn value_as_str(value: &Value) -> Result<&str, RpcError> {
    value
        .as_str()
        .ok_or_else(|| RpcError(format!("expected hex string, got {value}")))
}

fn hex_field_u64(value: &Value, key: &str) -> Result<u64> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("block missing {key}"))
        .and_then(parse_u64)
}

fn optional_hex_u64(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_str)
        .and_then(|s| parse_u64(s).ok())
}

fn parse_address(value: &str) -> Result<Address> {
    Address::from_str(value).with_context(|| format!("invalid address {value}"))
}

fn parse_b256(value: &str) -> Result<B256, RpcError> {
    B256::from_str(value).map_err(|err| RpcError(format!("invalid b256 {value}: {err}")))
}

fn parse_u64(value: &str) -> Result<u64> {
    let s = value.strip_prefix("0x").unwrap_or(value);
    if s.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(s, 16).with_context(|| format!("invalid hex u64 {value}"))
}

fn parse_u256(value: &str) -> Result<U256, RpcError> {
    if !value.starts_with("0x") {
        return U256::from_str(value)
            .map_err(|err| RpcError(format!("invalid decimal u256 {value}: {err}")));
    }
    let bytes = parse_hex_bytes(value).map_err(|err| RpcError(err.to_string()))?;
    Ok(U256::from_be_slice(&bytes))
}

fn parse_hex_bytes(value: &str) -> Result<Vec<u8>> {
    let s = value.strip_prefix("0x").unwrap_or(value);
    if s.is_empty() {
        return Ok(Vec::new());
    }
    let owned;
    let normalized = if s.len() % 2 == 1 {
        owned = format!("0{s}");
        owned.as_str()
    } else {
        s
    };
    hex::decode(normalized).with_context(|| format!("invalid hex bytes {value}"))
}

fn hex_quantity_u64(value: u64) -> String {
    format!("0x{value:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone)]
    struct LocalStrictDb;
    impl DatabaseRef for LocalStrictDb {
        type Error = RpcError;
        fn basic_ref(&self, _: Address) -> Result<Option<AccountInfo>, RpcError> { Ok(None) }
        fn code_by_hash_ref(&self, _: B256) -> Result<Bytecode, RpcError> { Err(RpcError("unseeded test code".into())) }
        fn storage_ref(&self, _: Address, _: U256) -> Result<U256, RpcError> { Ok(U256::ZERO) }
        fn block_hash_ref(&self, _: u64) -> Result<B256, RpcError> { Ok(B256::ZERO) }
    }
    impl ExecutionProfile for LocalStrictDb {
        fn execution_profile(&self) -> Option<MainnetProfile> { Some(test_source().profile) }
    }
    fn local_strict(inner: bool, code: &str) -> (CacheDB<LocalStrictDb>, StrictRequest) {
        let actor = format!("0x{}", "aa".repeat(20));
        let target = format!("0x{}", "bb".repeat(20));
        let origin = format!("0x{}", "dd".repeat(20));
        let mut value = json!({"blockNumber":300, "from":actor, "to":target, "data":"0x", "gasLimit":100000});
        if inner { value["callerMode"] = json!("impersonated-call-frame"); value["transactionOrigin"] = json!(origin); value["executionGasLimit"] = json!(200000); }
        let req: StrictRequest = serde_json::from_value(value).unwrap();
        let mut db = CacheDB::new(LocalStrictDb);
        for (address, nonce, code) in [(actor, 7, "0x"), (origin, 9, "0x"), (target, 5, code)] {
            let bytes = Bytes::from(parse_hex_bytes(code).unwrap());
            db.insert_account_info(parse_address(&address).unwrap(), AccountInfo { nonce, balance: U256::from(20),
                code_hash: keccak256(&bytes), code: Some(Bytecode::new_raw(bytes)), ..Default::default() });
        }
        (db, req)
    }
    fn setup(req: &StrictRequest, data: &str) -> PreCall {
        PreCall { from: req.from.clone(), to: req.to.clone(), calldata: data.into(), gas_limit: Some(100000), allowance_slot: None }
    }

    fn trial_prefix(req: &mut StrictRequest) {
        req.source_pin = Some(serde_json::from_value(json!({"chainId":1,"blockHash":format!("{:#x}", B256::ZERO)})).unwrap());
        req.trial_prefix = Some(StrictTrialPrefix { executor: req.to.clone(), calldata: "0x01".into(),
            input_token: format!("0x{}", "ee".repeat(20)), input_amount: "100".into(), executor_runtime_code: None });
    }

    fn trial_state_code() -> String {
        // Setup records its CALLER and ORIGIN, writes persistent and transient
        // values. The later quote returns those plus its own caller/origin.
        let mut code = parse_hex_bytes("0x36156000573360005532600155602a600255602b60025d00").unwrap();
        code[3] = code.len() as u8;
        code.extend_from_slice(&parse_hex_bytes("0x5b336000523260205260005460405260015460605260025460805260025c60a05260c06000f3").unwrap());
        format!("0x{}", hex::encode(code))
    }

    fn trial_effect_code(receiver: Address) -> String {
        let mut code = parse_hex_bytes("0x366024146000573660041460005760003560f81c600114600057").unwrap();
        let pay = |amount| format!("0x600060006000600060{amount:02x}73{}5af150", hex::encode(receiver));
        // Current call changes its own token balance/supply and native balance.
        code.extend_from_slice(&parse_hex_bytes("0x600360005401600055600560015401600155").unwrap());
        code.extend_from_slice(&parse_hex_bytes(&pay(2)).unwrap());
        code.extend_from_slice(&parse_hex_bytes("0x600260005260206000a060003560f81c60021460005760006000fd").unwrap());
        let return_jump = code.len() - 7;
        code[return_jump] = code.len() as u8;
        code.extend_from_slice(&parse_hex_bytes("0x5b60005c60005260206000f3").unwrap());
        code[24] = code.len() as u8;
        code.extend_from_slice(&parse_hex_bytes("0x5b600a6000556014600155602b60005d").unwrap());
        code.extend_from_slice(&parse_hex_bytes(&pay(7)).unwrap());
        code.extend_from_slice(&parse_hex_bytes("0x600160005260206000a000").unwrap());
        code[5] = code.len() as u8;
        code.extend_from_slice(&parse_hex_bytes("0x5b60005460005260206000f3").unwrap());
        code[12] = code.len() as u8;
        code.extend_from_slice(&parse_hex_bytes("0x5b60015460005260206000f3").unwrap());
        assert!(code.len() < 256);
        format!("0x{}", hex::encode(code))
    }

    #[test]
    fn trial_prefix_effect_baseline_excludes_prefix_but_includes_current_setup() {
        let receiver = Address::repeat_byte(0xcc);
        for own_setup in [false, true] {
            let (mut original, mut req) = local_strict(true, &trial_effect_code(receiver));
            trial_prefix(&mut req);
            req.data = "0x02".into();
            if own_setup { req.pre_calls.push(setup(&req, "0x02")); }
            let target = parse_address(&req.to).unwrap();
            original.insert_account_storage(target, U256::ZERO, U256::from(1)).unwrap();
            original.insert_account_storage(target, U256::from(1), U256::from(2)).unwrap();
            original.insert_account_info(receiver, AccountInfo::default());
            let plan_plain = StrictPlan::validate(&req).unwrap();
            let (_, plain_gas, _) = strict_execute(&mut original.clone(), &test_source().env, &req, &plan_plain).unwrap();
            req.observe_token_balances = Some(vec![ExactTokenObservation { token: req.to.clone(), account: req.from.clone() }]);
            req.observe_total_supply = vec![req.to.clone()]; req.observe_native_balances = Some(vec![format!("{receiver:#x}")]);
            req.observe_logs = true;
            let plan = StrictPlan::validate(&req).unwrap();
            let mut db = original.clone(); let mut baseline = None;
            let (outcome, gas, logs) = strict_execute_observed(&mut db, &test_source().env, &req, &plan, &mut baseline).unwrap();
            let StrictOutcome::Success { output, .. } = outcome else { panic!("{outcome:?}"); };
            assert_eq!(parse_u256(&output).unwrap(), U256::from(43), "baseline probes must retain live transient state");
            assert_eq!(gas, plain_gas, "observation probes must not warm the live EVM");
            let before = baseline.unwrap();
            assert_eq!(before.tokens, [U256::from(10)]); assert_eq!(before.supply, [U256::from(20)]);
            assert_eq!(before.native, [U256::from(7)]);
            let after = strict_observation_baseline(&db, &test_source().env, &plan).unwrap();
            let factor = if own_setup { 2 } else { 1 };
            assert_eq!(after.tokens[0] - before.tokens[0], U256::from(3 * factor));
            assert_eq!(after.supply[0] - before.supply[0], U256::from(5 * factor));
            assert_eq!(after.native[0] - before.native[0], U256::from(2 * factor));
            assert_eq!(logs.len(), factor);
            assert!(logs.iter().all(|log| parse_u256(&log.data).unwrap() == U256::from(2)), "prefix logs must not enter quote effects");
            // Main revert accepts neither prefix nor current-call effects.
            req.data = "0x03".into();
            let plan = StrictPlan::validate(&req).unwrap();
            let mut failed = original.clone(); let mut baseline = None;
            let (outcome, _, logs) = strict_execute_observed(&mut failed, &test_source().env, &req, &plan, &mut baseline).unwrap();
            assert!(matches!(outcome, StrictOutcome::Revert { stage: StrictStage::Main, .. })); assert!(logs.is_empty());
            assert_eq!(failed.storage(target, U256::ZERO).unwrap(), U256::from(1));
            assert_eq!(failed.basic(receiver).unwrap().unwrap().balance, U256::ZERO);
        }
    }

    #[test]
    fn trial_prefix_preserves_independent_callers_origin_and_shared_transaction_state() {
        let (mut db, mut req) = local_strict(true, &trial_state_code());
        trial_prefix(&mut req);
        let plan = StrictPlan::validate(&req).unwrap();
        assert_ne!(plan.calls[0].from, plan.actor);
        let (outcome, _, _) = strict_execute(&mut db, &test_source().env, &req, &plan).unwrap();
        let StrictOutcome::Success { output, stage: StrictStage::Main } = outcome else { panic!("{outcome:?}"); };
        let words = parse_hex_bytes(&output).unwrap().chunks_exact(32).map(U256::from_be_slice).collect::<Vec<_>>();
        let addr = |s: &str| U256::from_be_slice(parse_address(s).unwrap().as_slice());
        assert_eq!(words, [addr(&req.from), addr(req.transaction_origin.as_ref().unwrap()), addr(&req.to),
            addr(req.transaction_origin.as_ref().unwrap()), U256::from(42), U256::from(43)]);
        assert_eq!(db.basic(plan.actor).unwrap().unwrap().nonce, 7);
        assert_eq!(db.basic(plan.origin).unwrap().unwrap().nonce, 9);
        assert_eq!(db.basic(plan.calls[0].from).unwrap().unwrap().nonce, 5);
    }

    #[test]
    fn trial_prefix_state_reads_use_post_prefix_journal_without_executing_the_target() {
        for storage in [true, false] {
            let code = trial_state_code();
            let (mut db, mut req) = local_strict(true, &code);
            trial_prefix(&mut req);
            db.insert_account_storage(parse_address(&req.to).unwrap(), U256::from(2), U256::from(9)).unwrap();
            req.state_read = Some(if storage { StrictStateRead::Storage { address: req.to.clone(),
                slot: format!("0x{:064x}", 2) } } else { StrictStateRead::Code { address: req.to.clone() } });
            let plan = StrictPlan::validate(&req).unwrap();
            let (outcome, gas, _) = strict_execute(&mut db, &test_source().env, &req, &plan).unwrap();
            let StrictOutcome::Success { output, stage: StrictStage::Main } = outcome else { panic!("{outcome:?}"); };
            assert_eq!(output, if storage { format!("0x{:064x}", 42) } else { code });
            assert!(gas > 0 && gas < req.execution_gas_limit.unwrap());
        }
    }

    #[test]
    fn trial_prefix_failure_is_not_a_main_quote_and_main_failure_discards_prefix_effects() {
        for prefix_fails in [true, false] {
            let code = if prefix_fails { "0x602a60005560006000a060006000fd" }
                else { "0x3615601057602a60005560006000a0005b60006000fd" };
            let (mut db, mut req) = local_strict(true, code);
            trial_prefix(&mut req);
            let target = parse_address(&req.to).unwrap();
            db.insert_account_storage(target, U256::ZERO, U256::from(9)).unwrap();
            let plan = StrictPlan::validate(&req).unwrap();
            let (outcome, _, logs) = strict_execute(&mut db, &test_source().env, &req, &plan).unwrap();
            assert!(matches!(outcome, StrictOutcome::Revert { stage: StrictStage::PreCall { index: 0 }, .. }) == prefix_fails);
            assert!(matches!(outcome, StrictOutcome::Revert { stage: StrictStage::Main, .. }) != prefix_fails);
            assert!(logs.is_empty());
            assert_eq!(db.storage(target, U256::ZERO).unwrap(), U256::from(9));
        }
    }

    #[test]
    fn trial_prefix_code_override_binds_executor_not_final_quote_target() {
        let (mut db, mut req) = local_strict(true, "0x00");
        trial_prefix(&mut req);
        let prefix = req.trial_prefix.as_mut().unwrap();
        prefix.executor = format!("0x{}", "cc".repeat(20));
        let code = "0x602a60005500";
        prefix.executor_runtime_code = Some(ExecutorRuntimeCode { code: code.into(),
            keccak256: format!("{:#x}", keccak256(parse_hex_bytes(code).unwrap())) });
        let executor = parse_address(&prefix.executor).unwrap();
        let target = parse_address(&req.to).unwrap();
        db.insert_account_info(executor, AccountInfo { balance: U256::from(87), nonce: 13, ..Default::default() });
        let target_code = db.basic(target).unwrap().unwrap().code_hash;
        let plan = StrictPlan::validate(&req).unwrap();
        assert_eq!(plan.executor_code.as_ref().unwrap().0, executor);
        apply_executor_runtime_code(&mut db, &plan).unwrap();
        assert_eq!(db.basic(target).unwrap().unwrap().code_hash, target_code);
        let (outcome, _, _) = strict_execute(&mut db, &test_source().env, &req, &plan).unwrap();
        assert!(matches!(outcome, StrictOutcome::Success { .. }));
        assert_eq!(db.storage(executor, U256::ZERO).unwrap(), U256::from(42));
        let info = db.basic(executor).unwrap().unwrap();
        assert_eq!(info.balance, U256::from(87)); assert_eq!(info.nonce, 13);
    }

    #[test]
    fn trial_prefix_rejects_unpinned_and_conflicting_context_before_any_io() {
        let address = format!("0x{}", "aa".repeat(20));
        let valid = json!({"op":"strictSimulate", "epoch":"trial-test", "requestId":"1", "blockNumber":300,
            "from":address, "to":address, "data":"0x", "callerMode":"impersonated-call-frame",
            "sourcePin":{"chainId":1,"blockHash":format!("{:#x}", B256::ZERO)},
            "transactionOrigin":format!("0x{}", "bb".repeat(20)), "executionGasLimit":100000,
            "trialPrefix":{"executor":address,"calldata":"0x01","inputToken":address,"inputAmount":"100"}});
        for patch in [json!({"sourcePin":null}), json!({"callerMode":"top-level"}), json!({"transactionOrigin":null}),
            json!({"trialPrefix":null}), json!({"stateRead":null}), json!({"nativeBalanceWei":"100"}),
            json!({"tokenDeals":[{"token":address,"to":address,"amount":"100"}]}),
            json!({"stateRead":{"kind":"get-code","address":address,"slot":"0x00"}}),
            json!({"stateRead":{"kind":"get-storage","address":address,"slot":"0x0"}}),
            json!({"stateRead":{"kind":"get-code","address":address},"observeLogs":true})] {
            let mut wire = valid.clone(); wire.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
            let mut daemon = Daemon::default();
            let response = daemon.handle_line(&wire.to_string());
            assert!(!response.response.ok); assert!(matches!(response.error_kind, Some(StrictFailureKind::Validation)));
            assert!(daemon.http.is_none()); assert!(daemon.warm.is_none()); assert!(response.fatal.is_none());
        }
    }

    #[test]
    fn executor_code_override_preserves_account_and_precedes_independent_probes() {
        let (mut db, mut req) = local_strict(false, "0x60006000fd");
        let target = parse_address(&req.to).unwrap();
        let actor = parse_address(&req.from).unwrap();
        let env = test_source().env;
        db.insert_account_storage(target, U256::ZERO, U256::from(42)).unwrap();
        let original = db.basic(target).unwrap().unwrap();
        let caller = db.basic(actor).unwrap().unwrap();
        assert!(strict_balance_of(&db, &env, target, actor).is_err());
        let code = "0x60005460005260206000f3";
        req.source_pin = Some(serde_json::from_value(json!({"chainId":1,"blockHash":format!("{:#x}", B256::ZERO)})).unwrap());
        req.executor_runtime_code = Some(ExecutorRuntimeCode { code: code.into(), keccak256: format!("{:#x}", keccak256(parse_hex_bytes(code).unwrap())) });
        let plan = StrictPlan::validate(&req).unwrap();
        apply_executor_runtime_code(&mut db, &plan).unwrap();
        let changed = db.basic(target).unwrap().unwrap();
        assert_eq!(changed.balance, original.balance);
        assert_eq!(changed.nonce, original.nonce);
        assert_ne!(changed.code_hash, original.code_hash);
        assert_eq!(db.basic(actor).unwrap().unwrap(), caller);
        assert_eq!(db.storage(target, U256::ZERO).unwrap(), U256::from(42));
        assert_eq!(strict_balance_of(&db, &env, target, actor).unwrap(), U256::from(42));
        let (outcome, _, _) = strict_execute(&mut db, &env, &req, &plan).unwrap();
        assert!(matches!(outcome, StrictOutcome::Success { .. }));
        assert_eq!(strict_balance_of(&db, &env, target, actor).unwrap(), U256::from(42));
        assert_eq!(db.basic(target).unwrap().unwrap().nonce, original.nonce);
        assert_eq!(db.basic(target).unwrap().unwrap().balance, original.balance);
        let (mut fresh, plain) = local_strict(false, "0x60006000fd");
        let plain_plan = StrictPlan::validate(&plain).unwrap();
        apply_executor_runtime_code(&mut fresh, &plain_plan).unwrap();
        assert!(matches!(strict_execute(&mut fresh, &env, &plain, &plain_plan).unwrap().0, StrictOutcome::Revert { .. }));
    }

    #[test]
    fn executor_code_override_rejects_bad_hash_unpinned_alias_and_account_fields() {
        let valid = json!({"blockNumber":300, "sourcePin":{"chainId":1,"blockHash":format!("{:#x}", B256::ZERO)},
            "from":format!("{:#x}", Address::repeat_byte(0xaa)), "to":format!("{:#x}", Address::repeat_byte(0xbb)), "data":"0x",
            "executorRuntimeCode":{"code":"0x00","keccak256":format!("{:#x}", keccak256([0u8]))}});
        assert!(StrictPlan::validate(&serde_json::from_value(valid.clone()).unwrap()).is_ok());
        let mut null = valid.clone(); null["executorRuntimeCode"] = Value::Null;
        assert!(serde_json::from_value::<StrictRequest>(null).is_err());
        for key in ["address", "balance", "nonce", "storage", "state", "stateDiff"] {
            let mut v = valid.clone(); v["executorRuntimeCode"][key] = json!("0x01");
            assert!(serde_json::from_value::<StrictRequest>(v).is_err());
        }
        for (field, value) in [("code", json!("0x")), ("code", json!("0x1")), ("keccak256", json!(format!("{:#x}", B256::ZERO)))] {
            let mut v = valid.clone(); v["executorRuntimeCode"][field] = value;
            assert!(StrictPlan::validate(&serde_json::from_value(v).unwrap()).is_err());
        }
        let mut v = valid.clone(); v.as_object_mut().unwrap().remove("sourcePin");
        assert!(StrictPlan::validate(&serde_json::from_value(v).unwrap()).is_err());
        let mut v = valid.clone(); v["to"] = v["from"].clone();
        assert!(StrictPlan::validate(&serde_json::from_value(v).unwrap()).is_err());
    }

    // Synthetic delegate proxy: changing the pointer to an empty account makes
    // balanceOf return malformed data. No chain data or network is involved.
    fn deal_proxy(pointer: U256, balance: U256, implementation_code: Option<&str>) -> (CacheDB<LocalStrictDb>, TokenDeal) {
        let mut proxy = parse_hex_bytes("0x36600060003760006000366000").unwrap();
        proxy.push(0x7f); proxy.extend_from_slice(&pointer.to_be_bytes::<32>());
        proxy.extend_from_slice(&parse_hex_bytes("0x545af43d600060003e").unwrap());
        let jump = proxy.len();
        proxy.extend_from_slice(&[0x60, 0, 0x57, 0x3d, 0x60, 0, 0xfd]);
        proxy[jump + 1] = proxy.len() as u8;
        proxy.extend_from_slice(&[0x5b, 0x3d, 0x60, 0, 0xf3]);
        let (mut db, req) = local_strict(true, &format!("0x{}", hex::encode(proxy)));
        let token = parse_address(&req.to).unwrap();
        let implementation = Address::repeat_byte(0xcc);
        let code = implementation_code.map(str::to_owned).unwrap_or_else(||
            format!("0x7f{balance:064x}5460005260206000f3"));
        let code = Bytecode::new_raw(Bytes::from(parse_hex_bytes(&code).unwrap()));
        db.insert_account_info(implementation, AccountInfo::default().with_code(code));
        db.insert_account_storage(token, pointer, U256::from_be_slice(implementation.as_slice())).unwrap();
        db.cache.accounts.get_mut(&token).unwrap().account_state = AccountState::None;
        (db, TokenDeal { token: req.to, to: req.from, amount: "100".into(), balance_slot: None })
    }

    #[test]
    fn token_deal_primary_bad_pointer_restored_before_next_candidate() {
        let account = Address::repeat_byte(0xaa);
        let bad = erc20_balance_slot(account, 0);
        let good = erc20_balance_slot(account, 1);
        for first in [0, 1] {
            let (mut db, mut deal) = deal_proxy(bad, good, None);
            deal.balance_slot = Some(first);
            let token = parse_address(&deal.token).unwrap();
            let original = db.storage(token, bad).unwrap();
            let mut slots = HashMap::new();
            let result = apply_token_deals(&mut db, &test_source().env, &[deal], &mut slots, None, true);
            assert_eq!(db.storage(token, bad).unwrap(), original, "rejected proxy pointer must be restored");
            assert!(result.is_ok(), "failed trial must continue to the valid balance slot: {result:?}");
            assert_eq!(strict_balance_of(&db, &test_source().env, token, account).unwrap(), U256::from(100));
            assert_eq!(slots.get(&token), Some(&1));
            assert_eq!(db.storage(token, good).unwrap(), U256::from(100));
        }
    }

    #[test]
    fn token_deal_rejected_trials_restore_absence_account_state_and_prior_funding() {
        let account = Address::repeat_byte(0xaa);
        let bad = erc20_balance_slot(account, 0);
        // The real balance is outside the primary candidate list.
        let (mut db, deal) = deal_proxy(bad, U256::MAX, None);
        let token = parse_address(&deal.token).unwrap();
        let unrelated = Address::repeat_byte(0xee);
        db.insert_account_info(unrelated, AccountInfo::default().with_balance(U256::from(777)));
        db.insert_account_storage(token, U256::from(7), U256::from(888)).unwrap();
        for state in [AccountState::None, AccountState::Touched] {
            db.cache.accounts.get_mut(&token).unwrap().account_state = state;
            let before = format!("{:?}", db.cache.accounts.get(&token));
            let unrelated_before = format!("{:?}", db.cache.accounts.get(&unrelated));
            let mut slots = HashMap::from([(unrelated, 51)]);
            assert!(apply_token_deals(&mut db, &test_source().env, std::slice::from_ref(&deal), &mut slots, None, true).is_err());
            assert_eq!(format!("{:?}", db.cache.accounts.get(&token)), before);
            assert_eq!(format!("{:?}", db.cache.accounts.get(&unrelated)), unrelated_before);
            assert_eq!(slots, HashMap::from([(unrelated, 51)]));
        }
    }

    #[test]
    fn token_deal_initial_untouched_balance_failure_is_not_a_trial() {
        for code in ["0x00", "0x60006000fd", "0xfe"] {
            let (mut db, deal) = deal_proxy(U256::from(2), U256::MAX, Some(code));
            let before = format!("{:?}", db.cache);
            let mut slots = HashMap::new();
            assert!(apply_token_deals(&mut db, &test_source().env, &[deal], &mut slots, None, true).is_err());
            assert_eq!(format!("{:?}", db.cache), before);
            assert!(slots.is_empty());
        }
    }

    #[test]
    fn token_deal_discovered_proxy_order_and_scaled_balance_keep_verified_candidate_only() {
        let pointer = parse_u256(EIP1967_IMPLEMENTATION_SLOT).unwrap();
        let balance = U256::MAX;
        for reverse in [false, true] {
            // balanceOf = storage / 2, requiring the existing second scaled write.
            let code = format!("0x60027f{balance:064x}540460005260206000f3");
            let (mut db, deal) = deal_proxy(pointer, balance, Some(&code));
            let token = parse_address(&deal.token).unwrap();
            let account = parse_address(&deal.to).unwrap();
            let original = db.storage(token, pointer).unwrap();
            let observed = json!({format!("{token:#x}"): {"storage": {
                format!("{balance:#066x}"): "0x0", EIP1967_IMPLEMENTATION_SLOT: format!("{original:#x}")}}});
            let mut candidates = prestate_storage_candidates(&observed, token);
            assert_eq!(candidates, vec![(token, pointer), (token, balance)], "proxy metadata sorts first");
            if reverse { candidates.reverse(); }
            let mut applied = false;
            for (owner, slot) in candidates {
                if try_token_deal_slot(&mut db, &test_source().env, token, account, owner, slot, U256::from(100), None, true, 4).unwrap() {
                    applied = true; break;
                }
                assert_eq!(db.storage(token, pointer).unwrap(), original);
            }
            assert!(applied);
            assert_eq!(db.storage(token, pointer).unwrap(), original);
            assert_eq!(db.storage(token, balance).unwrap(), U256::from(200));
            assert_eq!(strict_balance_of(&db, &test_source().env, token, account).unwrap(), U256::from(100));
        }
    }

    #[test]
    fn token_deal_fallback_owner_trials_restore_rejected_token_and_absent_owner() {
        let account = Address::repeat_byte(0xaa);
        let slot = erc20_balance_slot(account, 1);
        let (mut db, deal) = deal_proxy(U256::from(2), slot, None);
        let token = parse_address(&deal.token).unwrap();
        let ledger = Address::repeat_byte(0xcc);
        // The real balance is in an external ledger, reached by STATICCALL.
        let code = format!("0x602060006000600073{ledger:x}5afa5060206000f3");
        let code = Bytecode::new_raw(Bytes::from(parse_hex_bytes(&code).unwrap()));
        db.insert_account_info(token, AccountInfo::default().with_code(code));
        for owner in [Address::repeat_byte(0xef), token, ledger] {
            let before = format!("{:?}", db.cache.accounts.get(&owner));
            let applied = try_token_deal_slot(&mut db, &test_source().env, token, account, owner, slot, U256::from(100), None, true, 1).unwrap();
            assert_eq!(applied, owner == ledger);
            if !applied { assert_eq!(format!("{:?}", db.cache.accounts.get(&owner)), before); }
        }
        assert_eq!(strict_balance_of(&db, &test_source().env, token, account).unwrap(), U256::from(100));
    }

    #[test]
    fn token_deal_domain_trial_failures_restore_then_continue_in_both_probe_modes() {
        let account = Address::repeat_byte(0xaa);
        let bad = erc20_balance_slot(account, 0);
        let good = erc20_balance_slot(account, 1);
        for strict in [false, true] {
            for attempts in [1, 4] {
                // Empty/malformed output, REVERT, INVALID and out of gas.
                for code in ["0x00", "0x60016000f3", "0x60006000fd", "0x606460005260206000fd", "0xfe", "0x5b600056"] {
                    let (mut db, deal) = deal_proxy(bad, good, None);
                    let token = parse_address(&deal.token).unwrap();
                    let code = Bytecode::new_raw(Bytes::from(parse_hex_bytes(code).unwrap()));
                    db.insert_account_info(Address::from_word(B256::from(U256::from(100).to_be_bytes::<32>())), AccountInfo::default().with_code(code));
                    let before = format!("{:?}", db.cache.accounts.get(&token));
                    let mut env = test_source().env; env.basefee = 0;
                    assert!(!try_token_deal_slot(&mut db, &env, token, account, token, bad, U256::from(100), None, strict, attempts).unwrap());
                    assert_eq!(format!("{:?}", db.cache.accounts.get(&token)), before);
                    assert!(try_token_deal_slot(&mut db, &env, token, account, token, good, U256::from(100), None, strict, attempts).unwrap());
                    assert_eq!(deal_balance(&mut db, &env, token, account, strict).unwrap(), U256::from(100));
                    assert_eq!(deal.to, format!("{account:#x}"));
                }
            }
        }
    }

    #[derive(Debug)]
    struct DealFaultDb {
        fatal: FatalLatch,
        reason: Option<FatalReason>,
        success_after_fault: bool,
        reads: Cell<usize>,
    }
    impl DatabaseRef for DealFaultDb {
        type Error = RpcError;
        fn basic_ref(&self, address: Address) -> Result<Option<AccountInfo>, RpcError> {
            if address != Address::from_word(B256::from(U256::from(100).to_be_bytes::<32>())) { return Ok(None); }
            self.reads.set(self.reads.get() + 1);
            self.fatal.set(self.reason);
            if !self.success_after_fault { return Err(RpcError("injected database read failure".into())); }
            Ok(Some(AccountInfo::default().with_code(Bytecode::new_raw(Bytes::from_static(&[0x60, 100, 0x60, 0, 0x52, 0x60, 32, 0x60, 0, 0xf3])))))
        }
        fn code_by_hash_ref(&self, _: B256) -> Result<Bytecode, RpcError> { Err(RpcError("unexpected test code read".into())) }
        fn storage_ref(&self, _: Address, _: U256) -> Result<U256, RpcError> { Ok(U256::ZERO) }
        fn block_hash_ref(&self, _: u64) -> Result<B256, RpcError> { Ok(B256::ZERO) }
    }
    impl ExecutionProfile for DealFaultDb {
        fn execution_profile(&self) -> Option<MainnetProfile> { Some(test_source().profile) }
    }
    fn deal_guard(fatal: FatalLatch) -> RemoteRevmDb {
        RemoteRevmDb::new("http://127.0.0.1:1".into(), 300, HashSet::new(),
            Rc::new(RefCell::new(PersistentCache::default())), Client::builder().no_proxy().build().unwrap(), fatal).unwrap()
    }

    #[test]
    fn token_deal_db_errors_and_fatal_latches_restore_and_never_try_next_candidate() {
        let account = Address::repeat_byte(0xaa);
        let bad = erc20_balance_slot(account, 0);
        let good = erc20_balance_slot(account, 1);
        for strict in [false, true] {
            for reason in [None, Some(FatalReason::SourceFault), Some(FatalReason::RpcThrottle {
                category: ThrottleCategory::Http429, http_status: Some(429), rpc_code: None })] {
                for success_after_fault in [false, true] {
                    if reason.is_none() && success_after_fault { continue; }
                    let (base, deal) = deal_proxy(bad, good, None);
                    let token = parse_address(&deal.token).unwrap();
                    let remote = deal_guard(FatalLatch::default());
                    let mut db = CacheDB::new(DealFaultDb { fatal: remote.rpc.fatal.clone(), reason, success_after_fault, reads: Cell::new(0) });
                    db.cache = base.cache;
                    let mut env = test_source().env; env.basefee = 0;
                    // Legacy initial reads may populate real read-through keys;
                    // the trial must restore the state after that untouched read.
                    assert_eq!(deal_balance(&mut db, &env, token, account, strict).unwrap(), U256::ZERO);
                    let before = format!("{:?}", db.cache.accounts.get(&token));
                    let mut slots = HashMap::new();
                    let error = apply_token_deals(&mut db, &env, &[deal], &mut slots, Some(&remote), strict).unwrap_err();
                    assert_eq!(format!("{:?}", db.cache.accounts.get(&token)), before);
                    assert!(slots.is_empty());
                    assert_eq!(db.db.reads.get(), 1);
                    assert_eq!(remote.rpc.fatal.get(), reason);
                    if let Some(reason) = reason {
                        assert_eq!(error.downcast_ref::<FatalReason>(), Some(&reason));
                        assert!(remote.rpc.check_fatal().is_err());
                    } else {
                        assert!(matches!(error.downcast_ref::<EVMError<RpcError>>(), Some(EVMError::Database(_))), "{error:?}");
                    }
                    assert_eq!(remote.rpc.round_trips(), 0, "in-memory faults only; no RPC");
                }
            }
        }
    }

    #[test]
    fn token_deal_existing_fatal_beats_cached_sufficient_balance_without_writes() {
        let (mut db, deal) = deal_proxy(U256::from(2), U256::from(3), None);
        let token = parse_address(&deal.token).unwrap();
        db.insert_account_storage(token, U256::from(3), U256::from(100)).unwrap();
        let remote = deal_guard(Rc::new(Cell::new(Some(FatalReason::SourceFault))));
        let before = format!("{:?}", db.cache);
        let error = apply_token_deals(&mut db, &test_source().env, &[deal], &mut HashMap::new(), Some(&remote), true).unwrap_err();
        assert_eq!(error.downcast_ref::<FatalReason>(), Some(&FatalReason::SourceFault));
        assert_eq!(format!("{:?}", db.cache), before);
        assert_eq!(remote.rpc.round_trips(), 0);
    }

    #[test]
    fn token_deal_rejected_trials_do_not_change_trace_overrides_or_earlier_deal() {
        let pointer = parse_u256(EIP1967_IMPLEMENTATION_SLOT).unwrap();
        let balance = U256::MAX;
        let (base, deal) = deal_proxy(pointer, balance, None);
        let token = parse_address(&deal.token).unwrap();
        let account = parse_address(&deal.to).unwrap();
        let remote = Rc::new(deal_guard(FatalLatch::default()));
        let mut db = CacheDB::new(SharedRemote(remote.clone()));
        db.cache = base.cache;
        // Preseed all reads so the actual production remote wrapper performs no I/O.
        db.insert_account_info(Address::ZERO, AccountInfo::default());
        db.insert_account_info(Address::from_word(B256::from(U256::from(200).to_be_bytes::<32>())), AccountInfo::default());
        for slot in [balance, U256::from(7)] { remote.inner.borrow_mut().storage.insert((token, slot), U256::ZERO); }
        for prior_deal in [false, true] {
            if prior_deal {
                assert!(try_token_deal_slot(&mut db, &test_source().env, token, account, token, balance, U256::from(100), Some(&remote), true, 1).unwrap());
            }
            let before = build_trace_overrides(&db);
            for slot in [pointer, U256::from(7)] {
                assert!(!try_token_deal_slot(&mut db, &test_source().env, token, account, token, slot, U256::from(200), Some(&remote), true, 4).unwrap());
                assert_eq!(build_trace_overrides(&db), before);
            }
            assert_eq!(strict_balance_of(&db, &test_source().env, token, account).unwrap(), U256::from(if prior_deal { 100 } else { 0 }));
        }
        assert_eq!(remote.rpc.round_trips(), 0);
    }

    #[test]
    fn strict_sibling_calls_have_fresh_memory() {
        // A CALL's memory is fresh even when prior siblings share storage and
        // transient state. First sibling writes 0x42; main reads untouched 0.
        for inner in [false, true] {
            let (mut db, mut req) = local_strict(inner, "0x60005160005260206000f3");
            let setup_target = format!("0x{}", "cc".repeat(20));
            let bytes = Bytes::from(parse_hex_bytes("0x604260005200").unwrap());
            db.insert_account_info(parse_address(&setup_target).unwrap(), AccountInfo {
                code_hash: keccak256(&bytes), code: Some(Bytecode::new_raw(bytes)), ..Default::default()
            });
            let mut pre = setup(&req, "0x"); pre.to = setup_target;
            req.pre_calls = vec![pre];
            let plan = StrictPlan::validate(&req).unwrap();
            let (outcome, _, _) = strict_execute(&mut db, &test_source().env, &req, &plan).unwrap();
            let StrictOutcome::Success { output, .. } = outcome else { panic!("unexpected outcome"); };
            assert_eq!(output, format!("0x{}", "00".repeat(32)), "memory leaked across inner={inner} sibling CALLs");
        }
    }

    #[test]
    fn strict_sibling_memory_size_and_expansion_reset_each_call() {
        // Every sibling checks fresh MSIZE, return-data and low/high memory,
        // then dirties both words and returns nonempty data. Three calls also
        // prove memory expansion is charged anew, not inherited from a sibling.
        let mut code = parse_hex_bytes("0x593d176000511761400051171560005760006000fd").unwrap();
        code[14] = code.len() as u8;
        code.extend_from_slice(&parse_hex_bytes("0x5b604260005260436140005260206000f3").unwrap());
        for inner in [false, true] {
            let (mut db, mut req) = local_strict(inner, &format!("0x{}", hex::encode(&code)));
            let plan = StrictPlan::validate(&req).unwrap();
            let (single, single_gas, _) = strict_execute(&mut db.clone(), &test_source().env, &req, &plan).unwrap();
            assert!(matches!(single, StrictOutcome::Success { .. }));
            req.pre_calls = vec![setup(&req, "0x"), setup(&req, "0x")];
            let plan = StrictPlan::validate(&req).unwrap();
            let (outcome, gas, _) = strict_execute(&mut db, &test_source().env, &req, &plan).unwrap();
            let StrictOutcome::Success { output, .. } = outcome else { panic!("sibling memory check failed: {outcome:?}"); };
            assert_eq!(parse_u256(&output).unwrap(), U256::from(0x42));
            assert_eq!(gas, single_gas * 3, "memory expansion gas leaked across inner={inner} siblings");
        }
    }

    #[test]
    fn strict_sibling_memory_reset_preserves_transaction_state() {
        let warmed = Address::repeat_byte(0xcc);
        // Nonempty setup: SSTORE/TSTORE, dirty memory, and warm another account.
        let mut code = parse_hex_bytes("0x3615600057602a600055602b60005d604460005260456101005273").unwrap();
        code.extend_from_slice(warmed.as_slice());
        code.extend_from_slice(&[0x31, 0x50, 0x00]); // BALANCE; POP; STOP
        code[3] = code.len() as u8;
        // Empty main returns [initial MSIZE, untouched memory, SLOAD value/cost,
        // TLOAD value, BALANCE value/cost]. Costs include PUSH/SWAP/GAS (8 gas).
        code.extend_from_slice(&parse_hex_bytes(concat!(
            "0x5b5960005261010051602052",
            "5a600054905a9003606052604052",
            "60005c6080525a73"
        )).unwrap());
        code.extend_from_slice(warmed.as_slice());
        code.extend_from_slice(&parse_hex_bytes("0x31905a900360c05260a05260e06000f3").unwrap());
        for inner in [false, true] {
            let (mut db, mut req) = local_strict(inner, &format!("0x{}", hex::encode(&code)));
            db.insert_account_info(warmed, AccountInfo { balance: U256::from(55), ..Default::default() });
            req.pre_calls = vec![setup(&req, "0x01")];
            let plan = StrictPlan::validate(&req).unwrap();
            let (outcome, _, _) = strict_execute(&mut db, &test_source().env, &req, &plan).unwrap();
            let StrictOutcome::Success { output, .. } = outcome else { panic!("unexpected outcome: {outcome:?}"); };
            let words = parse_hex_bytes(&output).unwrap().chunks_exact(32).map(U256::from_be_slice).collect::<Vec<_>>();
            assert_eq!(words, [0u64, 0, 42, if inner { 108 } else { 2108 },
                if inner { 43 } else { 0 }, 55, if inner { 108 } else { 2608 }].map(U256::from),
                "CALL-local reset changed shared state for inner={inner}");
            assert_eq!(db.storage(plan.calls.last().unwrap().to, U256::ZERO).unwrap(), U256::from(42));

            // A new simulation keeps committed storage, never the previous
            // transaction's transient state or warm account/storage sets.
            req.pre_calls.clear();
            let plan = StrictPlan::validate(&req).unwrap();
            let (outcome, _, _) = strict_execute(&mut db, &test_source().env, &req, &plan).unwrap();
            let StrictOutcome::Success { output, .. } = outcome else { panic!("unexpected outcome: {outcome:?}"); };
            let words = parse_hex_bytes(&output).unwrap().chunks_exact(32).map(U256::from_be_slice).collect::<Vec<_>>();
            assert_eq!(words, [0u64, 0, 42, 2108, 0, 55, 2608].map(U256::from));
        }
    }

    #[test]
    fn strict_nonce_conventions_preserve_inner_origin_actor_and_top_level_progression() {
        for inner in [false, true] {
            let (mut db, mut req) = local_strict(inner, "0x00");
            req.pre_calls = vec![setup(&req, "0x"), setup(&req, "0x")];
            let plan = StrictPlan::validate(&req).unwrap();
            if inner {
                let mut info = db.basic(plan.origin).unwrap().unwrap(); info.nonce = u64::MAX;
                db.insert_account_info(plan.origin, info);
            }
            let (outcome, _, _) = strict_execute(&mut db, &test_source().env, &req, &plan).unwrap();
            assert!(matches!(outcome, StrictOutcome::Success { .. }));
            assert_eq!(db.basic(plan.actor).unwrap().unwrap().nonce, if inner { 7 } else { 10 });
            if inner { assert_eq!(db.basic(plan.origin).unwrap().unwrap().nonce, u64::MAX); }
            assert_eq!(db.basic(plan.actor).unwrap().unwrap().balance, U256::from(20));
        }
    }

    #[test]
    fn strict_nested_create_changes_only_real_creator_nonce() {
        let (mut db, req) = local_strict(true, "0x600060006000f060005260206000f3");
        let plan = StrictPlan::validate(&req).unwrap();
        let (result, _, _) = strict_execute(&mut db, &test_source().env, &req, &plan).unwrap();
        assert!(matches!(result, StrictOutcome::Success { .. }));
        assert_eq!(db.basic(parse_address(&req.to).unwrap()).unwrap().unwrap().nonce, 6);
        assert_eq!(db.basic(plan.actor).unwrap().unwrap().nonce, 7);
        assert_eq!(db.basic(plan.origin).unwrap().unwrap().nonce, 9);
    }

    #[test]
    fn strict_failed_main_rolls_back_setup_storage_nonce_and_logs() {
        // Nonempty calldata performs a setup write/log; empty calldata reverts.
        for inner in [false, true] {
            let (mut db, mut req) = local_strict(inner, "0x3615601057600160005560006000a0005b60006000fd");
            let to = parse_address(&req.to).unwrap();
            db.insert_account_storage(to, U256::ZERO, U256::from(9)).unwrap();
            req.pre_calls = vec![setup(&req, "0x01")];
            let plan = StrictPlan::validate(&req).unwrap();
            let (outcome, _, logs) = strict_execute(&mut db, &test_source().env, &req, &plan).unwrap();
            assert!(matches!(outcome, StrictOutcome::Revert { stage: StrictStage::Main, .. }));
            assert!(logs.is_empty()); assert_eq!(db.storage(to, U256::ZERO).unwrap(), U256::from(9));
            assert_eq!(db.basic(plan.actor).unwrap().unwrap().nonce, 7);
        }
    }

    #[test]
    fn strict_static_probes_cannot_change_cache_state_or_execution_warmness() {
        let (db, req) = local_strict(true, "0x60005460005260206000f3");
        let target = parse_address(&req.to).unwrap();
        let snapshot = format!("{:?}", db.cache);
        assert_eq!(strict_probe(&db, &test_source().env, target, Bytes::new()).unwrap(), U256::ZERO);
        assert_eq!(format!("{:?}", db.cache), snapshot);
        let plan = StrictPlan::validate(&req).unwrap();
        let mut probed = db.clone(); let mut unprobed = db;
        let (_, probed_gas, _) = strict_execute(&mut probed, &test_source().env, &req, &plan).unwrap();
        let (_, plain_gas, _) = strict_execute(&mut unprobed, &test_source().env, &req, &plan).unwrap();
        assert_eq!(probed_gas, plain_gas);
        for code in ["0x600160005560005460005260206000f3", "0x600160005d60005c60005260206000f3", "0x60006000a060206000f3"] {
            let (db, req) = local_strict(true, code); let before = format!("{:?}", db.cache);
            assert!(strict_probe(&db, &test_source().env, parse_address(&req.to).unwrap(), Bytes::new()).is_err());
            assert_eq!(format!("{:?}", db.cache), before);
        }
    }

    #[test]
    fn strict_raw_daemon_validation_rejects_new_shape_faults_before_endpoint_resolution() {
        let (_, req) = local_strict(true, "0x00");
        for extra in [json!({"nativeBalanceWei":"-1"}), json!({"nativeBalanceWei":null}), json!({"value":"1"}),
            json!({"transactionOrigin":null}), json!({"executionGasLimit":0}),
            json!({"observeTokenBalances":[], "observeTokens":[]}),
            json!({"observeTokenBalances":[{"token":req.to,"account":req.from},{"token":req.to,"account":req.from}]}),
            json!({"preCalls":[{"from":req.from,"to":req.to,"calldata":"0x","value":"1"}]})] {
            let mut daemon = Daemon::default();
            let mut wire = json!({"op":"strictSimulate","epoch":"strict-test","requestId":"1","blockNumber":300,
                "from":req.from,"to":req.to,"data":"0x","callerMode":"impersonated-call-frame",
                "transactionOrigin":req.transaction_origin,"executionGasLimit":100000});
            wire.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            let response = daemon.handle_line(&wire.to_string());
            assert!(!response.response.ok); assert!(matches!(response.error_kind, Some(StrictFailureKind::Validation)));
            assert!(daemon.http.is_none()); assert!(daemon.warm.is_none()); assert!(response.fatal.is_none());
        }
    }

    fn pinned_header() -> Value {
        json!({"number":"0x12c", "hash":format!("0x{}", "11".repeat(32)),
            "parentHash":format!("0x{}", "22".repeat(32)), "stateRoot":format!("0x{}", "33".repeat(32)),
            "timestamp":"0x6b49d200", "gasLimit":"0x1c9c380", "gasUsed":"0x0", "baseFeePerGas":"0x1",
            "miner":format!("0x{}", "44".repeat(20)), "mixHash":format!("0x{}", "55".repeat(32)),
            "difficulty":"0x0", "nonce":"0x0000000000000000",
            "sha3Uncles":"0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347", "uncles":[],
            "transactionsRoot":format!("0x{}", "66".repeat(32)), "receiptsRoot":format!("0x{}", "77".repeat(32)),
            "withdrawalsRoot":format!("0x{}", "88".repeat(32)), "parentBeaconBlockRoot":format!("0x{}", "99".repeat(32)),
            "requestsHash":format!("0x{}", "aa".repeat(32)), "logsBloom":format!("0x{}", "00".repeat(256)),
            "extraData":"0x", "blobGasUsed":"0x0", "excessBlobGas":"0x0"})
    }

    fn test_source() -> VerifiedSource {
        verified_header(&pinned_header(), 300, &SourcePin { chain_id: 1,
            block_hash: format!("0x{}", "11".repeat(32)), state_root: None }).unwrap()
    }

    #[test]
    fn pinned_profile_boundaries_and_checked_blob_arithmetic() {
        for (time, spec, fraction, max_blobs) in [
            (1_746_612_311, SpecId::PRAGUE, 5_007_716, 9),
            (1_764_798_550, SpecId::PRAGUE, 5_007_716, 9),
            (1_764_798_551, SpecId::OSAKA, 5_007_716, 9),
            (1_765_290_070, SpecId::OSAKA, 5_007_716, 9),
            (1_765_290_071, SpecId::OSAKA, 8_346_193, 15),
            (1_767_747_670, SpecId::OSAKA, 8_346_193, 15),
            (1_767_747_671, SpecId::OSAKA, 11_684_671, 21),
        ] {
            assert_eq!(mainnet_profile(time).unwrap(), MainnetProfile { spec, blob_fraction: fraction, max_block_blobs: max_blobs });
            for excess in [0, 1, 131_072, 16_777_216, 50_000_000] {
                assert_eq!(pinned_blob_price(excess, fraction).unwrap(),
                    revm::context_interface::block::calc_blob_gasprice(excess, fraction));
            }
            assert!(pinned_blob_price(u64::MAX, fraction).is_err());
        }
        assert!(mainnet_profile(1_746_612_310).is_err());
    }

    #[test]
    fn pinned_header_has_no_missing_or_malformed_environment_defaults() {
        let h = pinned_header();
        let pin = SourcePin { chain_id: 1, block_hash: h["hash"].as_str().unwrap().into(), state_root: None };
        assert!(verified_header(&h, 300, &pin).is_ok());
        for key in h.as_object().unwrap().keys() {
            let mut bad = h.clone(); bad.as_object_mut().unwrap().remove(key);
            assert!(verified_header(&bad, 300, &pin).is_err(), "missing {key}");
        }
        for (key, value) in [
            ("timestamp", json!(1)), ("baseFeePerGas", json!("0x00")),
            ("gasLimit", json!("0x0")), ("gasUsed", json!("0xffffffffffffffff")),
            ("excessBlobGas", json!("0xffffffffffffffff")), ("stateRoot", json!("0x00")),
            ("blobGasUsed", json!("0x1")), ("difficulty", json!("0x1")),
            ("parentHash", json!("0xzz")), ("extraData", json!(format!("0x{}", "11".repeat(33)))),
        ] {
            let mut bad = h.clone(); bad[key] = value;
            assert!(verified_header(&bad, 300, &pin).is_err(), "invalid {key}");
        }
    }

    fn source_batch_reply() -> Value {
        json!([{"jsonrpc":"2.0","id":0,"result":"0x1"},
            {"jsonrpc":"2.0","id":1,"result":pinned_header()},
            {"jsonrpc":"2.0","id":2,"result":pinned_header()}])
    }

    #[test]
    fn verify_source_batch_matches_serial_precheck_in_one_round_trip() {
        let header = pinned_header();
        for root in [None, Some(header["stateRoot"].as_str().unwrap().to_owned())] {
            let pin = SourcePin { chain_id: 1, block_hash: header["hash"].as_str().unwrap().into(), state_root: root };
            // Measure the former three-call precheck against the same source.
            let (mut serial, thread) = rpc_fixture_steps(vec![
                (200, json!({"jsonrpc":"2.0","id":1,"result":"0x1"})),
                (200, json!({"jsonrpc":"2.0","id":1,"result":header})),
                (200, json!({"jsonrpc":"2.0","id":1,"result":header})),
            ]);
            serial.pinned = true;
            assert_eq!(parse_u64(strict_quantity(&serial.call("eth_chainId", json!([])).unwrap(), 16).unwrap()).unwrap(), pin.chain_id);
            let source = verified_header(&serial.call("eth_getBlockByHash", json!([pin.block_hash, false])).unwrap(), 300, &pin).unwrap();
            verify_canonical(&serial, &source).unwrap();
            assert_eq!(serial.round_trips(), 3);
            assert_eq!(thread.join().unwrap().len(), 3);

            for order in [[0, 1, 2], [2, 0, 1], [1, 2, 0]] {
                let body = source_batch_reply();
                let (mut rpc, thread) = rpc_fixture(200, json!(order.map(|id| body[id].clone())));
                rpc.pinned = true;
                assert_eq!(verify_source(&rpc, 300, &pin).unwrap(), source);
                assert_eq!(rpc.fatal.get(), None);
                assert_eq!(rpc.round_trips(), 1);
                assert_eq!(thread.join().unwrap(), vec![json!([
                    {"jsonrpc":"2.0","id":0,"method":"eth_chainId","params":[]},
                    {"jsonrpc":"2.0","id":1,"method":"eth_getBlockByHash","params":[pin.block_hash, false]},
                    {"jsonrpc":"2.0","id":2,"method":"eth_getBlockByNumber","params":["0x12c", false]},
                ])]);
            }
        }
    }

    // Full strict requests against deterministic loopback replies, never chain
    // RPC. Request 1 creates the pinned session; request 2 reuses it. Explicit
    // diagnostics injection avoids reading or changing environment in this test.
    fn strict_phase_fixture(enabled: bool, code: &str, observation_failure: bool, changed: bool)
        -> (Vec<Value>, Vec<Value>, Vec<Value>) {
        let hydration: Vec<_> = (0..9).map(|id| json!({"jsonrpc":"2.0","id":id,
            "result":if id % 3 == 2 { "0x" } else { "0x0" }})).collect();
        let mut last_header = pinned_header();
        if changed { last_header["baseFeePerGas"] = json!("0x2"); }
        let (rpc, peer) = rpc_fixture_steps(vec![
            (200, source_batch_reply()), (200, json!(hydration)),
            (200, json!({"jsonrpc":"2.0","id":1,"result":pinned_header()})),
            (200, source_batch_reply()),
            (200, json!({"jsonrpc":"2.0","id":1,"result":last_header})),
        ]);
        let mut daemon = daemon_fixture(&rpc);
        let mut responses = Vec::new();
        let mut metrics = Vec::new();
        assert!(diagnostic::take_strict_record().is_none());
        for id in 1u64..=2 {
            diagnostic::capture_progress();
            let mut wire = json!({"op":"strictSimulate","epoch":"must-not-echo","requestId":id.to_string(),
                "blockNumber":300,"rpcUrl":rpc.url,
                "sourcePin":{"chainId":1,"blockHash":pinned_header()["hash"]},
                "from":format!("{:#x}", Address::repeat_byte(0xaa)),
                "to":format!("{:#x}", Address::repeat_byte(0xbb)),"data":"0x","gasLimit":100000,
                "executorRuntimeCode":{"code":code,"keccak256":format!("{:#x}", keccak256(parse_hex_bytes(code).unwrap()))}});
            if observation_failure { wire["observeTotalSupply"] = json!([wire["to"]]); }
            let mut response = serde_json::to_value(daemon.handle_line_with_diagnostics(&wire.to_string(), enabled)).unwrap();
            let progress = diagnostic::take_progress();
            if enabled {
                assert_eq!(progress.first().unwrap()["event"], "interval-begin");
                assert_eq!(progress.last().unwrap()["event"], "interval-end");
                assert!(progress.iter().all(|r| r["identity"]["requestId"] == id &&
                    r["identity"]["sourceBlock"] == 300 && r["identity"]["interval"] == "scalar"));
                assert_eq!(progress.iter().filter(|r| r["event"] == "rpc-attempt-begin").count(), if id == 1 { 3 } else { 2 });
                assert!(!json!(progress).to_string().contains("must-not-echo"));
            } else { assert!(progress.is_empty()); }
            // Wall time is the only intentionally nondeterministic response field.
            response.as_object_mut().unwrap().remove("latencyMs");
            responses.push(response);
            if let Some(record) = diagnostic::take_strict_record() {
                assert!(!record.to_string().contains(&rpc.url));
                assert!(!record.to_string().contains("must-not-echo"));
                assert_eq!(record["identity"]["requestId"], id);
                assert_eq!(record["identity"]["sourceBlock"], 300);
                assert_eq!(record["identity"]["prefixPresent"], false);
                assert_eq!(record["rpcAttempts"], if id == 1 { 3 } else { 2 });
                assert_eq!(record["phases"]["source-precheck"]["rpcAttempts"], 1);
                assert_eq!(record["phases"]["hydration"]["rpcAttempts"], if id == 1 { 1 } else { 0 });
                assert_eq!(record["phases"]["canonical-postcheck"]["rpcAttempts"], 1);
                let sum: u64 = record["phases"].as_object().unwrap().values()
                    .map(|p| p["rpcAttempts"].as_u64().unwrap()).sum();
                assert_eq!(sum, record["rpcAttempts"].as_u64().unwrap());
                metrics.push(record);
            }
        }
        (responses, peer.join().unwrap(), metrics)
    }

    #[test]
    fn strict_phase_diagnostics_preserve_results_rpc_order_and_first_reused_session_totals() {
        for (code, observation_failure, changed) in [
            ("0x00", false, false), ("0x60006000fd", false, false), ("0xfe", false, false),
            ("0x00", true, false), ("0x00", false, true),
        ] {
            let (plain, plain_rpc, off) = strict_phase_fixture(false, code, observation_failure, changed);
            let (timed, timed_rpc, on) = strict_phase_fixture(true, code, observation_failure, changed);
            assert_eq!(plain, timed);
            assert_eq!(plain_rpc, timed_rpc);
            assert_eq!(timed_rpc.len(), 5);
            assert!(off.is_empty()); assert_eq!(on.len(), 2);
            assert_eq!(on[1]["fatal"], changed);
            assert_eq!(on[1]["ok"], !changed && !observation_failure);
            if changed {
                assert_eq!(timed[1]["fatal"]["kind"], "source-fault");
                assert!(timed[1].get("strict").is_none());
            } else if observation_failure {
                assert_eq!(timed[1]["errorKind"], "observation");
            } else {
                assert_eq!(timed[1]["strict"]["outcome"]["kind"],
                    if code == "0x00" { "Success" } else if code == "0xfe" { "Halt" } else { "Revert" });
            }
        }
    }

    #[test]
    fn strict_phase_diagnostics_preserve_prefix_gas_transient_state_and_outputs() {
        let mut outputs = Vec::new();
        for enabled in [false, true] {
            let (mut db, mut req) = local_strict(true, &trial_state_code());
            trial_prefix(&mut req);
            let plan = StrictPlan::validate(&req).unwrap();
            diagnostic::begin_strict(enabled, Instant::now());
            let (outcome, gas, logs) = strict_execute(&mut db, &test_source().env, &req, &plan).unwrap();
            diagnostic::finish_strict(diagnostic::StrictTimingIdentity { request_id: Some(1), source_block: Some(300),
                prefix_present: true, prefix_calldata_bytes: Some(1) }, true, Some(true), false);
            let StrictOutcome::Success { output, .. } = &outcome else { panic!("{outcome:?}"); };
            let words = parse_hex_bytes(output).unwrap().chunks_exact(32).map(U256::from_be_slice).collect::<Vec<_>>();
            assert_eq!(&words[4..], &[U256::from(42), U256::from(43)]);
            // CacheDB has no PartialEq; compare ordered structural projections,
            // including code/account_id omitted by AccountInfo's PartialEq.
            let accounts = db.cache.accounts.iter().map(|(address, account)| (*address,
                (account.info.balance, account.info.nonce, account.info.code_hash,
                    account.info.account_id.map(|id| id.get()), account.info.code.clone(),
                    account.account_state.clone(), account.storage.iter().map(|(k, v)| (*k, *v))
                        .collect::<std::collections::BTreeMap<_, _>>())))
                .collect::<std::collections::BTreeMap<_, _>>();
            let contracts = db.cache.contracts.iter().map(|(hash, code)| (*hash, code.clone()))
                .collect::<std::collections::BTreeMap<_, _>>();
            let blocks = db.cache.block_hashes.iter().map(|(number, hash)| (*number, *hash))
                .collect::<std::collections::BTreeMap<_, _>>();
            outputs.push((serde_json::to_value(outcome).unwrap(), gas, serde_json::to_value(logs).unwrap(),
                (accounts, contracts, db.cache.logs.clone(), blocks)));
            let record = diagnostic::take_strict_record();
            if enabled {
                let record = record.unwrap();
                assert_eq!(record["rpcAttempts"], 0);
                assert_eq!(record["phases"]["prefix-execution"]["entries"], 1);
                assert_eq!(record["phases"]["main-read-setup"]["entries"], 1);
                assert_eq!(record["phases"]["effects-observations"]["entries"], 1);
            } else { assert!(record.is_none()); }
        }
        assert_eq!(outputs[0], outputs[1]);
    }

    #[test]
    fn strict_phase_physical_attempts_include_retries_across_distinct_clients() {
        diagnostic::begin_strict(true, Instant::now());
        let (first, peer) = rpc_transport_fixture(vec![RpcFixtureReply::Disconnect,
            RpcFixtureReply::Http(200, json!({"jsonrpc":"2.0","id":1,"result":"0x1"}).to_string())]);
        {
            let _phase = diagnostic::phase(Phase::SourcePrecheck);
            first.call("eth_chainId", json!([])).unwrap();
        }
        assert_eq!(peer.join().unwrap().len(), 2);
        let (second, peer) = rpc_fixture(200, json!({"jsonrpc":"2.0","id":1,"result":"0x1"}));
        {
            let _phase = diagnostic::phase(Phase::CanonicalPostcheck);
            second.call("eth_chainId", json!([])).unwrap();
        }
        peer.join().unwrap();
        diagnostic::finish_strict(diagnostic::StrictTimingIdentity { request_id: Some(1), source_block: Some(300),
            prefix_present: false, prefix_calldata_bytes: None }, true, Some(true), false);
        let record = diagnostic::take_strict_record().unwrap();
        assert_eq!(record["rpcAttempts"], first.round_trips() + second.round_trips());
        assert_eq!(record["rpcAttempts"], 3);
        assert_eq!(record["phases"]["source-precheck"]["rpcAttempts"], 2);
        assert_eq!(record["phases"]["canonical-postcheck"]["rpcAttempts"], 1);
    }

    #[test]
    fn strict_progress_attempt_scopes_cover_success_error_and_retry_without_changing_io() {
        for case in 0..4 {
            let mut runs = Vec::new();
            for enabled in [false, true] {
                let success = || RpcFixtureReply::Http(200,
                    json!({"jsonrpc":"2.0","id":1,"result":"0x1"}).to_string());
                let replies = match case {
                    0 => vec![success()],
                    1 => vec![RpcFixtureReply::Http(200, "not-json".into())],
                    2 => vec![RpcFixtureReply::Disconnect, success()],
                    _ => vec![RpcFixtureReply::Http(429, "not-json".into())],
                };
                let (rpc, peer) = rpc_transport_fixture(replies);
                diagnostic::capture_progress();
                let started = Instant::now();
                diagnostic::begin_strict(enabled, started);
                let identity = diagnostic::StrictTimingIdentity { request_id: Some(71), source_block: Some(300),
                    prefix_present: true, prefix_calldata_bytes: Some(1) };
                if enabled { diagnostic::bind_strict_identity(&identity, started); }
                let result = {
                    let _phase = diagnostic::phase(Phase::SourcePrecheck);
                    rpc.call("eth_chainId", json!([]))
                };
                let fatal = rpc.fatal.get();
                diagnostic::finish_strict(identity, result.is_ok(), None, fatal.is_some());
                let records = diagnostic::take_progress();
                let terminal = diagnostic::take_strict_record();
                let calls = peer.join().unwrap();
                let count = if case == 2 { 2 } else { 1 };
                assert_eq!(calls.len(), count);
                assert_eq!(result.is_ok(), case == 0 || case == 2);
                if enabled {
                    let attempts: Vec<_> = records.iter().filter(|r| r["attemptId"].is_number()).collect();
                    assert_eq!(attempts.len(), 2 * count);
                    for (index, pair) in attempts.chunks_exact(2).enumerate() {
                        assert_eq!(pair[0]["event"], "rpc-attempt-begin");
                        assert_eq!(pair[1]["event"], "rpc-attempt-end");
                        assert_eq!(pair[0]["attemptId"], index + 1);
                        assert_eq!(pair[1]["attemptId"], index + 1);
                        assert_eq!(pair[0]["identity"]["requestId"], 71);
                        assert_eq!(pair[1]["identity"]["sourceBlock"], 300);
                        assert!(pair[1].get("success").is_none(), "end cannot imply success");
                    }
                    assert_eq!(terminal.unwrap()["rpcAttempts"], count);
                    assert!(!json!(records).to_string().contains(&rpc.url));
                } else { assert!(records.is_empty()); assert!(terminal.is_none()); }
                runs.push((result.ok(), fatal, calls));
            }
            assert_eq!(runs[0], runs[1]);
        }
    }

    #[test]
    fn strict_progress_begin_is_available_while_actual_rpc_response_is_held() {
        let (arrived, wait_arrived) = std::sync::mpsc::channel();
        let (release, wait_release) = std::sync::mpsc::channel();
        let (progress, progress_rx) = std::sync::mpsc::sync_channel(128);
        let worker = std::thread::spawn(move || {
            let (rpc, peer) = rpc_transport_fixture(vec![RpcFixtureReply::Held(arrived, wait_release)]);
            diagnostic::observe_progress(progress);
            let started = Instant::now();
            diagnostic::begin_strict(true, started);
            let identity = diagnostic::StrictTimingIdentity { request_id: Some(72), source_block: Some(300),
                prefix_present: true, prefix_calldata_bytes: Some(1) };
            diagnostic::bind_strict_identity(&identity, started);
            {
                let _phase = diagnostic::phase(Phase::PrefixExecution);
                assert_eq!(rpc.call("eth_chainId", json!([])).unwrap(), json!("0x1"));
            }
            diagnostic::finish_strict(identity, true, Some(true), false);
            assert_eq!(diagnostic::take_strict_record().unwrap()["rpcAttempts"], 1);
            assert_eq!(peer.join().unwrap().len(), 1);
        });
        wait_arrived.recv_timeout(Duration::from_secs(5)).unwrap();
        let before: Vec<_> = progress_rx.try_iter().collect();
        assert!(before.iter().any(|r| r["event"] == "rpc-attempt-begin" &&
            r["identity"]["requestId"] == 72 && r["phase"] == "prefix-execution"));
        assert!(!before.iter().any(|r| r["event"] == "rpc-attempt-end" || r["event"] == "interval-end"));
        release.send(()).unwrap();
        worker.join().unwrap();
        let after: Vec<_> = progress_rx.try_iter().collect();
        assert_eq!(after.iter().filter(|r| r["event"] == "rpc-attempt-end").count(), 1);
        assert_eq!(after.last().unwrap()["event"], "interval-end");
    }

    #[test]
    fn strict_phase_separates_funding_probe_prefix_and_main_cold_reads() {
        let mut runs = Vec::new();
        for enabled in [false, true] {
            let (rpc, peer) = rpc_fixture_steps([100u64, 7, 9].into_iter()
                .map(|value| (200, json!({"jsonrpc":"2.0","id":1,"result":format!("0x{value:064x}")}))).collect());
            let source = test_source();
            let mut remote = RemoteRevmDb::new(rpc.url.clone(), 300, HashSet::new(),
                Rc::new(RefCell::new(PersistentCache::default())), rpc.client.clone(), Rc::clone(&rpc.fatal)).unwrap();
            remote.rpc.pinned = true;
            remote.block_tag = json!({"blockHash":source.attestation.block_hash,"requireCanonical":true});
            remote.source = Some(source.clone());
            let actor = Address::repeat_byte(0xaa);
            let executor = Address::repeat_byte(0xbb);
            let target = Address::repeat_byte(0xcc);
            let origin = Address::repeat_byte(0xdd);
            let token = Address::repeat_byte(0xee);
            let prefix_code = "0x602a5460005260206000f3";
            for (address, code) in [(Address::ZERO, "0x"), (actor, "0x"), (origin, "0x"),
                (executor, "0x"), (token, "0x60ff5460005260206000f3"), (target, "0x602b5460005260206000f3")] {
                remote.seed_account(address, U256::ZERO, 0, Some(Bytecode::new_raw(Bytes::from(parse_hex_bytes(code).unwrap()))));
            }
            for index in mapping_slot_candidates(None, None) {
                remote.seed_storage(token, erc20_balance_slot(executor, index), U256::ZERO);
            }
            let req: StrictRequest = serde_json::from_value(json!({"blockNumber":300,
                "sourcePin":{"chainId":1,"blockHash":source.attestation.block_hash},
                "from":actor,"to":target,"data":"0x","gasLimit":100000,
                "callerMode":"impersonated-call-frame","transactionOrigin":origin,"executionGasLimit":200000,
                "trialPrefix":{"executor":executor,"calldata":"0x01","inputToken":token,"inputAmount":"100",
                    "executorRuntimeCode":{"code":prefix_code,"keccak256":format!("{:#x}", keccak256(parse_hex_bytes(prefix_code).unwrap()))}}})).unwrap();
            let plan = StrictPlan::validate(&req).unwrap();
            let started = Instant::now();
            diagnostic::begin_strict(enabled, started);
            let response = Daemon::strict_simulate_at(Rc::new(remote), source.env, &mut HashMap::new(),
                &mut HashMap::new(), &req, &plan, started).unwrap();
            diagnostic::finish_strict(diagnostic::StrictTimingIdentity { request_id: Some(1), source_block: Some(300),
                prefix_present: true, prefix_calldata_bytes: Some(1) }, response.ok, response.success, false);
            assert_eq!(response.success, Some(true));
            assert_eq!(parse_u256(response.output.as_deref().unwrap()).unwrap(), U256::from(9));
            let requests = peer.join().unwrap();
            assert_eq!(requests.len(), 3);
            for (request, (address, slot)) in requests.iter().zip([(token, "0xff"), (executor, "0x2a"), (target, "0x2b")]) {
                assert_eq!(request["method"], "eth_getStorageAt");
                assert_eq!(request["params"][0], format!("{address:#x}"));
                assert_eq!(request["params"][1], slot);
            }
            if enabled {
                let record = diagnostic::take_strict_record().unwrap();
                assert_eq!(record["rpcAttempts"], 3);
                for phase in ["token-deal-initial-probe", "prefix-execution", "main-read-setup"] {
                    assert_eq!(record["phases"][phase]["rpcAttempts"], 1, "{phase}");
                }
                assert_eq!(record["phases"]["hydration"]["rpcAttempts"], 0);
                assert_eq!(record["phases"]["token-deal"]["rpcAttempts"], 0, "child probe is exclusive");
            } else { assert!(diagnostic::take_strict_record().is_none()); }
            let mut response = serde_json::to_value(response).unwrap();
            response.as_object_mut().unwrap().remove("latencyMs");
            runs.push((response, requests));
        }
        assert_eq!(runs[0], runs[1]);
    }

    fn pair_bridge_reply() -> Value {
        json!([{"jsonrpc":"2.0","id":0,"result":pinned_header()},
            {"jsonrpc":"2.0","id":1,"result":"0x1"},
            {"jsonrpc":"2.0","id":2,"result":pinned_header()},
            {"jsonrpc":"2.0","id":3,"result":pinned_header()}])
    }

    fn pair_post_reply() -> Value { json!({"jsonrpc":"2.0","id":1,"result":pinned_header()}) }

    fn pair_wire(url: &str, code: &str) -> Value {
        let child = |id: &str| json!({"requestId":id,"blockNumber":300,"rpcUrl":url,
            "sourcePin":{"chainId":1,"blockHash":pinned_header()["hash"],"stateRoot":pinned_header()["stateRoot"]},
            "from":Address::repeat_byte(0xaa),"to":Address::repeat_byte(0xbb),"data":"0x","gasLimit":100000,
            "callerMode":"impersonated-call-frame","transactionOrigin":Address::repeat_byte(0xdd),"executionGasLimit":200000,
            "trialPrefix":{"executor":Address::repeat_byte(0xbb),"calldata":"0x01",
                "inputToken":Address::repeat_byte(0xee),"inputAmount":"100",
                "executorRuntimeCode":{"code":code,"keccak256":format!("{:#x}", keccak256(parse_hex_bytes(code).unwrap()))}}});
        json!({"op":"strictPair","epoch":"pair-test","requests":[child("1"),child("2")]})
    }

    fn pair_daemon(rpc: &RpcClient, token_code: &str) -> (Daemon, Rc<RemoteRevmDb>) {
        let mut daemon = daemon_fixture(rpc);
        let source = test_source();
        let mut remote = RemoteRevmDb::new(rpc.url.clone(), 300, HashSet::new(),
            Rc::new(RefCell::new(PersistentCache::default())), rpc.client.clone(), Rc::clone(&rpc.fatal)).unwrap();
        remote.rpc.pinned = true;
        remote.block_tag = json!({"blockHash":source.attestation.block_hash,"requireCanonical":true});
        remote.source = Some(source.clone());
        for address in [Address::ZERO, source.env.beneficiary, Address::repeat_byte(0xaa),
            Address::repeat_byte(0xbb), Address::repeat_byte(0xcc), Address::repeat_byte(0xdd), Address::repeat_byte(0xee)] {
            let code = if address == Address::repeat_byte(0xee) { token_code } else { "0x" };
            remote.seed_account(address, U256::from(1000), 0,
                Some(Bytecode::new_raw(Bytes::from(parse_hex_bytes(code).unwrap()))));
            for slot in 0..4 { remote.seed_storage(address, U256::from(slot), U256::ZERO); }
        }
        for index in mapping_slot_candidates(None, None) {
            remote.seed_storage(Address::repeat_byte(0xee), erc20_balance_slot(Address::repeat_byte(0xbb), index), U256::ZERO);
        }
        let remote = Rc::new(remote);
        daemon.pinned = Some(PinnedSession { remote: Rc::clone(&remote), balance_slots: HashMap::new(), allowance_slots: HashMap::new() });
        (daemon, remote)
    }

    fn pair_responses(bytes: &[u8]) -> Vec<Value> {
        std::str::from_utf8(bytes).unwrap().lines().map(|line| {
            let mut value: Value = serde_json::from_str(line).unwrap();
            value.as_object_mut().unwrap().remove("latencyMs");
            value
        }).collect()
    }

    #[test]
    fn strict_pair_matches_scalar_outcomes_gas_attestations_and_isolation_with_eight_checks() {
        // Increment both storage and transient state in prefix, return both in
        // main, and emit logs. A reused journal would return 2 instead of 1.
        let mut isolated = parse_hex_bytes("0x361560005760005460010160005560005c60010160005d60006000a000").unwrap();
        isolated[3] = isolated.len() as u8;
        isolated.extend(parse_hex_bytes("0x5b60005460005260005c60205260006000a060406000f3").unwrap());
        let isolated = format!("0x{}", hex::encode(isolated));
        // Prefix success writes storage/transient state. Revert, Halt, failed
        // initial balance probe, and admitted-but-invalid EVM gas also retain postchecks.
        for (code, token, evm_validation) in [
            (trial_state_code(), "0x606460005260206000f3", false),
            (isolated.clone(), "0x606460005260206000f3", false),
            ("0x3615600657005b60006000fd".into(), "0x606460005260206000f3", false),
            ("0x3615600657005bfe".into(), "0x606460005260206000f3", false),
            ("0x60006000fd".into(), "0x606460005260206000f3", false),
            ("0xfe".into(), "0x606460005260206000f3", false),
            (trial_state_code(), "0x00", false),
            (trial_state_code(), "0x606460005260206000f3", true),
        ] {
            let mut runs = Vec::new();
            for (paired, enabled) in [(false, false), (true, false), (true, true)] {
                let replies = if paired { vec![source_batch_reply(), pair_bridge_reply(), pair_post_reply()] }
                    else { vec![source_batch_reply(), pair_post_reply(), source_batch_reply(), pair_post_reply()] };
                let (rpc, peer) = rpc_fixture_steps(replies.into_iter().map(|v| (200, v)).collect());
                let (mut daemon, remote) = pair_daemon(&rpc, token);
                let mut wire = pair_wire(&rpc.url, &code);
                if evm_validation { for child in wire["requests"].as_array_mut().unwrap() { child["executionGasLimit"] = json!(100_000_000); } }
                let mut bytes = Vec::new();
                if paired { daemon.handle_line_streaming(&wire.to_string(), enabled, &mut bytes).unwrap(); }
                else {
                    for mut child in wire["requests"].as_array().unwrap().clone() {
                        child["op"] = json!("strictSimulate"); child["epoch"] = wire["epoch"].clone();
                        daemon.handle_line_streaming(&child.to_string(), enabled, &mut bytes).unwrap();
                    }
                }
                let responses = pair_responses(&bytes);
                assert_eq!(responses.len(), 2);
                if evm_validation { assert_eq!(responses[0]["errorKind"], "validation"); }
                else if token == "0x00" { assert_eq!(responses[0]["errorKind"], "observation"); }
                else {
                    let kind = if code.ends_with("fe") { "Halt" } else if code.ends_with("fd") { "Revert" } else { "Success" };
                    assert_eq!(responses[0]["strict"]["outcome"]["kind"], kind, "{responses:?}");
                    assert_eq!(responses[0]["strict"], responses[1]["strict"], "fresh warm/transient/gas state per request");
                    assert_eq!(responses[0]["sourceAttestation"], serde_json::to_value(&test_source().attestation).unwrap());
                    if code == isolated {
                        let bytes = parse_hex_bytes(responses[0]["output"].as_str().unwrap()).unwrap();
                        assert_eq!(bytes.chunks_exact(32).map(U256::from_be_slice).collect::<Vec<_>>(), vec![U256::from(1); 2]);
                    }
                }
                assert!(remote.inner.borrow().storage.values().all(|v| v.is_zero()), "no request-local writes escape");
                let calls = peer.join().unwrap();
                assert_eq!(calls.len(), if paired { 3 } else { 4 });
                let logical: Vec<_> = calls.iter().flat_map(|v| v.as_array().cloned().unwrap_or_else(|| vec![v.clone()]))
                    .map(|mut v| { v.as_object_mut().unwrap().remove("id"); v }).collect();
                assert_eq!(logical.len(), 8);
                if paired { assert_eq!(calls[1].as_array().unwrap().len(), 4); }
                let record = diagnostic::take_pair_record();
                if enabled {
                    let record = record.unwrap();
                    assert_eq!(record["rpcAttempts"], 3);
                    assert_eq!(record["first"]["rpcAttempts"], 1);
                    assert_eq!(record["bridge"]["rpcAttempts"], 1);
                    assert_eq!(record["second"]["rpcAttempts"], 1);
                    assert_eq!(record["bridgeChecks"]["logicalCount"], 4);
                    assert_eq!(record["childRequestIds"], json!([1,2]));
                    assert!(!record.to_string().contains(&rpc.url));
                    assert!(!record.to_string().contains("pair-test"));
                    assert!(diagnostic::take_strict_record().is_none());
                } else { assert!(record.is_none()); }
                runs.push((responses, logical));
            }
            assert_eq!(runs[0], runs[1]); assert_eq!(runs[1], runs[2]);
        }
    }

    struct PairFlushFence {
        bytes: Vec<u8>,
        flushes: usize,
        remote: Rc<RemoteRevmDb>,
        fail_first: bool,
    }
    impl IoWrite for PairFlushFence {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { self.bytes.extend_from_slice(bytes); Ok(bytes.len()) }
        fn flush(&mut self) -> io::Result<()> {
            self.flushes += 1;
            if self.flushes == 1 {
                assert_eq!(pair_responses(&self.bytes).len(), 1);
                assert!(!self.remote.inner.borrow().storage.contains_key(&(Address::repeat_byte(0xcc), U256::from(42))),
                    "B must not begin its main state read before A flush");
                if self.fail_first { return Err(io::Error::from(io::ErrorKind::BrokenPipe)); }
            }
            Ok(())
        }
    }

    #[test]
    fn strict_pair_flushes_a_before_b_reads_and_broken_flush_never_executes_b() {
        for fail_first in [false, true] {
            let mut replies = vec![source_batch_reply(), pair_bridge_reply()];
            if !fail_first { replies.extend([json!({"jsonrpc":"2.0","id":1,"result":format!("0x{:064x}", 9)}), pair_post_reply()]); }
            let (rpc, peer) = rpc_fixture_steps(replies.into_iter().map(|v| (200, v)).collect());
            let (mut daemon, remote) = pair_daemon(&rpc, "0x606460005260206000f3");
            let mut wire = pair_wire(&rpc.url, &trial_state_code());
            wire["requests"][1]["to"] = json!(Address::repeat_byte(0xcc));
            wire["requests"][1]["stateRead"] = json!({"kind":"get-storage","address":Address::repeat_byte(0xcc),"slot":format!("0x{:064x}",42)});
            let mut out = PairFlushFence { bytes: Vec::new(), flushes: 0, remote, fail_first };
            assert_eq!(daemon.handle_line_streaming(&wire.to_string(), false, &mut out).is_err(), fail_first);
            assert_eq!(out.flushes, if fail_first { 1 } else { 2 });
            let replies = pair_responses(&out.bytes);
            assert_eq!(replies[0]["ok"], true, "{replies:?}");
            if !fail_first { assert_eq!(parse_u256(replies[1]["output"].as_str().unwrap()).unwrap(), U256::from(9)); }
            assert_eq!(peer.join().unwrap().len(), if fail_first { 2 } else { 4 });
            assert_eq!(daemon.last_request_id, 2);
        }
    }

    #[test]
    fn strict_pair_invalid_groups_and_context_mismatches_do_no_io_or_reserve_ids() {
        let valid = pair_wire("http://127.0.0.1:1", &trial_state_code());
        let mut invalid = Vec::new();
        for (key, value) in [("epoch", json!("")), ("requestId", json!("1")), ("extra", json!(1)),
            ("requests", json!([])), ("requests", json!([valid["requests"][0]])),
            ("requests", json!([valid["requests"][0],valid["requests"][1],valid["requests"][1]]))] {
            let mut wire = valid.clone(); wire[key] = value; invalid.push(wire);
        }
        for id in [json!(null),json!(2),json!("0"),json!("01"),json!("1"),json!("18446744073709551616")] {
            let mut wire = valid.clone(); wire["requests"][1]["requestId"] = id; invalid.push(wire);
        }
        for (key, value) in [("op", json!("strictSimulate")), ("epoch", json!("pair-test")), ("extra", json!(1)),
            ("rpcUrl", json!(null)), ("blockNumber", json!(301)), ("from", json!(Address::repeat_byte(0xcc))),
            ("transactionOrigin", json!(Address::repeat_byte(0xcc))), ("callerMode", json!("top-level")),
            ("gasLimit", json!(100001)), ("executionGasLimit", json!(200001)),
            ("trialPrefix", json!(null)), ("sourcePin", json!(null)), ("nativeBalanceWei", json!("1")),
            ("observeLogs", json!(true)), ("observeAccounts", json!([Address::repeat_byte(0xaa)])),
            ("observeTotalSupply", json!([Address::repeat_byte(0xee)])),
            ("observeNativeBalances", json!([Address::repeat_byte(0xaa)])),
            ("preCalls", json!([{"from":Address::repeat_byte(0xaa),"to":Address::repeat_byte(0xbb),"calldata":"0x"}])),
            ("tokenDeals", json!([{"token":Address::repeat_byte(0xee),"to":Address::repeat_byte(0xaa),"amount":"1"}]))] {
            let mut wire = valid.clone(); wire["requests"][1][key] = value; invalid.push(wire);
        }
        for field in ["inputAmount", "calldata", "executor", "inputToken"] {
            let mut wire = valid.clone(); wire["requests"][1]["trialPrefix"][field] = json!("different"); invalid.push(wire);
        }
        for (key, value) in [("chainId",json!(2)), ("blockHash",json!("0x12")), ("stateRoot",json!(null))] {
            let mut wire = valid.clone();
            for child in wire["requests"].as_array_mut().unwrap() { child["sourcePin"][key] = value.clone(); }
            invalid.push(wire);
        }
        for wire in invalid {
            let mut daemon = Daemon::default(); let mut bytes = Vec::new();
            daemon.handle_line_streaming(&wire.to_string(), false, &mut bytes).unwrap();
            let responses = pair_responses(&bytes);
            assert_eq!(responses.len(), 1); assert_eq!(responses[0]["requestId"], Value::Null);
            assert_eq!(responses[0]["errorKind"], "validation"); assert_eq!(responses[0]["ok"], false);
            assert_eq!(daemon.last_request_id, 0); assert!(daemon.epoch.is_none());
            assert!(daemon.http.is_none()); assert!(daemon.pinned.is_none()); assert!(daemon.fatal.get().is_none());
        }
        let line = valid.to_string();
        assert!(StrictPair::validate(valid.clone(), STRICT_PAIR_MAX_BYTES).is_ok());
        let oversized = format!("{line}{}", " ".repeat(STRICT_PAIR_MAX_BYTES + 1 - line.len()));
        let mut daemon = Daemon::default(); let mut bytes = Vec::new();
        daemon.handle_line_streaming(&oversized, false, &mut bytes).unwrap();
        assert_eq!(pair_responses(&bytes)[0]["errorKind"], "validation"); assert!(daemon.http.is_none());
        for (epoch, last_id) in [("different",0), ("pair-test",1), ("pair-test",2)] {
            let mut daemon = Daemon { epoch: Some(epoch.into()), last_request_id: last_id, ..Daemon::default() };
            let mut bytes = Vec::new(); daemon.handle_line_streaming(&line, false, &mut bytes).unwrap();
            assert_eq!(pair_responses(&bytes)[0]["requestId"], Value::Null);
            assert!(daemon.http.is_none()); assert_eq!(daemon.last_request_id, last_id);
        }
    }

    #[test]
    fn strict_pair_bridge_uses_fresh_second_evidence_and_accepts_reordered_rpc_items() {
        for order in [[0,1,2,3], [3,1,0,2], [2,0,3,1]] {
            let mut body = pair_bridge_reply();
            // Same fixed source identity, separately obtained complete B header.
            // Returning A's evidence instead would fail this regression.
            for id in [2,3] { body[id]["result"]["baseFeePerGas"] = json!("0x2"); }
            let (mut rpc, peer) = rpc_fixture(200, json!(order.map(|id| body[id].clone())));
            rpc.pinned = true;
            let first = test_source();
            let pin = SourcePin { chain_id: 1, block_hash: pinned_header()["hash"].as_str().unwrap().into(), state_root: None };
            let second = verify_pair_bridge(&rpc, &first, 300, &pin).unwrap();
            assert_eq!(first.env.basefee, 1); assert_eq!(second.env.basefee, 2);
            let mut daemon = daemon_fixture(&rpc);
            let session = daemon.take_pinned_session(rpc, &second);
            assert_eq!(session.remote.source.as_ref(), Some(&second));
            let calls = peer.join().unwrap();
            assert_eq!(calls.len(), 1); assert_eq!(calls[0].as_array().unwrap().len(), 4);
            assert_eq!(calls[0][0]["method"], "eth_getBlockByNumber");
            assert_eq!(calls[0][3]["method"], "eth_getBlockByNumber");
            assert_ne!(calls[0][0]["id"], calls[0][3]["id"]);
        }
    }

    #[test]
    fn strict_pair_bridge_faults_bar_b_and_override_completed_a() {
        let mut faults = Vec::new();
        for id in 0..4 {
            for fault in ["missing", "duplicate", "unknown-id", "no-id", "version", "no-result", "error", "quota"] {
                let mut body = pair_bridge_reply();
                match fault {
                    "missing" => { body.as_array_mut().unwrap().remove(id); }
                    "duplicate" => { let item = body[id].clone(); body.as_array_mut().unwrap().push(item); }
                    "unknown-id" => body[id]["id"] = json!(99),
                    "no-id" => { body[id].as_object_mut().unwrap().remove("id"); }
                    "version" => body[id]["jsonrpc"] = json!("1.0"),
                    "no-result" => { body[id].as_object_mut().unwrap().remove("result"); }
                    "error" | "quota" => body[id] = json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,
                        "message":if fault == "quota" { "quota exceeded" } else { "ordinary failure" }}}),
                    _ => unreachable!(),
                }
                body.as_array_mut().unwrap().reverse();
                faults.push((body, fault == "quota"));
            }
        }
        for id in [0,2,3] {
            for (key, value) in [("number",json!("0x12d")), ("hash",json!(format!("0x{}","ff".repeat(32)))),
                ("stateRoot",json!(format!("0x{}","ff".repeat(32)))), ("timestamp",json!("0x1")),
                ("gasLimit",json!("0x0")), ("baseFeePerGas",json!("0x2"))] {
                let mut body = pair_bridge_reply(); body[id]["result"][key] = value;
                faults.push((body, false));
            }
        }
        let mut chain = pair_bridge_reply(); chain[1]["result"] = json!("0x2"); faults.push((chain, false));
        faults.push((json!({}), false));
        for (body, throttle) in faults {
            let (rpc, peer) = rpc_fixture_steps(vec![(200, source_batch_reply()),(200, body)]);
            let (mut daemon, remote) = pair_daemon(&rpc, "0x606460005260206000f3");
            let mut bytes = Vec::new();
            daemon.handle_line_streaming(&pair_wire(&rpc.url, &trial_state_code()).to_string(), false, &mut bytes).unwrap();
            let responses = pair_responses(&bytes);
            assert_eq!(responses.len(), 2);
            for (index, response) in responses.iter().enumerate() {
                assert_eq!(response["requestId"], (index + 1).to_string());
                assert_eq!(response["ok"], false); assert!(response.get("strict").is_none());
                assert!(response.get("sourceAttestation").is_none());
                assert_eq!(response["fatal"]["kind"], if throttle { "rpc-throttle" } else { "source-fault" });
            }
            assert!(daemon.pinned.is_none());
            assert!(remote.inner.borrow().storage.values().all(|v| v.is_zero()));
            // Later reset/health cannot clear physical fatal evidence or send.
            assert!(request_line(&mut daemon, 3, json!({"op":"reset"})).get("fatal").is_some());
            assert_eq!(peer.join().unwrap().len(), 2);
        }
    }

    #[test]
    fn strict_pair_keeps_a_settled_on_b_postcheck_fault_and_precheck_fault_never_executes() {
        for precheck in [false,true] {
            for throttle in [false,true] {
                let mut post = pair_post_reply(); post["result"]["baseFeePerGas"] = json!("0x2");
                let fault = if throttle { json!({"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"quota exceeded"}}) }
                    else if precheck { json!([]) } else { post };
                let replies = if precheck { vec![(200,fault)] }
                    else { vec![(200,source_batch_reply()),(200,pair_bridge_reply()),(200,fault)] };
                let (rpc, peer) = rpc_fixture_steps(replies);
                let (mut daemon, _) = pair_daemon(&rpc, "0x606460005260206000f3");
                let mut bytes = Vec::new();
                daemon.handle_line_streaming(&pair_wire(&rpc.url, &trial_state_code()).to_string(), true, &mut bytes).unwrap();
                let responses = pair_responses(&bytes);
                assert_eq!(responses.len(),2); assert_eq!(responses[0]["ok"], !precheck);
                assert_eq!(responses[1]["ok"],false); assert!(responses[1].get("strict").is_none());
                assert!(responses[1].get("sourceAttestation").is_none());
                assert_eq!(responses[1]["fatal"]["kind"], if throttle { "rpc-throttle" } else { "source-fault" });
                let record = diagnostic::take_pair_record().unwrap();
                assert_eq!(record["rpcAttempts"], if precheck { 1 } else { 3 });
                assert_eq!(record["fatal"],true);
                if precheck { assert_eq!(record["first"]["phases"]["prefix-execution"]["entries"],0); }
                assert_eq!(peer.join().unwrap().len(), if precheck { 1 } else { 3 });
            }
        }
    }

    #[test]
    fn strict_pair_first_and_reused_sessions_attribute_hydration_separately() {
        let hydration: Vec<_> = (0..15 + mapping_slot_candidates(None, None).len()).map(|id| {
            let result = if id >= 15 { format!("0x{:064x}",0) }
                else if id == 14 { "0x606460005260206000f3".into() }
                else if id % 3 == 2 { "0x".into() } else { "0x0".into() };
            json!({"jsonrpc":"2.0","id":id,"result":result})
        }).collect();
        let (rpc, peer) = rpc_fixture_steps(vec![(200,source_batch_reply()), (200,json!(hydration)),
            (200,pair_bridge_reply()), (200,pair_post_reply()),
            (200,source_batch_reply()), (200,pair_bridge_reply()), (200,pair_post_reply())]);
        let mut daemon = daemon_fixture(&rpc);
        for (a,b) in [(1,2),(3,4)] {
            let mut wire = pair_wire(&rpc.url, "0x00");
            wire["requests"][0]["requestId"] = json!(a.to_string());
            wire["requests"][1]["requestId"] = json!(b.to_string());
            let mut bytes = Vec::new(); daemon.handle_line_streaming(&wire.to_string(), true, &mut bytes).unwrap();
            assert!(pair_responses(&bytes).iter().all(|response| response["ok"] == true));
            let record = diagnostic::take_pair_record().unwrap();
            assert_eq!(record["rpcAttempts"], if a == 1 { 4 } else { 3 });
            assert_eq!(record["first"]["phases"]["hydration"]["rpcAttempts"], if a == 1 { 1 } else { 0 });
            assert_eq!(record["second"]["phases"]["hydration"]["rpcAttempts"],0);
            assert_eq!(record["bridge"]["rpcAttempts"],1);
        }
        let calls = peer.join().unwrap(); assert_eq!(calls.len(),7);
        assert_eq!(calls[1].as_array().unwrap().len(), hydration.len());
    }

    #[test]
    fn strict_pair_physical_throttle_during_a_or_bridge_bars_every_later_execution() {
        for in_prefix in [false,true] {
            let quota = json!({"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"quota exceeded"}});
            let rate: Vec<_> = (0..4).map(|id| json!({"jsonrpc":"2.0","id":id,
                "error":{"code":429,"message":"rate limit"}})).collect();
            let steps = vec![RpcFixtureReply::Http(200,source_batch_reply().to_string()),
                if in_prefix { RpcFixtureReply::Http(200,quota.to_string()) }
                else { RpcFixtureReply::RetryAfter(json!(rate).to_string(),"60") }];
            let (rpc, peer) = rpc_transport_fixture(steps);
            let (mut daemon, _) = pair_daemon(&rpc, "0x606460005260206000f3");
            let mut bytes = Vec::new();
            let code = if in_prefix { "0x602a5460005260206000f3" } else { "0x00" };
            daemon.handle_line_streaming(&pair_wire(&rpc.url,code).to_string(), true, &mut bytes).unwrap();
            for response in pair_responses(&bytes) {
                assert_eq!(response["ok"],false); assert_eq!(response["fatal"]["kind"],"rpc-throttle");
                assert!(response.get("strict").is_none());
            }
            let record = diagnostic::take_pair_record().unwrap();
            assert_eq!(record["rpcAttempts"],2); assert!(record["second"].is_null());
            assert_eq!(record["bridge"]["rpcAttempts"], if in_prefix { 0 } else { 1 });
            assert_eq!(record["bridgeChecks"]["logicalCount"], if in_prefix { 0 } else { 4 });
            assert_eq!(peer.join().unwrap().len(),2);
        }
    }

    fn assert_source_batch_fault(body: Value, pin: &SourcePin, expected: FatalReason) {
        let (mut rpc, thread) = rpc_fixture(200, body);
        rpc.pinned = true;
        let error = verify_source(&rpc, 300, pin).unwrap_err();
        assert_eq!(error.downcast_ref::<FatalReason>(), Some(&expected));
        assert_eq!(rpc.fatal.get(), Some(expected));
        // A later precheck and reset cannot recover or dispatch after the fault.
        assert!(verify_source(&rpc, 300, pin).is_err());
        let mut daemon = daemon_fixture(&rpc);
        for (id, op) in ["health", "reset"].iter().enumerate() {
            let response = request_line(&mut daemon, id as u64 + 1, json!({"op":op}));
            assert_eq!(response["ok"], false);
            assert_eq!(response["fatal"], serde_json::to_value(expected).unwrap());
            assert!(response.get("sourceAttestation").is_none());
        }
        assert_eq!(rpc.round_trips(), 1);
        assert_eq!(thread.join().unwrap().len(), 1);
    }

    #[test]
    fn verify_source_batch_rejects_chain_and_full_header_faults() {
        let header = pinned_header();
        let pin = SourcePin { chain_id: 1, block_hash: header["hash"].as_str().unwrap().into(), state_root: None };
        for chain in [json!("0x2"), json!("0x01"), json!("0x10000000000000000"), Value::Null] {
            let mut body = source_batch_reply(); body[0]["result"] = chain;
            assert_source_batch_fault(body, &pin, FatalReason::SourceFault);
        }
        for id in [1, 2] {
            for key in header.as_object().unwrap().keys() {
                let mut body = source_batch_reply();
                body[id]["result"].as_object_mut().unwrap().remove(key);
                assert_source_batch_fault(body, &pin, FatalReason::SourceFault);
            }
            for (key, value) in [
                ("number", json!("0x12d")), ("hash", json!(format!("0x{}", "ff".repeat(32)))),
                ("stateRoot", json!(format!("0x{}", "ff".repeat(32)))),
                ("parentHash", json!(format!("0x{}", "ff".repeat(32)))),
                ("timestamp", json!("0x6b49d201")), ("gasLimit", json!("0x1c9c381")),
                ("baseFeePerGas", json!("0x2")), ("miner", json!(format!("0x{}", "ff".repeat(20)))),
                ("mixHash", json!(format!("0x{}", "ff".repeat(32)))), ("excessBlobGas", json!("0x1")),
                ("gasUsed", json!("0xffffffffffffffff")), ("blobGasUsed", json!("0x1")),
                ("difficulty", json!("0x1")), ("transactionsRoot", json!("0x00")),
            ] {
                let mut body = source_batch_reply(); body[id]["result"][key] = value;
                assert_source_batch_fault(body, &pin, FatalReason::SourceFault);
            }
        }
        // Matching returned roots still must agree with an explicitly supplied pin.
        let pin = SourcePin { state_root: Some(format!("0x{}", "ff".repeat(32))), ..pin };
        assert_source_batch_fault(source_batch_reply(), &pin, FatalReason::SourceFault);
    }

    #[test]
    fn verify_source_batch_missing_or_failed_items_latch_without_retry() {
        let pin = SourcePin { chain_id: 1, block_hash: pinned_header()["hash"].as_str().unwrap().into(), state_root: None };
        for id in 0..3 {
            for fault in ["missing", "error", "no-result", "quota", "duplicate", "unknown-id", "version"] {
                let mut body = source_batch_reply();
                let mut expected = FatalReason::SourceFault;
                match fault {
                    "missing" => { body.as_array_mut().unwrap().remove(id); }
                    "error" | "quota" => {
                        body[id] = json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,
                            "message":if fault == "quota" { "quota exceeded" } else { "ordinary failure" }}});
                        if fault == "quota" {
                            expected = FatalReason::RpcThrottle { category: ThrottleCategory::RpcQuota,
                                http_status: None, rpc_code: Some(-32000) };
                        }
                    }
                    "no-result" => { body[id].as_object_mut().unwrap().remove("result"); }
                    "duplicate" => { let item = body[id].clone(); body.as_array_mut().unwrap().push(item); }
                    "unknown-id" => { body[id]["id"] = json!(99); }
                    "version" => { body[id]["jsonrpc"] = json!("1.0"); }
                    _ => unreachable!(),
                }
                body.as_array_mut().unwrap().reverse();
                assert_source_batch_fault(body, &pin, expected);
            }
        }
    }

    #[test]
    fn verify_source_batch_keeps_strict_canonical_postcheck_on_every_outcome() {
        for (outcome, code) in [("Success", "0x00"), ("Revert", "0x60006000fd"),
            ("Halt", "0xfe"), ("observation-failure", "0x00")] {
            for changed in [false, true] {
                let mut canonical = pinned_header();
                if changed { canonical["baseFeePerGas"] = json!("0x2"); }
                let (rpc, thread) = rpc_fixture_steps(vec![
                    (200, source_batch_reply()),
                    (200, json!([{"jsonrpc":"2.0","id":0,"result":{}}])),
                    (200, json!({"jsonrpc":"2.0","id":1,"result":canonical})),
                ]);
                let mut daemon = daemon_fixture(&rpc);
                let source = test_source();
                let mut remote = RemoteRevmDb::new(rpc.url.clone(), 300, HashSet::new(),
                    Rc::new(RefCell::new(PersistentCache::default())), rpc.client.clone(), Rc::clone(&rpc.fatal)).unwrap();
                remote.rpc.pinned = true;
                remote.block_tag = json!({"blockHash":source.attestation.block_hash,"requireCanonical":true});
                remote.source = Some(source.clone());
                let caller = Address::repeat_byte(0xaa);
                let target = Address::repeat_byte(0xbb);
                for address in [Address::ZERO, caller, source.env.beneficiary] {
                    remote.seed_account(address, U256::MAX, 0, None);
                }
                remote.seed_account(target, U256::ZERO, 1,
                    Some(Bytecode::new_raw(Bytes::from(parse_hex_bytes(code).unwrap()))));
                let remote = Rc::new(remote);
                daemon.pinned = Some(PinnedSession { remote: Rc::clone(&remote),
                    balance_slots: HashMap::new(), allowance_slots: HashMap::new() });
                let mut req = json!({"op":"strictSimulate","blockNumber":300,"rpcUrl":rpc.url,
                    "sourcePin":{"chainId":1,"blockHash":source.attestation.block_hash},
                    "from":caller,"to":target,"data":"0x","gasLimit":100000});
                if outcome == "observation-failure" { req["observeTotalSupply"] = json!([target]); }
                let response = request_line(&mut daemon, 1, req);
                if changed {
                    assert_eq!(response["ok"], false);
                    assert_eq!(response["fatal"]["kind"], "source-fault");
                    assert!(response.get("sourceAttestation").is_none());
                    assert!(response.get("strict").is_none());
                } else if outcome == "observation-failure" {
                    assert_eq!(response["ok"], false);
                    assert_eq!(response["errorKind"], "observation");
                    assert_eq!(rpc.fatal.get(), None);
                } else {
                    assert_eq!(response["ok"], true, "{response}");
                    assert_eq!(response["strict"]["outcome"]["kind"], outcome);
                    assert_eq!(response["sourceAttestation"], serde_json::to_value(&source.attestation).unwrap());
                    assert_eq!(rpc.fatal.get(), None);
                }
                assert_eq!(remote.rpc.round_trips(), 2, "trace and postcheck for {outcome}");
                let requests = thread.join().unwrap();
                assert_eq!(requests.len(), 3, "precheck, trace, postcheck for {outcome}");
                assert_eq!(requests[0].as_array().unwrap().len(), 3);
                assert_eq!(requests[1][0]["method"], "debug_traceCall");
                assert_eq!(requests[2], json!({"jsonrpc":"2.0","id":1,
                    "method":"eth_getBlockByNumber","params":["0x12c",false]}));
            }
        }
    }

    #[test]
    fn malformed_pins_never_dispatch_or_use_environment_endpoint() {
        for pin in [Value::Null, json!({}), json!({"chainId":1}),
            json!({"blockHash":format!("0x{}", "11".repeat(32))}),
            json!({"chainId":1,"blockHash":"0x12"}),
            json!({"chainId":2,"blockHash":format!("0x{}", "11".repeat(32))}),
            json!({"chainId":1,"blockHash":format!("0x{}", "11".repeat(32)),"stateRoot":null}),
            json!({"chainId":1,"blockHash":format!("0x{}", "11".repeat(32)),"unknown":1})] {
            let mut daemon = Daemon::default();
            let req = json!({"op":"strictSimulate", "blockNumber":300, "rpcUrl":"http://127.0.0.1:1",
                "from":format!("0x{}", "aa".repeat(20)), "to":format!("0x{}", "bb".repeat(20)),
                "data":"0x", "sourcePin":pin});
            let r = request_line(&mut daemon, 1, req);
            assert_eq!(r["ok"], false); assert!(r.get("sourceAttestation").is_none()); assert!(daemon.http.is_none());
        }
        let mut daemon = Daemon::default();
        let pin = json!({"chainId":1, "blockHash":format!("0x{}", "11".repeat(32))});
        for (id, op) in ["health", "warm", "prepare", "quote", "simulate", "reset", "strictSimulate"].iter().enumerate() {
            let r = request_line(&mut daemon, id as u64 + 1, json!({"op":op,"blockNumber":300,
                "from":format!("0x{}", "aa".repeat(20)), "to":format!("0x{}", "bb".repeat(20)),"data":"0x", "sourcePin":pin}));
            assert_eq!(r["ok"], false); assert!(daemon.http.is_none());
        }
    }

    #[test]
    fn trace_source_fault_scanned_before_whole_batch_or_unknown_id_selection() {
        for message in ["hash is not currently canonical", "header not found", "state unavailable"] {
            for shape in ["single", "whole", "unknown"] {
                let error = json!({"jsonrpc":"2.0", "id":999, "error":{"code":-32000,"message":message}});
                let (mut rpc, thread) = rpc_fixture(200, if shape == "unknown" { json!([error]) } else { error });
                rpc.pinned = true;
                if shape == "single" { let _ = rpc.call("debug_traceCall", json!([])); }
                else { let _ = rpc.batch_call(&[("debug_traceCall", json!([]))]); }
                assert_eq!(rpc.fatal.get(), Some(FatalReason::SourceFault));
                // Model a swallowed optional error, followed by an otherwise
                // successful operation: the envelope still rejects it.
                let mut daemon = daemon_fixture(&rpc);
                for (id, op) in ["health", "reset"].iter().enumerate() {
                    let r = request_line(&mut daemon, id as u64 + 1, json!({"op":op}));
                    assert_eq!(r["ok"], false); assert_eq!(r["fatal"]["kind"], "source-fault");
                    assert!(r.get("sourceAttestation").is_none());
                }
                assert!(rpc.call("eth_chainId", json!([])).is_err()); assert_eq!(rpc.round_trips(), 1);
                thread.join().unwrap();
            }
        }
    }

    #[test]
    fn source_diagnostic_metadata_and_hash_suffix_cannot_escape_optional_trace_latch() {
        let hash = format!("0x{}", "12".repeat(32));
        for error in [
            json!({"code":-32000,"message":"hash is not currently canonical","data":{}}),
            json!({"code":-32000,"message":"hash is not currently canonical","data":{"blockHash":hash}}),
            json!({"code":-32001,"message":format!("header not found: {hash}")}),
            json!({"code":-32001,"message":format!("header not found: {hash}"),"data":{"reason":"missing header"}}),
        ] {
            for shape in ["single", "item", "whole", "unknown-id"] {
                let id = if shape == "single" { 1 } else if shape == "unknown-id" { 999 } else { 0 };
                let item = json!({"jsonrpc":"2.0", "id":id, "error":error});
                let (mut rpc, thread) = rpc_fixture(200,
                    if shape == "single" || shape == "whole" { item } else { json!([item]) });
                rpc.pinned = true;
                if shape == "single" { let _ = rpc.call("debug_traceCall", json!([])); }
                else { let _ = rpc.batch_call(&[("debug_traceCall", json!([]))]); }
                assert_eq!(rpc.fatal.get(), Some(FatalReason::SourceFault), "{shape}: {error}");
                let mut daemon = daemon_fixture(&rpc);
                let result = request_line(&mut daemon, 1, json!({"op":"health"}));
                assert_eq!(result["ok"], false);
                assert!(result.get("sourceAttestation").is_none());
                assert!(rpc.call("eth_chainId", json!([])).is_err());
                assert!(rpc.batch_call(&[("debug_traceCall", json!([]))]).is_err());
                assert_eq!(rpc.round_trips(), 1);
                thread.join().unwrap();
            }
        }
    }

    #[test]
    fn optional_trace_domain_errors_do_not_become_source_faults() {
        let qualified = format!("header not found: 0x{}", "12".repeat(32));
        for error in [
            json!({"code":3,"message":"hash is not currently canonical"}),
            json!({"code":"CALL_EXCEPTION","message":"hash is not currently canonical"}),
            json!({"code":-32000,"message":"hash is not currently canonical","data":"0xdeadbeef"}),
            json!({"code":-32000,"message":"execution reverted: hash is not currently canonical"}),
            json!({"code":-32601,"message":"method not supported"}),
            json!({"code":-32602,"message":"invalid hash selector argument"}),
            json!({"code":3,"message":"hash is not currently canonical","data":{}}),
            json!({"code":"CALL_EXCEPTION","message":qualified,"data":{}}),
            json!({"code":-32000,"message":"hash is not currently canonical","data":"0x"}),
            json!({"code":-32001,"message":qualified,"data":"0x"}),
            json!({"code":-32001,"message":qualified,"data":"0xdeadbeef"}),
            json!({"code":-32000,"message":"execution reverted: hash is not currently canonical","data":{}}),
            json!({"code":-32001,"message":format!("revert: {qualified}"),"data":{}}),
            json!({"code":-32001,"message":format!("contract says {qualified}"),"data":{}}),
            json!({"code":-32001,"message":format!("{qualified} extra text"),"data":{}}),
            json!({"code":-32001,"message":"header not found: 0x1234","data":{}}),
            json!({"code":-32001,"message":format!("header not found: 0x{}", "zz".repeat(32)),"data":{}}),
        ] {
            for batch in [false, true] {
                let item = json!({"jsonrpc":"2.0", "id":if batch {0} else {1}, "error":error});
                let (mut rpc, thread) = rpc_fixture(200, if batch { json!([item]) } else { item });
                rpc.pinned = true;
                if batch { let _ = rpc.batch_call(&[("debug_traceCall", json!([]))]); }
                else { let _ = rpc.call("debug_traceCall", json!([])); }
                assert_eq!(rpc.fatal.get(), None); thread.join().unwrap();
            }
        }
    }

    #[test]
    fn invalid_blockhash_ranges_and_reset_need_no_io() {
        let mut remote = RemoteRevmDb::new("http://127.0.0.1:1".into(), 300, HashSet::new(),
            Rc::new(RefCell::new(PersistentCache::default())), Client::builder().no_proxy().build().unwrap(), FatalLatch::default()).unwrap();
        remote.source = Some(test_source()); remote.rpc.pinned = true;
        for number in [0, 43, 300, 301, u64::MAX] { assert_eq!(remote.block_hash_ref(number).unwrap(), B256::ZERO); }
        assert_eq!(remote.rpc.round_trips(), 0);
        let remote = Rc::new(remote);
        let mut daemon = Daemon { pinned: Some(PinnedSession { remote,
            balance_slots: HashMap::from([(Address::ZERO, 7)]), allowance_slots: HashMap::from([(Address::ZERO, 8)]) }), ..Daemon::default() };
        assert_eq!(request_line(&mut daemon, 1, json!({"op":"reset"}))["ok"], true);
        assert!(daemon.pinned.is_none());
    }

    // One deterministic loopback exchange; no external endpoints or env input.
    fn rpc_fixture(status: u16, body: Value) -> (RpcClient, std::thread::JoinHandle<Vec<Value>>) {
        rpc_fixture_steps(vec![(status, body)])
    }

    fn rpc_fixture_steps(steps: Vec<(u16, Value)>) -> (RpcClient, std::thread::JoinHandle<Vec<Value>>) {
        rpc_transport_fixture(steps.into_iter()
            .map(|(status, body)| RpcFixtureReply::Http(status, body.to_string())).collect())
    }

    enum RpcFixtureReply {
        Held(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>),
        Http(u16, String),
        ContentType(u16, String, Option<&'static str>),
        RetryAfter(String, &'static str),
        Disconnect,
        Timeout,
        TruncatedBody(u16),
        MalformedHeaders,
    }

    fn rpc_transport_fixture(steps: Vec<RpcFixtureReply>) -> (RpcClient, std::thread::JoinHandle<Vec<Value>>) {
        use std::io::Read;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let mut requests = Vec::new();
            for reply in steps {
                let until = Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(err)
                            if err.kind() == io::ErrorKind::WouldBlock
                                && Instant::now() < until =>
                        {
                            std::thread::sleep(Duration::from_millis(1));
                        }
                        Err(err) => panic!("fixture accept failed: {err}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut byte = [0u8; 1];
                while !bytes.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                }
                let header = String::from_utf8(bytes).unwrap();
                let length: usize = header
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                let mut request = vec![0; length];
                stream.read_exact(&mut request).unwrap();
                requests.push(serde_json::from_slice(&request).unwrap());
                match reply {
                    RpcFixtureReply::Held(arrived, release) => {
                        arrived.send(()).unwrap();
                        release.recv_timeout(Duration::from_secs(5)).unwrap();
                        let body = json!({"jsonrpc":"2.0","id":1,"result":"0x1"}).to_string();
                        write!(stream, "HTTP/1.1 200 Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                    }
                    RpcFixtureReply::Http(status, body) => {
                        write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                    }
                    RpcFixtureReply::ContentType(status, body, content_type) => {
                        let header = content_type.map(|v| format!("Content-Type: {v}\r\n")).unwrap_or_default();
                        write!(stream, "HTTP/1.1 {status} Fixture\r\n{header}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                    }
                    RpcFixtureReply::RetryAfter(body, wait) => {
                        write!(stream, "HTTP/1.1 429 Fixture\r\nRetry-After: {wait}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                    }
                    RpcFixtureReply::Disconnect => {}
                    RpcFixtureReply::Timeout => std::thread::sleep(Duration::from_millis(500)),
                    RpcFixtureReply::TruncatedBody(status) => {
                        write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{{").unwrap();
                    }
                    RpcFixtureReply::MalformedHeaders => {
                        write!(stream, "HTTP/1.1 invalid-status\r\nConnection: close\r\n\r\n").unwrap();
                    }
                }
            }
            requests
        });
        let http = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        (
            RpcClient::new(url, http, FatalLatch::default()).unwrap(),
            thread,
        )
    }

    #[test]
    fn temporary_rate_limit_recovers_without_poisoning_admission() {
        let params = json!([format!("{:#x}", Address::ZERO),
            {"blockHash":format!("0x{}", "11".repeat(32)),"requireCanonical":true}]);
        for status in [429, 200] {
            let limited = json!({"jsonrpc":"2.0","id":1,
                "error":{"code":429,"message":"too many requests"}});
            let (mut rpc, thread) = rpc_fixture_steps(vec![(status, limited),
                (200, json!({"jsonrpc":"2.0","id":1,"result":"0x01"})),
                (200, json!({"jsonrpc":"2.0","id":1,"result":"0x02"}))]);
            rpc.pinned = true;
            assert_eq!(rpc.call("eth_getCode", params.clone()).unwrap(), json!("0x01"));
            assert_eq!(rpc.fatal.get(), None, "recovered rate limit must not revoke admission");
            assert_eq!(rpc.call("eth_getCode", params.clone()).unwrap(), json!("0x02"));
            let requests = thread.join().unwrap();
            assert_eq!(requests.len(), 3);
            assert!(requests.iter().all(|request| request == &requests[0]), "keep exact request and block pin");
        }
    }

    #[test]
    fn rate_limited_batch_replays_whole_request_with_one_retry_budget() {
        let limited = json!([
            {"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"throughput limit reached"}},
            {"jsonrpc":"2.0","id":0,"result":"0x01"}]);
        let success = json!([
            {"jsonrpc":"2.0","id":1,"result":"0x02"},
            {"jsonrpc":"2.0","id":0,"result":"0x01"}]);
        let (mut rpc, thread) = rpc_transport_fixture(vec![
            RpcFixtureReply::Http(503, "gateway unavailable".into()),
            RpcFixtureReply::Http(200, limited.to_string()),
            RpcFixtureReply::Http(200, success.to_string())]);
        rpc.pinned = true;
        let pin = json!(["0x0", {"blockHash":format!("0x{}", "11".repeat(32)), "requireCanonical":true}]);
        let values = rpc.batch_call(&[("eth_getCode", pin.clone()), ("eth_getCode", pin)]).unwrap();
        assert_eq!(values.into_iter().map(Result::unwrap).collect::<Vec<_>>(), vec![json!("0x01"), json!("0x02")]);
        assert_eq!(rpc.fatal.get(), None);
        let requests = thread.join().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests.iter().all(|request| request == &requests[0]));
    }

    #[test]
    fn rate_retries_never_hide_ambiguous_limits_or_invalid_siblings() {
        let (mut rpc, thread) = rpc_transport_fixture(vec![]);
        rpc.pinned = true;
        let request = json!([
            {"jsonrpc":"2.0","id":0,"method":"eth_getCode","params":[]},
            {"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":[]}]);
        let rate = json!({"jsonrpc":"2.0","id":0,"error":{"code":429,"message":"rate limit exceeded"}});
        for sibling in [
            json!({"jsonrpc":"2.0","id":1,"error":{"code":429,"message":"rate limit; monthly quota exhausted"}}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"header not found"}}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted: rate limit"}}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"limit exceeded"}}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":""}}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":429,"message":"rate limit", "data":"0xdeadbeef"}}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":429}}),
            json!({"jsonrpc":"2.0","id":1,"result":"0x1"}),
            json!({"jsonrpc":"2.0","id":900,"result":"0x01"}),
            json!({"jsonrpc":"2.0","id":0,"result":"0x01"}),
            json!({"id":1,"result":"0x01"}),
            json!({"jsonrpc":"2.0","id":1,"result":"0x01","error":{"code":429,"message":"rate limit"}}),
        ] {
            for reversed in [false, true] {
                let body = if reversed { json!([sibling, rate]) } else { json!([rate, sibling]) };
                assert!(!rpc.retryable_rate_response(&request, &body), "must not replay {body}");
            }
        }
        assert!(!rpc.retryable_rate_response(&request, &json!([rate])));
        assert!(!rpc.retryable_rate_response(&request, &rate));
        assert_eq!(rpc.fatal.get(), None, "eligibility inspection must not mutate latch");
        thread.join().unwrap();
    }

    #[test]
    fn rate_retry_exhaustion_still_fences_optional_traces() {
        for last_transport_failure in [false, true] {
            let rate = json!({"jsonrpc":"2.0","id":1,"error":{"code":429,"message":"too many requests"}});
            let mut replies = vec![RpcFixtureReply::Http(200, rate.to_string()), RpcFixtureReply::Http(503, "gateway".into())];
            replies.push(if last_transport_failure { RpcFixtureReply::Disconnect }
                else { RpcFixtureReply::Http(200, rate.to_string()) });
            let (mut rpc, thread) = rpc_transport_fixture(replies);
            rpc.pinned = true;
            let error = rpc.call("debug_traceCall", json!([])).unwrap_err();
            assert!(matches!(error.downcast_ref::<FatalReason>(), Some(FatalReason::RpcThrottle { .. })));
            assert!(rpc.call("eth_getCode", json!([])).is_err());
            assert!(rpc.batch_call(&[("debug_traceCall", json!([]))]).is_err());
            assert_eq!(rpc.round_trips(), 3);
            assert_eq!(thread.join().unwrap().len(), 3);
        }
    }

    #[test]
    fn rate_retry_after_is_respected_without_unbounded_waits() {
        assert_eq!(rate_retry_after(None), Some(Duration::ZERO));
        for (header, seconds) in [("0", Some(0)), ("2", Some(2)), ("10", Some(10)), ("11", None), ("-1", None), ("tomorrow", None)] {
            assert_eq!(rate_retry_after(Some(&header.parse().unwrap())), seconds.map(Duration::from_secs));
        }
        let rate = json!({"jsonrpc":"2.0","id":1,"error":{"code":429,"message":"too many requests"}});
        let (mut rpc, thread) = rpc_transport_fixture(vec![
            RpcFixtureReply::RetryAfter(rate.to_string(), "2"),
            RpcFixtureReply::Http(200, json!({"jsonrpc":"2.0","id":1,"result":"0x01"}).to_string())]);
        rpc.pinned = true;
        let started = Instant::now();
        assert_eq!(rpc.call("eth_getCode", json!([])).unwrap(), json!("0x01"));
        assert!(started.elapsed() >= Duration::from_secs(2));
        assert_eq!(thread.join().unwrap().len(), 2);
        let (rpc, thread) = rpc_transport_fixture(vec![RpcFixtureReply::RetryAfter(rate.to_string(), "60")]);
        assert!(rpc.call("eth_getCode", json!([])).is_err());
        assert_eq!(rpc.round_trips(), 1);
        thread.join().unwrap();
    }

    #[test]
    fn rate_then_invalid_optional_reply_cannot_clear_fatal() {
        let rate = json!({"jsonrpc":"2.0","id":1,"error":{"code":429,"message":"too many requests"}});
        for body in [
            "{",
            r#"{"jsonrpc":"2.0","id":900,"result":{}}"#,
            r#"{"id":1,"result":{}}"#,
            r#"{"jsonrpc":"2.0","id":1}"#,
            r#"{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":3,"message":"execution reverted"}}"#,
        ] {
            let (mut rpc, thread) = rpc_transport_fixture(vec![
                RpcFixtureReply::Http(200, rate.to_string()), RpcFixtureReply::Http(200, body.into())]);
            rpc.pinned = true;
            assert!(rpc.call("debug_traceCall", json!([])).is_err());
            assert!(matches!(rpc.fatal.get(), Some(FatalReason::RpcThrottle { .. })));
            assert!(rpc.call("eth_getCode", json!([])).is_err());
            assert!(rpc.batch_call(&[("eth_getCode", json!([]))]).is_err());
            assert_eq!(rpc.round_trips(), 2);
            assert_eq!(thread.join().unwrap().len(), 2);
        }
        // A bound domain revert is not an unrecovered transport failure.
        let (mut rpc, thread) = rpc_fixture_steps(vec![(200, rate),
            (200, json!({"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x"}}))]);
        rpc.pinned = true;
        assert!(rpc.call("debug_traceCall", json!([])).is_err());
        assert_eq!(rpc.fatal.get(), None);
        assert_eq!(thread.join().unwrap().len(), 2);
    }

    #[test]
    fn malformed_json_looking_429_never_retries_without_json_header() {
        for content_type in [None, Some("text/plain")] {
            for body in ["  {\"jsonrpc\":", "\n[", "\"unfinished"] {
                let (rpc, thread) = rpc_transport_fixture(vec![RpcFixtureReply::ContentType(429, body.into(), content_type)]);
                assert!(rpc.call("debug_traceCall", json!([])).is_err());
                assert!(matches!(rpc.fatal.get(), Some(FatalReason::RpcThrottle { .. })));
                assert_eq!(rpc.round_trips(), 1);
                assert_eq!(thread.join().unwrap().len(), 1);
            }
        }
        let (rpc, thread) = rpc_transport_fixture(vec![
            RpcFixtureReply::ContentType(429, "too many requests".into(), None),
            RpcFixtureReply::Http(200, json!({"jsonrpc":"2.0","id":1,"result":"0x01"}).to_string())]);
        assert_eq!(rpc.call("eth_getCode", json!([])).unwrap(), json!("0x01"));
        assert_eq!(rpc.fatal.get(), None);
        assert_eq!(thread.join().unwrap().len(), 2);
    }

    #[test]
    fn retry_transient_http_preserves_single_and_batch_pinned_requests() {
        let params = json!([format!("{:#x}", Address::ZERO),
            {"blockHash":format!("0x{}", "11".repeat(32)),"requireCanonical":true}]);
        for (status, body) in [(502, "<html>bad gateway</html>"),
            (503, r#"{"message":"unavailable"}"#), (504, "gateway timeout")] {
            for batch in [false, true] {
                let response = if batch {
                    json!([{"jsonrpc":"2.0","id":1,"result":"0x02"},
                        {"jsonrpc":"2.0","id":0,"result":"0x01"}])
                } else {
                    json!({"jsonrpc":"2.0","id":1,"result":"0x01"})
                };
                let (mut rpc, thread) = rpc_transport_fixture(vec![
                    RpcFixtureReply::Http(status, body.into()),
                    RpcFixtureReply::Http(200, response.to_string()),
                ]);
                rpc.pinned = true;
                let expected = if batch {
                    let results = rpc.batch_call(&[("eth_getCode", params.clone()),
                        ("eth_getCode", params.clone())]).unwrap();
                    assert_eq!(results.into_iter().map(Result::unwrap).collect::<Vec<_>>(),
                        vec![json!("0x01"), json!("0x02")]);
                    json!([{"jsonrpc":"2.0","id":0,"method":"eth_getCode","params":params},
                        {"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":params}])
                } else {
                    assert_eq!(rpc.call("eth_getCode", params.clone()).unwrap(), json!("0x01"));
                    json!({"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":params})
                };
                assert_eq!(rpc.fatal.get(), None);
                assert_eq!(rpc.round_trips(), 2);
                assert_eq!(thread.join().unwrap(), vec![expected.clone(), expected]);
            }
        }
    }

    #[test]
    fn retry_recovers_from_disconnect_timeout_and_truncated_body() {
        for reply in [RpcFixtureReply::Disconnect, RpcFixtureReply::Timeout, RpcFixtureReply::TruncatedBody(200)] {
            let (mut rpc, thread) = rpc_transport_fixture(vec![reply,
                RpcFixtureReply::Http(200, json!({"jsonrpc":"2.0","id":1,"result":"0x01"}).to_string())]);
            rpc.pinned = true;
            rpc.client = Client::builder().no_proxy().timeout(Duration::from_millis(250)).build().unwrap();
            assert_eq!(rpc.call("eth_getCode", json!([])).unwrap(), json!("0x01"));
            assert_eq!(rpc.fatal.get(), None);
            assert_eq!(rpc.round_trips(), 2);
            let requests = thread.join().unwrap();
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0], requests[1]);
        }
    }

    #[test]
    fn retry_exhaustion_preserves_pinned_fatal_stop() {
        for batch in [false, true] {
            for disconnect in [false, true] {
                let (mut rpc, thread) = rpc_transport_fixture((0..3).map(|_| {
                    if disconnect { RpcFixtureReply::Disconnect }
                    else { RpcFixtureReply::Http(503, "must-not-echo".into()) }
                }).collect());
                rpc.pinned = true;
                let error = if batch {
                    rpc.batch_call(&[("eth_getCode", json!([]))]).unwrap_err()
                } else {
                    rpc.call("eth_getCode", json!([])).unwrap_err()
                };
                assert_eq!(error.downcast_ref::<FatalReason>(), Some(&FatalReason::SourceFault));
                assert!(!format!("{error:#}").contains("must-not-echo"));
                assert!(!format!("{error:#}").contains(&rpc.url));
                let requests = thread.join().unwrap();
                assert_eq!(requests.len(), 3);
                assert!(requests.iter().all(|request| request == &requests[0]));
                assert!(rpc.call("eth_getCode", json!([])).is_err());
                assert!(rpc.batch_call(&[("eth_getCode", json!([]))]).is_err());
                assert_eq!(rpc.round_trips(), 3, "exhaustion must stop, not continue candidates");
            }
        }
    }

    #[test]
    fn retry_does_not_hide_rpc_faults_behind_transient_http_status() {
        for (code, message, throttle) in [
            (-32000, "header not found", false),
            (-32005, "quota exceeded", true),
        ] {
            for status in [200, 502, 503, 504] {
                for batch in [false, true] {
                    let error = quota_error(json!(code), message);
                    // Include an unknown ID so fatal scanning cannot be bypassed.
                    let body = if batch { json!([{"id":900,"result":"0x"}, error]) } else { error };
                    let (mut rpc, thread) = rpc_fixture(status, body);
                    rpc.pinned = true;
                    if batch { assert!(rpc.batch_call(&[("debug_traceCall", json!([]))]).is_err()); }
                    else { assert!(rpc.call("debug_traceCall", json!([])).is_err()); }
                    assert_eq!(matches!(rpc.fatal.get(), Some(FatalReason::RpcThrottle { .. })), throttle);
                    assert!(rpc.fatal.get().is_some());
                    assert!(rpc.call("eth_getCode", json!([])).is_err());
                    assert_eq!(rpc.round_trips(), 1);
                    assert_eq!(thread.join().unwrap().len(), 1);
                }
            }
        }
    }

    #[test]
    fn retry_does_not_retry_domain_errors_or_invalid_success_responses() {
        for status in [200, 503] {
            let (mut rpc, thread) = rpc_fixture(status,
                json!({"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x"}}));
            rpc.pinned = true;
            assert!(rpc.call("debug_traceCall", json!([])).is_err());
            assert_eq!(rpc.fatal.get(), None);
            assert_eq!(rpc.round_trips(), 1);
            thread.join().unwrap();
        }
        for (status, body) in [
            (200, "not json must-not-echo"),
            (200, r#"{"jsonrpc":"2.0","id":900,"result":"0x01"}"#),
            (200, r#"{"jsonrpc":"2.0","id":1,"result":"0x1"}"#),
            (200, r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"invalid params"}}"#),
            (401, "unauthorized must-not-echo"),
            (403, "forbidden must-not-echo"),
            (500, "error must-not-echo"),
        ] {
            let (mut rpc, thread) = rpc_transport_fixture(vec![RpcFixtureReply::Http(status, body.into())]);
            rpc.pinned = true;
            assert!(rpc.call("eth_getCode", json!([])).is_err());
            assert_eq!(rpc.fatal.get(), Some(FatalReason::SourceFault));
            assert_eq!(rpc.round_trips(), 1);
            thread.join().unwrap();
        }
    }

    #[test]
    fn retry_exhaustion_does_not_echo_remote_body_or_endpoint() {
        let (mut rpc, thread) = rpc_transport_fixture((0..3)
            .map(|_| RpcFixtureReply::Http(502, "<html>must-not-echo</html>".into())).collect());
        rpc.url.push_str("/?key=must-not-echo-key");
        let error = rpc.call("eth_getCode", json!([])).unwrap_err();
        assert_eq!(format!("{error:#}"), "rpc json decode failed");
        assert_eq!(rpc.round_trips(), 3);
        assert_eq!(thread.join().unwrap().len(), 3);
    }

    #[test]
    fn retry_does_not_retry_terminal_status_with_interrupted_body_or_bad_url() {
        for status in [400, 401, 403, 429, 500] {
            let (mut rpc, thread) = rpc_transport_fixture(vec![RpcFixtureReply::TruncatedBody(status)]);
            rpc.pinned = true;
            assert!(rpc.call("eth_getCode", json!([])).is_err());
            assert!(rpc.fatal.get().is_some());
            assert_eq!(rpc.round_trips(), 1);
            thread.join().unwrap();
        }
        let rpc = RpcClient::new("not-a-url-must-not-echo".into(),
            Client::builder().no_proxy().build().unwrap(), FatalLatch::default()).unwrap();
        assert_eq!(rpc.call("eth_getCode", json!([])).unwrap_err().to_string(), "rpc send failed");
        assert_eq!(rpc.round_trips(), 1);
    }

    #[test]
    fn retry_does_not_hide_bad_bindings_or_permanent_protocol_errors() {
        for batch in [false, true] {
            for response in [
                json!({"jsonrpc":"2.0","id":900,"result":"0x01"}),
                json!({"jsonrpc":"wrong","id":1,"result":"0x01"}),
                json!({"jsonrpc":"2.0","id":1}),
                json!([]),
            ] {
                let body = if batch { json!([response]) } else { response };
                let (mut rpc, thread) = rpc_fixture(503, body);
                rpc.pinned = true;
                if batch { assert!(rpc.batch_call(&[("eth_getCode", json!([]))]).is_err()); }
                else { assert!(rpc.call("eth_getCode", json!([])).is_err()); }
                assert_eq!(rpc.fatal.get(), Some(FatalReason::SourceFault));
                assert_eq!(rpc.round_trips(), 1);
                thread.join().unwrap();
            }
        }
        let (mut rpc, thread) = rpc_transport_fixture(vec![RpcFixtureReply::MalformedHeaders]);
        rpc.pinned = true;
        assert!(rpc.call("eth_getCode", json!([])).is_err());
        assert_eq!(rpc.fatal.get(), Some(FatalReason::SourceFault));
        assert_eq!(rpc.round_trips(), 1);
        thread.join().unwrap();
    }

    #[test]
    fn physical_429_latches_after_bounded_retries_before_later_calls() {
        for batch in [false, true] {
            let (rpc, thread) = rpc_fixture_steps((0..3).map(|_| (429, json!({"error": "untrusted provider body"}))).collect());
            if batch {
                assert!(rpc.batch_call(&[("eth_call", json!([]))]).is_err());
            } else {
                assert!(rpc.call("eth_call", json!([])).is_err());
            }
            thread.join().unwrap();
            assert!(rpc.call("eth_call", json!([])).is_err());
            assert!(rpc.batch_call(&[("eth_call", json!([]))]).is_err());
            assert_eq!(rpc.round_trips(), 3, "exhausted calls latch; later calls perform zero I/O");
        }
    }

    fn request_line(daemon: &mut Daemon, id: u64, mut req: Value) -> Value {
        req["epoch"] = json!("fixture-epoch");
        req["requestId"] = json!(id.to_string());
        serde_json::to_value(daemon.handle_line(&req.to_string())).unwrap()
    }

    fn quota_error(code: Value, message: &str) -> Value {
        json!({"jsonrpc":"2.0", "id":0, "error":{"code":code,"message":message}})
    }

    #[test]
    fn explicit_quota_codes_and_messages_latch_single_whole_batch_and_every_item() {
        for (code, message, category) in [
            (429, "", "rpc-limit-code"),
            (-32005, "", "rpc-limit-code"),
            (-32000, "rate limit exceeded", "rpc-rate-limit"),
            (-32603, "too many requests", "rpc-rate-limit"),
            (-32010, "compute units capacity exceeded", "rpc-quota"),
            (-32000, "compute-unit limit exceeded", "rpc-quota"),
            (-32000, "quota exceeded", "rpc-quota"),
            (-32002, "throughput limit reached", "rpc-quota"),
            (-32000, "account quota exhausted", "rpc-quota"),
            (-32000, "compute units depleted", "rpc-quota"),
            (-32000, "account quota exhaustion", "rpc-quota"),
            (-32000, "compute-unit depletion", "rpc-quota"),
        ] {
            for shape in [
                "single",
                "whole-batch",
                "per-item",
                "unknown-id",
                "duplicate-id",
            ] {
                let mut error = quota_error(json!(code), message);
                if shape == "unknown-id" {
                    error["id"] = json!(900);
                }
                if shape == "per-item" {
                    error["id"] = json!(1);
                }
                let body = if shape == "single" || shape == "whole-batch" {
                    error
                } else {
                    json!([{"id":0,"result":"0x"}, error])
                };
                let (rpc, thread) = rpc_fixture(200, body);
                let failure = if shape == "single" {
                    rpc.call("eth_call", json!([])).unwrap_err()
                } else {
                    rpc.batch_call(&[("eth_call", json!([])), ("eth_call", json!([]))])
                        .unwrap_err()
                };
                assert!(failure.downcast_ref::<FatalReason>().is_some());
                assert_eq!(
                    serde_json::to_value(rpc.fatal.get()).unwrap()["category"],
                    category
                );
                assert!(rpc.call("eth_call", json!([])).is_err());
                assert!(rpc.batch_call(&[]).is_err());
                assert_eq!(rpc.round_trips(), 1);
                thread.join().unwrap();
            }
        }
    }

    #[test]
    fn revert_data_and_bare_429_are_not_physical_quota_evidence() {
        let mut hex_revert = quota_error(json!(-32000), "rate limit exceeded 429");
        hex_revert["error"]["data"] = json!("0xdeadbeef");
        let mut exhausted_revert = quota_error(json!(-32000), "account quota exhausted");
        exhausted_revert["error"]["data"] = json!("0xdeadbeef");
        for error in [
            quota_error(json!(3), "quota exceeded 429"),
            quota_error(json!("CALL_EXCEPTION"), "too many requests"),
            hex_revert,
            exhausted_revert,
            quota_error(json!(3), "account quota exhausted"),
            quota_error(json!("CALL_EXCEPTION"), "compute units depleted"),
            quota_error(json!(-32000), "execution reverted: compute units depleted"),
            quota_error(json!(-32000), "account balance depleted"),
            quota_error(json!(-32000), "429"),
            quota_error(json!(-32603), "internal error 429"),
            quota_error(json!(-32000), "execution reverted: rate limit exceeded"),
            json!({"id":0,"error":"429"}),
            json!({"id":0,"result":"429 rate limit exceeded"}),
        ] {
            for batch in [false, true] {
                let body = if batch {
                    json!([error.clone()])
                } else {
                    error.clone()
                };
                let (rpc, thread) = rpc_fixture(200, body);
                if batch {
                    let _ = rpc.batch_call(&[("eth_call", json!([]))]);
                } else {
                    let _ = rpc.call("eth_call", json!([]));
                }
                assert_eq!(rpc.fatal.get(), None);
                assert!(rpc.batch_call(&[]).is_ok());
                thread.join().unwrap();
            }
        }
    }

    #[test]
    fn physical_errors_do_not_echo_remote_body_or_endpoint() {
        for (status, body) in [
            (429, json!("must-not-echo")),
            (
                500,
                quota_error(json!(-32000), "quota exceeded must-not-echo"),
            ),
            (
                200,
                quota_error(json!(-32000), "ordinary failure must-not-echo"),
            ),
        ] {
            let (rpc, thread) = rpc_fixture(status, body);
            let err = rpc.call("eth_call", json!([])).unwrap_err();
            let printed = format!("{err:#}");
            assert!(!printed.contains("must-not-echo"));
            assert!(!printed.contains(&rpc.url));
            thread.join().unwrap();
        }
    }

    fn daemon_fixture(rpc: &RpcClient) -> Daemon {
        Daemon {
            http: Some(rpc.client.clone()),
            fatal: Rc::clone(&rpc.fatal),
            ..Daemon::default()
        }
    }

    #[test]
    fn swallowed_warm_batch_or_trace_error_overrides_success_and_gates_all_later_ops() {
        for trace in [false, true] {
            for body in [
                quota_error(json!(-32000), "compute units limit exceeded"),
                json!([quota_error(json!(-32000), "quota exceeded")]),
                quota_error(json!(-32000), "account quota exhausted"),
                json!([quota_error(json!(-32000), "compute units depleted")]),
            ] {
                let (rpc, thread) = rpc_fixture(200, body);
                let mut daemon = daemon_fixture(&rpc);
                daemon.ensure_warm(1, Some(rpc.url.clone())).unwrap();
                let remote = Rc::clone(&daemon.warm.as_ref().unwrap().remote);
                let mut req = json!({"op":"warm", "blockNumber":1, "rpcUrl":rpc.url});
                if trace {
                    remote.seed_account(Address::ZERO, U256::MAX, 0, None);
                    daemon.warm.as_mut().unwrap().block_env = Some(BlockEnv::default());
                    req["prewarmCalls"] = json!([{"from":format!("{:#x}", Address::ZERO),
                        "to":format!("{:#x}", Address::ZERO), "calldata":"0x"}]);
                }
                let result = request_line(&mut daemon, 1, req);
                assert_eq!(result["ok"], false);
                assert_eq!(result["fatal"]["kind"], "rpc-throttle");
                assert!(result.get("success").is_none());
                for (i, op) in [
                    "health",
                    "reset",
                    "warm",
                    "prepare",
                    "quote",
                    "simulate",
                    "strictSimulate",
                ]
                .iter()
                .enumerate()
                {
                    let result = request_line(&mut daemon, i as u64 + 2, json!({"op":op}));
                    assert_eq!(result["ok"], false);
                    assert_eq!(result["fatal"]["kind"], "rpc-throttle");
                    assert!(result.get("success").is_none());
                }
                // Replacing the warm DB also preserves the lifetime latch.
                daemon.ensure_warm(2, Some(rpc.url.clone())).unwrap();
                let next = &daemon.warm.as_ref().unwrap().remote.rpc;
                assert!(next.call("eth_call", json!([])).is_err());
                assert_eq!(next.round_trips(), 0);
                assert_eq!(remote.rpc.round_trips(), 1);
                thread.join().unwrap();
            }
        }
    }

    #[test]
    fn envelope_covers_every_op_and_rejects_bad_framing_without_dispatch() {
        let mut daemon = Daemon::default();
        for (i, op) in [
            "health",
            "reset",
            "warm",
            "prepare",
            "quote",
            "simulate",
            "strictSimulate",
            "unknown",
        ]
        .iter()
        .enumerate()
        {
            let result = request_line(&mut daemon, i as u64 + 1, json!({"op":op}));
            assert_eq!(result["epoch"], "fixture-epoch");
            assert_eq!(result["requestId"], (i + 1).to_string());
            assert_eq!(result["ok"], *op == "health" || *op == "reset");
        }
        assert!(daemon.http.is_none());
        assert!(daemon.warm.is_none());
        for raw in [
            "not-json",
            r#"{"op":"health"}"#,
            r#"{"op":"health","epoch":"fixture-epoch","requestId":"8"}"#,
            r#"{"op":"health","epoch":"old","requestId":"9"}"#,
            r#"{"op":"health","epoch":"fixture-epoch","requestId":9}"#,
            r#"{"op":"health","epoch":"fixture-epoch","requestId":"09"}"#,
        ] {
            assert!(!daemon.handle_line(raw).response.ok);
        }
        assert_eq!(daemon.last_request_id, 8);
        assert_eq!(
            request_line(&mut daemon, 10, json!({"op":"health"}))["ok"],
            true
        );
    }

    fn cached_daemon(rpc: &RpcClient, revert: bool) -> (Daemon, String, String, String) {
        let mut daemon = daemon_fixture(rpc);
        daemon.ensure_warm(1, Some(rpc.url.clone())).unwrap();
        let caller = Address::from([0x11; 20]);
        let target = Address::from([0x22; 20]);
        let token = Address::from([0x33; 20]);
        let remote = &daemon.warm.as_ref().unwrap().remote;
        let zero_word =
            Bytecode::new_raw(Bytes::from(hex::decode("600060005260206000f3").unwrap()));
        let target_code = if revert {
            Bytecode::new_raw(Bytes::from(hex::decode("60006000fd").unwrap()))
        } else {
            zero_word.clone()
        };
        remote.seed_account(Address::ZERO, U256::MAX, 0, None);
        remote.seed_account(caller, U256::MAX, 0, None);
        remote.seed_account(target, U256::ZERO, 1, Some(target_code));
        remote.seed_account(token, U256::ZERO, 1, Some(zero_word));
        daemon.warm.as_mut().unwrap().block_env = Some(BlockEnv::default());
        (
            daemon,
            format!("{caller:#x}"),
            format!("{target:#x}"),
            format!("{token:#x}"),
        )
    }

    fn fixture_header() -> Value {
        json!({"id":1, "result":{"timestamp":"0x1", "gasLimit":"0x1c9c380",
            "mixHash":format!("0x{}", "00".repeat(32))}})
    }

    #[test]
    fn every_success_and_revert_constructor_passes_through_the_same_envelope() {
        for revert in [false, true] {
            let (rpc, thread) = rpc_fixture_steps(vec![
                (200, fixture_header()),
                (200, json!([{"id":0,"result":{}}])),
            ]);
            let (mut daemon, caller, target, token) = cached_daemon(&rpc, revert);
            let requests = [
                json!({"op":"health"}),
                json!({"op":"warm","blockNumber":1}),
                json!({"op":"prepare","blockNumber":1,"funded":[caller]}),
                json!({"op":"quote","from":caller,"to":target,"data":"0x"}),
                json!({"op":"simulate","owner":caller,"executor":target,"calldata":"0x","profitToken":token}),
                json!({"op":"strictSimulate","blockNumber":1,"from":caller,"to":target,"data":"0x"}),
                json!({"op":"reset"}),
            ];
            for (i, req) in requests.into_iter().enumerate() {
                let op = req["op"].as_str().unwrap().to_owned();
                let result = request_line(&mut daemon, i as u64 + 1, req);
                assert_eq!(result["ok"], true, "{op}: {result}");
                assert_eq!(result["epoch"], "fixture-epoch");
                assert_eq!(result["requestId"], (i + 1).to_string());
                assert!(result.get("fatal").is_none());
                if op == "quote" || op == "strictSimulate" {
                    assert_eq!(result["success"], !revert);
                }
                if op == "simulate" {
                    assert_eq!(result["profit"], "0");
                } // No fabricated profit.
            }
            assert_eq!(daemon.warm.as_ref().unwrap().remote.rpc.round_trips(), 2);
            thread.join().unwrap();
        }
    }

    #[test]
    fn strict_cached_return_and_revert_cannot_hide_a_swallowed_trace_throttle() {
        for revert in [false, true] {
            for (status, body) in [
                (429, json!("ignored")),
                (
                    200,
                    json!([quota_error(json!(-32000), "compute units quota exceeded")]),
                ),
                (200, quota_error(json!(-32000), "account quota exhausted")),
                (
                    200,
                    json!([quota_error(json!(-32000), "compute units depleted")]),
                ),
            ] {
                let attempts = if status == 429 { 3 } else { 1 };
                let mut replies = vec![(200, fixture_header())];
                replies.extend(std::iter::repeat_n((status, body), attempts));
                let (rpc, thread) = rpc_fixture_steps(replies);
                let (mut daemon, caller, target, _) = cached_daemon(&rpc, revert);
                let result = request_line(
                    &mut daemon,
                    1,
                    json!({"op":"strictSimulate",
                    "blockNumber":1,"from":caller,"to":target,"data":"0x"}),
                );
                assert_eq!(result["ok"], false);
                assert_eq!(result["fatal"]["kind"], "rpc-throttle");
                assert!(result.get("strict").is_none());
                assert!(result.get("success").is_none());
                assert_eq!(
                    daemon.warm.as_ref().unwrap().remote.rpc.round_trips(),
                    (1 + attempts) as u64
                );
                thread.join().unwrap();
            }
        }
    }

    #[test]
    fn prestate_balance_slot_discovery_keeps_all_proxy_candidates() {
        let token = parse_address("0x1111111111111111111111111111111111111111").unwrap();
        let ledger = parse_address("0x2222222222222222222222222222222222222222").unwrap();
        let balance_slot = "0x0000000000000000000000000000000000000000000000000000000000001234";
        let implementation_slot =
            "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
        let ledger_slot = "0x9991e46462d01cd99cb3addaedea4e66a4a732f038990c838e11421e4651bfcf";
        let control_balance_slot =
            "0x0000000000000000000000000000000000000000000000000000000000005678";
        let control_ledger_slot =
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let result: Value = serde_json::from_str(&format!(
            r#"{{"{}":{{"storage":{{"{}":"0x01","{}":"0x02","invalid":"0x03"}}}},"{}":{{"storage":{{"{}":"0x04"}}}}}}"#,
            format!("{token:#x}").to_uppercase(),
            implementation_slot,
            balance_slot,
            ledger,
            ledger_slot,
        ))
        .unwrap();
        let control: Value = serde_json::from_str(&format!(
            r#"{{"{}":{{"storage":{{"{}":"0x01","{}":"0x05"}}}},"{}":{{"storage":{{"{}":"0x06"}}}}}}"#,
            token,
            implementation_slot,
            control_balance_slot,
            ledger,
            control_ledger_slot,
        ))
        .unwrap();

        let slots = prestate_storage_candidates(&result, token);

        assert_eq!(
            slots,
            vec![
                (token, parse_u256(balance_slot).unwrap()),
                (token, parse_u256(implementation_slot).unwrap()),
                (ledger, parse_u256(ledger_slot).unwrap()),
            ]
        );
        assert_eq!(
            account_specific_storage_candidates(&result, &control, token),
            vec![
                (token, parse_u256(balance_slot).unwrap()),
                (ledger, parse_u256(ledger_slot).unwrap()),
            ],
        );
    }

    #[test]
    fn discovered_balance_override_scales_from_observed_balance() {
        let amount = U256::from(1_000_000);
        assert_eq!(
            next_discovered_balance_override(amount, amount, U256::from(3_906), 0,),
            Some(U256::from(257_000_000)),
        );
        assert_eq!(
            next_discovered_balance_override(amount, amount, U256::ZERO, 0),
            Some(U256::from(256_000_000)),
        );
        assert_eq!(
            next_discovered_balance_override(amount, amount, U256::ZERO, 1),
            None,
        );
    }
}
