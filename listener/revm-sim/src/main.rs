use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    env, fmt, fs,
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
    context_interface::{ContextTr, JournalTr, Transaction,
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

const BALANCE_OF_SELECTOR: [u8; 4] = [0x70, 0xa0, 0x82, 0x31];
const TOTAL_SUPPLY_SELECTOR: [u8; 4] = [0x18, 0x16, 0x0d, 0xdd];
const APPROVE_SELECTOR: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];
const DEFAULT_GAS_LIMIT: u64 = 0x1000000;

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
            self.fatal.set(Some(reason));
        }
    }

    fn checked_source<T>(&self, result: Result<T>) -> Result<T> {
        if self.pinned && result.is_err() { self.latch(FatalReason::SourceFault); }
        self.check_fatal()?;
        result
    }

    fn inspect_rpc_error(&self, response: &Value) {
        let Some(error) = response.get("error").filter(|error| error.is_object()) else {
            return;
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
            return;
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
            self.latch(FatalReason::SourceFault);
            return;
        }
        let category = if matches!(code, Some(429 | -32005)) {
            ThrottleCategory::RpcLimitCode
        } else if explicit_revert {
            return;
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
            return;
        };
        self.latch(FatalReason::RpcThrottle {
            category,
            http_status: None,
            rpc_code: code,
        });
    }

    fn send_json(&self, body: &Value) -> Result<Value> {
        self.check_fatal()?;
        self.round_trips.set(self.round_trips.get() + 1);
        let response = self
            .client
            .post(&self.url)
            .json(body)
            .send()
            .map_err(|_| anyhow!("rpc send failed"))?;
        let status = response.status();
        if status.as_u16() == 429 {
            self.latch(FatalReason::RpcThrottle {
                category: ThrottleCategory::Http429,
                http_status: Some(429),
                rpc_code: None,
            });
            self.check_fatal()?;
        }
        // Strip reqwest errors and remote messages: neither endpoint credentials
        // nor provider-supplied body text belong in the daemon's error/log surface.
        let value: Value = response
            .json()
            .map_err(|_| anyhow!("rpc json decode failed"))?;
        self.inspect_rpc_error(&value);
        if let Some(items) = value.as_array() {
            // Scan EVERY item before ID selection/domain conversion. This also
            // catches quota errors attached to unknown or duplicate batch IDs.
            for item in items {
                self.inspect_rpc_error(item);
            }
        }
        self.check_fatal()?;
        if !status.is_success() {
            bail!("rpc http status {}", status.as_u16());
        }
        Ok(value)
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
        if pin.chain_id != 1 || parse_u64(strict_quantity(&rpc.call("eth_chainId", json!([]))?, 16)?)? != pin.chain_id {
            bail!("pinned chain mismatch");
        }
        let hash = strict_hex(&json!(pin.block_hash), Some(32))?.to_owned();
        let header = rpc.call("eth_getBlockByHash", json!([hash, false]))?;
        let source = verified_header(&header, number, pin)?;
        verify_canonical(rpc, &source)?;
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
        if self.source.is_some() { self.rpc.latch(FatalReason::SourceFault); }
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
// stdout line. The daemon holds a per-block warm `RemoteRevmDb` (shared chain
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExactTokenObservation { token: String, account: String }

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

fn serve() -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut daemon = Daemon::default();

    for line in stdin.lock().lines() {
        let line = line.context("failed reading daemon stdin")?;
        if line.trim().is_empty() {
            continue;
        }
        let response = daemon.handle_line(&line);
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}

impl Daemon {
    fn handle_line(&mut self, line: &str) -> DaemonResponseEnvelope {
        self.last_source_attestation = None;
        self.last_strict_error = None;
        let started = Instant::now();
        let mut value = serde_json::from_str::<Value>(line).unwrap_or(Value::Null);
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
            let source = verify_source(&rpc, req.block_number, pin)?;
            let mut session = match self.pinned.take() {
                Some(session) if session.remote.rpc.url == *url
                    && session.remote.source.as_ref() == Some(&source) => session,
                _ => {
                    let mut inner = RemoteRevmDbInner::default();
                    inner.ancestors.insert(req.block_number,
                        (source.attestation.block_hash, source.attestation.parent_hash));
                    PinnedSession { remote: Rc::new(RemoteRevmDb {
                        rpc,
                        block_tag: json!({"blockHash": source.attestation.block_hash, "requireCanonical": true}),
                        source: Some(source.clone()), funded: HashSet::new(),
                        persist: Rc::new(RefCell::new(PersistentCache::default())),
                        inner: RefCell::new(inner),
                    }), balance_slots: HashMap::new(), allowance_slots: HashMap::new() }
                }
            };
            let result = Self::strict_simulate_at(Rc::clone(&session.remote), source.env.clone(),
                &mut session.balance_slots, &mut session.allowance_slots, &req, &plan, started);
            // All outcomes (including probe failure, Revert and Halt) retain the
            // canonical post-check. Optional paths cannot clear the fatal latch.
            verify_canonical(&session.remote.rpc, &source)?;
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

    fn strict_simulate_at(
        remote: Rc<RemoteRevmDb>, env: BlockEnv, balance_slots: &mut HashMap<Address, u64>,
        allowance_slots: &mut HashMap<Address, u64>,
        req: &StrictRequest, plan: &StrictPlan, started: Instant,
    ) -> Result<DaemonResponse> {
        // No prepared overlay, invented funding or transaction-prefix state.
        let mut db = CacheDB::new(SharedRemote(Rc::clone(&remote)));
        if let Some(balance) = plan.native_balance {
            let mut info = db.basic(plan.actor)?.unwrap_or_default();
            info.balance = balance;
            db.insert_account_info(plan.actor, info);
        }
        apply_token_deals(&mut db, &env, &req.token_deals, balance_slots, Some(&remote), true)
            .map_err(|_| StrictFailure(StrictFailureKind::Observation))?;

        // Performance-only hints. Trace values never enter pinned state; every
        // missed/unsupported hint still executes against the identical source.
        let accounts: Vec<_> = plan.calls.iter().flat_map(|c| [c.from, c.to])
            .chain([plan.origin]).collect();
        let mut storage = Vec::new();
        for deal in &req.token_deals {
            let token = parse_address(&deal.token)?;
            for index in mapping_slot_candidates(deal.balance_slot, balance_slots.get(&token).copied()) {
                storage.push((token, erc20_balance_slot(plan.actor, index)));
            }
        }
        for call in &plan.calls[..plan.calls.len() - 1] {
            if let Some(spender) = decode_approve_spender(&call.calldata) {
                if let Some(slot) = call.allowance_slot { allowance_slots.insert(call.to, slot); }
                for index in mapping_slot_candidates(call.allowance_slot, allowance_slots.get(&call.to).copied()) {
                    storage.push((call.to, erc20_allowance_slot(plan.actor, spender, index)));
                }
            }
        }
        if remote.warm_batch(&accounts, &storage, None).is_ok() {
            let refs: Vec<_> = plan.calls.iter().collect();
            let _ = trace_prefetch(&remote, &db, &refs);
        }
        remote.rpc.check_fatal()?;

        // All overrides precede the baseline. Static probes use their own
        // CacheDB/context, never the execution journal or transaction warm set.
        let before_native = plan.native.iter().map(|a| db.basic(*a).map(|v| v.unwrap_or_default().balance))
            .collect::<Result<Vec<_>, _>>()?;
        let before_tokens = plan.pairs.iter().map(|(t, a)| strict_balance_of(&db, &env, *t, *a))
            .collect::<Result<Vec<_>>>()?;
        let before_supply = plan.supply.iter().map(|t| strict_probe(&db, &env, *t, Bytes::from_static(&TOTAL_SUPPLY_SELECTOR)))
            .collect::<Result<Vec<_>>>()?;

        let (outcome, gas_used, logs) = strict_execute(&mut db, &env, req, plan)?;
        let success = matches!(outcome, StrictOutcome::Success { .. });
        let output = match &outcome {
            StrictOutcome::Success { output, .. } | StrictOutcome::Revert { output, .. } => Some(output.clone()),
            StrictOutcome::Halt { .. } => None,
        };
        let revert_reason = match &outcome { StrictOutcome::Revert { output, .. } => Some(output.clone()), _ => None };
        let mut effects = StrictSimulateEffects { outcome, execution_gas_used: gas_used.to_string(),
            native_deltas: Vec::new(), token_deltas: Vec::new(), total_supply_deltas: Vec::new(),
            logs: if success && req.observe_logs { logs } else { Vec::new() } };
        // A failed sibling has no accepted effects, not partial setup effects.
        if success {
            for (i, account) in plan.native.iter().enumerate() {
                let after = db.basic(*account)?.unwrap_or_default().balance;
                effects.native_deltas.push(SimNativeDelta { account: format!("{account:#x}"),
                    before: before_native[i].to_string(), after: after.to_string(), delta: signed_delta(after, before_native[i]) });
            }
            for (i, (token, account)) in plan.pairs.iter().enumerate() {
                let after = strict_balance_of(&db, &env, *token, *account)?;
                effects.token_deltas.push(SimTokenDelta { token: format!("{token:#x}"), account: format!("{account:#x}"),
                    delta: signed_delta(after, before_tokens[i]) });
            }
            for (i, token) in plan.supply.iter().enumerate() {
                let after = strict_probe(&db, &env, *token, Bytes::from_static(&TOTAL_SUPPLY_SELECTOR))?;
                effects.total_supply_deltas.push(SimTotalSupplyDelta { token: format!("{token:#x}"),
                    delta: signed_delta(after, before_supply[i]) });
            }
        }
        Ok(DaemonResponse { ok: true, error: None, success: Some(success), output, profit: None,
            gas_used: Some(gas_used.to_string()), revert_reason, latency_ms: started.elapsed().as_millis(),
            missing_state_keys: db.db.missing_state_keys(), cache_stats: None, seed_stats: None, strict: Some(effects) })
    }
}

struct StrictPlan {
    actor: Address,
    origin: Address,
    inner: bool,
    native_balance: Option<U256>,
    native: Vec<Address>,
    pairs: Vec<(Address, Address)>,
    supply: Vec<Address>,
    calls: Vec<ParsedPreCall>,
}

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
        let inner = match req.caller_mode.as_deref() { None | Some("top-level") => false,
            Some("impersonated-call-frame") => true, _ => bail!("invalid caller mode") };
        let origin = req.transaction_origin.as_deref().map(address).transpose()?;
        if inner && (origin.is_none() || req.execution_gas_limit.is_none()) { bail!("missing inner context"); }
        if !inner && origin.is_some_and(|o| o != actor) { bail!("top-level origin differs"); }
        for gas in [req.gas_limit, req.execution_gas_limit].into_iter().flatten() {
            if gas == 0 || gas > 9_007_199_254_740_991 { bail!("invalid gas limit"); }
        }
        let mut calls = Vec::new();
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
        Ok(Self { actor, origin: origin.unwrap_or(actor), inner,
            native_balance: req.native_balance_wei.as_deref().map(uint).transpose()?,
            native: addresses(req.observe_native_balances.as_deref().unwrap_or(&[]))?, pairs,
            supply: addresses(&req.observe_total_supply)?, calls })
    }
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

fn strict_execute<D: ExecutionProfile>(db: &mut CacheDB<D>, env: &BlockEnv, req: &StrictRequest, plan: &StrictPlan)
    -> Result<(StrictOutcome, u64, Vec<SimLog>)> {
    let profile = db.db.execution_profile();
    let ctx = Context::mainnet().modify_cfg_chained(|cfg| strict_cfg(cfg, profile)).with_block(env.clone()).with_db(&mut *db);
    let mut evm = ctx.build_mainnet();
    let mut handler = StrictHandler::<_, EVMError<RpcError>, _>::new(if plan.inner { Some((plan.actor, 1, false)) } else { None });
    let mut used = 0u64;
    let mut logs = Vec::new();
    for (index, call) in plan.calls.iter().enumerate() {
        let stage = if index + 1 == plan.calls.len() { StrictStage::Main } else { StrictStage::PreCall { index } };
        let cap = req.execution_gas_limit.map_or(call.gas_limit, |budget| call.gas_limit.min(budget.saturating_sub(used)));
        if cap == 0 { return Ok((StrictOutcome::Halt { reason: "OutOfGas".into(), stage }, used, Vec::new())); }
        let nonce = evm.ctx.journaled_state.load_account_with_code(plan.origin)?.info.nonce;
        // TxEnv supplies opcode environment for isolated CALLs, not a signed
        // transaction. Its unused nonce is zero; actual account nonces are never
        // overridden. Top-level messages instead consume the current nonce.
        evm.ctx.tx = strict_tx(env, plan.origin, call.to, Bytes::from(call.calldata.clone()), cap, if plan.inner { 0 } else { nonce });
        let result = if plan.inner {
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
        logs.extend(result.logs().iter().map(|log| SimLog { address: format!("{:#x}", log.address),
            topics: log.data.topics().iter().map(|t| format!("{t:#x}")).collect(), data: hex_output(&log.data.data) }));
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
        if !result.instruction_result().is_ok() || bytes.len() != 32 { bail!("invalid static observation"); }
        Ok(U256::from_be_slice(&bytes))
    };
    probe().map_err(|_| StrictFailure(StrictFailureKind::Observation).into())
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
        bail!(
            "balanceOf({token:#x},{account:#x}) failed: {}",
            format_execution_result(&output.result)
        );
    }
    let bytes = output
        .result
        .output()
        .ok_or_else(|| anyhow!("balanceOf returned no output"))?;
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
        if deal_balance(db, block_env, token, to, strict)? >= amount {
            continue;
        }

        let mut applied = false;
        for slot_index in
            mapping_slot_candidates(deal.balance_slot, balance_slots.get(&token).copied())
        {
            let slot = erc20_balance_slot(to, slot_index);
            let original = db
                .storage(token, slot)
                .map_err(|err| anyhow!("failed reading deal slot {token:#x}:{slot:#x}: {err}"))?;
            db.insert_account_storage(token, slot, amount)
                .map_err(|err| anyhow!("failed writing deal slot {token:#x}:{slot:#x}: {err}"))?;
            mark_account_touched(db, token);
            let balance = deal_balance(db, block_env, token, to, strict)?;
            if balance >= amount {
                balance_slots.insert(token, slot_index);
                applied = true;
                break;
            }
            db.insert_account_storage(token, slot, original)
                .map_err(|err| anyhow!("failed restoring deal slot {token:#x}:{slot:#x}: {err}"))?;
            mark_account_touched(db, token);
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
                        let original = db.storage(*owner, slot).map_err(|err| {
                            anyhow!("failed reading fallback slot {owner:#x}:{slot:#x}: {err}")
                        })?;
                        db.insert_account_storage(*owner, slot, amount).map_err(|err| {
                            anyhow!("failed writing fallback slot {owner:#x}:{slot:#x}: {err}")
                        })?;
                        mark_account_touched(db, *owner);
                        let balance =
                            deal_balance(db, block_env, token, to, strict)?;
                        if balance >= amount {
                            balance_slots.insert(token, slot_index);
                            applied = true;
                            break 'fallback_outer;
                        }
                        db.insert_account_storage(*owner, slot, original).map_err(|err| {
                            anyhow!("failed restoring fallback slot {owner:#x}:{slot:#x}: {err}")
                        })?;
                        mark_account_touched(db, *owner);
                    }
                }
            }
        }
        if !applied {
            if let Some(remote) = remote {
                for (storage_owner, slot) in
                    discover_erc20_balance_storage_candidates(remote, token, to)?
                {
// The balance may live in a proxy implementation: its
// code must be warm before balanceOf executes, or
// code_by_hash_ref fails and the call reverts to 0.
let _ = db.basic_ref(token);
let _ = db.basic_ref(storage_owner);
                    let original = db.storage(storage_owner, slot).map_err(|err| {
                        anyhow!(
                            "failed reading discovered slot {storage_owner:#x}:{slot:#x}: {err}"
                        )
                    })?;
                    let mut override_value = amount;
                    for attempt in 0..4 {
                        db.insert_account_storage(storage_owner, slot, override_value)
                            .map_err(|err| {
                                anyhow!(
                                    "failed writing discovered slot {storage_owner:#x}:{slot:#x}: {err}"
                                )
                            })?;
                        mark_account_touched(db, storage_owner);
                        let balance = if strict { strict_balance_of(db, block_env, token, to)? } else {
                            let Ok(balance) = erc20_balance_of(db, block_env, token, to) else { break; };
                            balance
                        };
eprintln!("[revm-sim] deal slot try token={token:#x} owner={storage_owner:#x} slot={slot:#x} amount={amount}");
eprintln!("[revm-sim] deal slot balance after write: {balance}");
                        if balance >= amount {
                            applied = true;
                            break;
                        }
                        let Some(next) = next_discovered_balance_override(
                            amount,
                            override_value,
                            balance,
                            attempt,
                        ) else {
                            break;
                        };
                        override_value = next;
                    }
                    if applied {
                        break;
                    }
                    db.insert_account_storage(storage_owner, slot, original)
                        .map_err(|err| {
                            anyhow!(
                                "failed restoring discovered slot {storage_owner:#x}:{slot:#x}: {err}"
                            )
                        })?;
                    mark_account_touched(db, storage_owner);
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

fn deal_balance<D: ExecutionProfile>(db: &mut CacheDB<D>, env: &BlockEnv, token: Address, account: Address, strict: bool) -> Result<U256> {
    if strict { strict_balance_of(db, env, token, account) }
    else { Ok(erc20_balance_of(db, env, token, account).unwrap_or(U256::ZERO)) }
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
        .map_err(|err| anyhow!("revm transact failed: {err:?}"))?;
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
    fn rpc_fixture(status: u16, body: Value) -> (RpcClient, std::thread::JoinHandle<()>) {
        rpc_fixture_steps(vec![(status, body)])
    }

    fn rpc_fixture_steps(steps: Vec<(u16, Value)>) -> (RpcClient, std::thread::JoinHandle<()>) {
        use std::io::Read;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            for (status, body) in steps {
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
                stream.read_exact(&mut vec![0; length]).unwrap();
                let body = body.to_string();
                write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
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
    fn physical_429_latches_before_any_later_call_or_batch() {
        for batch in [false, true] {
            let (rpc, thread) = rpc_fixture(429, json!({"error": "untrusted provider body"}));
            if batch {
                assert!(rpc.batch_call(&[("eth_call", json!([]))]).is_err());
            } else {
                assert!(rpc.call("eth_call", json!([])).is_err());
            }
            thread.join().unwrap();
            assert!(rpc.call("eth_call", json!([])).is_err());
            assert!(rpc.batch_call(&[("eth_call", json!([]))]).is_err());
            assert_eq!(rpc.round_trips(), 1, "latched calls must perform zero I/O");
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
                let (rpc, thread) =
                    rpc_fixture_steps(vec![(200, fixture_header()), (status, body)]);
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
                assert_eq!(daemon.warm.as_ref().unwrap().remote.rpc.round_trips(), 2);
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
