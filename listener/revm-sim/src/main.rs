use std::{
    cell::RefCell,
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
    context_interface::result::ExecutionResult,
    database::{AccountState, CacheDB},
    database_interface::{DBErrorMarker, DatabaseRef},
    primitives::{Address, B256, Bytes, U256, hardfork::SpecId, keccak256},
    state::AccountInfo,
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

#[derive(Debug)]
struct RpcClient {
    url: String,
    client: Client,
    /// Count of HTTP round trips (single calls + batches each count once). This
    /// is the RPC-latency-independent cost metric for `prepare`: on a warm
    /// keep-alive connection wall time is roughly round_trips × warm RTT, so the
    /// lever is keeping this number minimal while preserving batch structure.
    round_trips: std::cell::Cell<u64>,
}

impl RpcClient {
    fn new(url: String, client: Client) -> Result<Self> {
        Ok(Self {
            url,
            client,
            round_trips: std::cell::Cell::new(0),
        })
    }

    fn round_trips(&self) -> u64 {
        self.round_trips.get()
    }

    fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.round_trips.set(self.round_trips.get() + 1);
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let response: Value = self
            .client
            .post(&self.url)
            .json(&body)
            .send()
            .with_context(|| format!("rpc {method} send failed"))?
            .error_for_status()
            .with_context(|| format!("rpc {method} http status failed"))?
            .json()
            .with_context(|| format!("rpc {method} json decode failed"))?;
        if let Some(error) = response.get("error") {
            bail!("rpc {method} error: {error}");
        }
        response
            .get("result")
            .cloned()
            .ok_or_else(|| anyhow!("rpc {method} response missing result"))
    }

    /// Many JSON-RPC calls in one HTTP round trip. Results are returned in the
    /// same order as `calls`; a per-call error becomes an `Err` entry while a
    /// transport failure fails the whole batch.
    fn batch_call(&self, calls: &[(&str, Value)]) -> Result<Vec<Result<Value>>> {
        if calls.is_empty() {
            return Ok(Vec::new());
        }
        self.round_trips.set(self.round_trips.get() + 1);
        let body: Vec<Value> = calls
            .iter()
            .enumerate()
            .map(|(id, (method, params))| {
                json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
            })
            .collect();
        let response: Value = self
            .client
            .post(&self.url)
            .json(&body)
            .send()
            .context("rpc batch send failed")?
            .error_for_status()
            .context("rpc batch http status failed")?
            .json()
            .context("rpc batch json decode failed")?;
        let items = response
            .as_array()
            .ok_or_else(|| anyhow!("rpc batch: non-array response"))?;
        let mut by_id: HashMap<u64, &Value> = HashMap::new();
        for item in items {
            if let Some(id) = item.get("id").and_then(Value::as_u64) {
                by_id.insert(id, item);
            }
        }
        Ok((0..calls.len() as u64)
            .map(|id| match by_id.get(&id) {
                None => Err(anyhow!("rpc batch: missing response for id {id}")),
                Some(item) => {
                    if let Some(error) = item.get("error") {
                        Err(anyhow!("rpc batch error: {error}"))
                    } else {
                        item.get("result")
                            .cloned()
                            .ok_or_else(|| anyhow!("rpc batch: missing result for id {id}"))
                    }
                }
            })
            .collect())
    }
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

/// Daemon-lifetime cache for block-stable state. Contract bytecode is immutable
/// by hash and effectively immutable by address for our use; persisting it
/// across blocks means a new block only re-fetches balances/nonces/storage.
#[derive(Debug, Default)]
struct PersistentCache {
    codes_by_addr: HashMap<Address, Bytecode>,
    codes_by_hash: HashMap<B256, Bytecode>,
}

#[derive(Debug)]
struct RemoteRevmDb {
    rpc: RpcClient,
    block_tag: String,
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
    ) -> Result<Self> {
        Ok(Self {
            rpc: RpcClient::new(rpc_url, http)?,
            block_tag: hex_quantity_u64(block_number),
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
                continue;
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
        self.load_account(address)
    }

    fn code_by_hash_ref(&self, code_hash: B256) -> Result<Bytecode, Self::Error> {
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
        Err(RpcError(format!("code not cached for hash {code_hash:#x}")))
    }

    fn storage_ref(&self, address: Address, index: U256) -> Result<U256, Self::Error> {
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
    )?;
    let block_env = load_block_env(&remote.rpc, req.block_number)?;
    let mut db = CacheDB::new(remote);
    let mut balance_slots = HashMap::new();
    apply_state_overrides(&mut db, &req.state_overrides)?;
    apply_token_deals(&mut db, &block_env, &req.token_deals, &mut balance_slots)?;
    for call in pre_calls {
        let pre = execute_call(
            &mut db,
            &block_env,
            call.from,
            call.to,
            Bytes::from(call.calldata),
            call.gas_limit,
            true,
        )?;
        if !pre.result.is_success() {
            bail!("preCall failed: {}", format_execution_result(&pre.result));
        }
        db.commit(pre.state);
    }

    let pre = erc20_balance_of(&mut db, &block_env, profit_token, executor)?;
    let main = execute_call(
        &mut db, &block_env, owner, executor, calldata, gas_limit, true,
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
    #[serde(rename_all = "camelCase")]
    StrictSimulate {
        block_number: u64,
        #[serde(default)]
        rpc_url: Option<String>,
        from: String,
        to: String,
        data: String,
        #[serde(default)]
        gas_limit: Option<u64>,
        #[serde(default)]
        pre_calls: Vec<PreCall>,
        #[serde(default)]
        token_deals: Vec<TokenDeal>,
        #[serde(default)]
        observe_tokens: Vec<String>,
        #[serde(default)]
        observe_total_supply: Vec<String>,
        #[serde(default)]
        observe_logs: bool,
    },
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
    token_deltas: Vec<SimTokenDelta>,
    total_supply_deltas: Vec<SimTotalSupplyDelta>,
    logs: Vec<SimLog>,
}

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

#[derive(Default)]
struct Daemon {
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
        let started = Instant::now();
        let response = match serde_json::from_str::<DaemonRequest>(&line) {
            Ok(req) => daemon.handle(req, started),
            Err(err) => DaemonResponse::err(format!("bad request: {err}"), started),
        };
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}

impl Daemon {
    fn http_client(&mut self) -> Result<Client> {
        if self.http.is_none() {
            self.http = Some(build_http_client()?);
        }
        Ok(self.http.as_ref().expect("http initialized above").clone())
    }

    fn handle(&mut self, req: DaemonRequest, started: Instant) -> DaemonResponse {
        match self.dispatch(req, started) {
            Ok(resp) => resp,
            Err(err) => DaemonResponse::err(err.to_string(), started),
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
            DaemonRequest::StrictSimulate {
                block_number,
                rpc_url,
                from,
                to,
                data,
                gas_limit,
                pre_calls,
                token_deals,
                observe_tokens,
                observe_total_supply,
                observe_logs,
            } => self.strict_simulate(
                block_number,
                rpc_url,
                from,
                to,
                data,
                gas_limit,
                pre_calls,
                token_deals,
                observe_tokens,
                observe_total_supply,
                observe_logs,
                started,
            ),
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
        apply_token_deals(&mut db, &block_env, &token_deals, &mut self.balance_slots)?;
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

    #[allow(clippy::too_many_arguments)]
    fn strict_simulate(
        &mut self,
        block_number: u64,
        rpc_url: Option<String>,
        from: String,
        to: String,
        data: String,
        gas_limit: Option<u64>,
        pre_calls: Vec<PreCall>,
        token_deals: Vec<TokenDeal>,
        observe_tokens: Vec<String>,
        observe_total_supply: Vec<String>,
        observe_logs: bool,
        started: Instant,
    ) -> Result<DaemonResponse> {
        self.ensure_warm(block_number, rpc_url)?;
        let remote_rc = Rc::clone(
            &self.warm.as_ref().expect("warm set above").remote,
        );
        let mut db = CacheDB::new(SharedRemote(remote_rc));
        let block_env = load_block_env(
            &self.warm.as_ref().expect("warm set").remote.rpc,
            block_number,
        )?;
        let caller = parse_address(&from)?;
        let target = parse_address(&to)?;
        let calldata = Bytes::from(parse_hex_bytes(&data)?);
        let parsed_pre_calls = parse_pre_calls(&pre_calls)?;
        let gas_limit = gas_limit.unwrap_or(DEFAULT_GAS_LIMIT);
        let mut fund_account = |address: Address| -> Result<()> {
            let info = db
                .basic(address)
                .map_err(|err| {
                    anyhow!("strict fund basic {address:#x}: {err}")
                })?
                .unwrap_or_default();
            let mut funded = info;
            funded.balance = U256::MAX;
            db.insert_account_info(address, funded);
            Ok(())
        };
        fund_account(caller)?;
        fund_account(Address::ZERO)?;
        for call in &parsed_pre_calls {
            fund_account(call.from)?;
        }

        apply_token_deals(
            &mut db,
            &block_env,
            &token_deals,
            &mut self.balance_slots,
        )?;

        let mut observed_tokens: Vec<Address> = Vec::new();
        let mut balances_before: Vec<(Address, U256)> = Vec::new();
        for raw in &observe_tokens {
            let token = parse_address(raw)?;
            observed_tokens.push(token);
            balances_before.push((
                token,
                erc20_balance_of(&mut db, &block_env, token, caller)?,
            ));
        }
        let mut supply_tokens: Vec<Address> = Vec::new();
        let mut supply_before: Vec<(Address, U256)> = Vec::new();
        for raw in &observe_total_supply {
            let token = parse_address(raw)?;
            supply_tokens.push(token);
            supply_before.push((
                token,
                erc20_total_supply(&mut db, &block_env, token)?,
            ));
        }

        for call in parsed_pre_calls {
            let pre = execute_call(
                &mut db,
                &block_env,
                call.from,
                call.to,
                Bytes::from(call.calldata),
                call.gas_limit,
                true,
            )?;
            if !pre.result.is_success() {
                bail!(
                    "strict preCall failed: {}",
                    format_execution_result(&pre.result)
                );
            }
            db.commit(pre.state);
        }

        let main = execute_call(
            &mut db,
            &block_env,
            caller,
            target,
            calldata,
            gas_limit,
            true,
        )?;
        let success = main.result.is_success();
        let output = main
            .result
            .output()
            .map(|bytes| format!("0x{}", hex::encode(bytes.as_ref())));
        let logs: Vec<SimLog> = if observe_logs {
            main.result
                .logs()
                .iter()
                .map(|log| SimLog {
                    address: format!("{:#x}", log.address),
                    topics: log
                        .data
                        .topics()
                        .iter()
                        .map(|topic| format!("{topic:#x}"))
                        .collect(),
                    data: format!("0x{}", hex::encode(log.data.data.as_ref())),
                })
                .collect()
        } else {
            Vec::new()
        };
        let revert_reason = if success {
            None
        } else {
            Some(format_execution_result(&main.result))
        };
        if success {
            db.commit(main.state);
        }

        let mut token_deltas: Vec<SimTokenDelta> = Vec::new();
        for (index, (token, before)) in balances_before.iter().enumerate() {
            let _ = &observed_tokens[index];
            let after = erc20_balance_of(&mut db, &block_env, *token, caller)?;
            token_deltas.push(SimTokenDelta {
                token: format!("{token:#x}"),
                account: format!("{caller:#x}"),
                delta: signed_delta(after, *before),
            });
        }
        let mut total_supply_deltas: Vec<SimTotalSupplyDelta> = Vec::new();
        for (index, (token, before)) in supply_before.iter().enumerate() {
            let _ = &supply_tokens[index];
            let after = erc20_total_supply(&mut db, &block_env, *token)?;
            total_supply_deltas.push(SimTotalSupplyDelta {
                token: format!("{token:#x}"),
                delta: signed_delta(after, *before),
            });
        }

        Ok(DaemonResponse {
            ok: true,
            error: None,
            success: Some(success),
            output,
            profit: None,
            gas_used: Some(main.result.tx_gas_used().to_string()),
            revert_reason,
            latency_ms: started.elapsed().as_millis(),
            missing_state_keys: db.db.missing_state_keys(),
            cache_stats: None,
            seed_stats: None,
            strict: Some(StrictSimulateEffects {
                token_deltas,
                total_supply_deltas,
                logs,
            }),
        })
    }
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
    D: DatabaseRef<Error = RpcError>,
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

fn erc20_total_supply<D>(
    db: &mut CacheDB<D>,
    block_env: &BlockEnv,
    token: Address,
) -> Result<U256>
where
    D: DatabaseRef<Error = RpcError>,
{
    let output = execute_call(
        db,
        block_env,
        Address::ZERO,
        token,
        Bytes::from_static(&TOTAL_SUPPLY_SELECTOR),
        300_000,
        false,
    )?;
    if !output.result.is_success() {
        bail!(
            "totalSupply({token:#x}) failed: {}",
            format_execution_result(&output.result)
        );
    }
    let bytes = output
        .result
        .output()
        .ok_or_else(|| anyhow!("totalSupply returned no output"))?;
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
) -> Result<()>
where
    D: DatabaseRef<Error = RpcError>,
{
    for deal in deals {
        let token = parse_address(&deal.token)?;
        let to = parse_address(&deal.to)?;
        let amount = parse_u256(&deal.amount).map_err(|err| anyhow!(err.to_string()))?;
        if amount.is_zero() {
            continue;
        }
        if erc20_balance_of(db, block_env, token, to).unwrap_or(U256::ZERO) >= amount {
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
            let balance = erc20_balance_of(db, block_env, token, to).unwrap_or(U256::ZERO);
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
            bail!("could not locate ERC20 balance slot for token {token:#x}");
        }
    }
    Ok(())
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

const ERC20_MAPPING_SLOT_CANDIDATES: [u64; 8] = [0, 1, 2, 3, 4, 5, 9, 51];

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
) -> Result<revm::context_interface::result::ResultAndState>
where
    D: DatabaseRef<Error = RpcError>,
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

    let ctx = Context::mainnet()
        .modify_cfg_chained(|cfg| {
            cfg.set_spec_and_mainnet_gas_params(SpecId::PRAGUE);
            cfg.disable_nonce_check = true;
            cfg.tx_chain_id_check = false;
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
