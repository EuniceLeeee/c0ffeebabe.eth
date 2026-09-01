//! A resident, single-flight REVM worker for the Aloha JSONL protocol.
//!
//! The TypeScript side owns runtime/worker authority.  This process only
//! executes a validated request and echoes those authority facts into the
//! result.  It deliberately has no fixture, legacy, or prepared-cache mode.

use std::{
    cmp::Ordering,
    collections::BTreeSet,
    env,
    io::{self, BufRead, Write},
};

use revm::{
    Database, DatabaseCommit, ExecuteEvm, MainBuilder, MainContext,
    bytecode::Bytecode,
    context::{BlockEnv, Context, TxEnv},
    database::CacheDB,
    database_interface::EmptyDB,
    primitives::{Address, Bytes, U256, hardfork::SpecId},
};
use serde_json::{Map, Number, Value, json};
use sha2::{Digest, Sha256};

const WIRE_VERSION: u64 = 1;
const ENGINE: &str = "revm";
const DEFAULT_ENGINE_BUILD: &str = "revm-40.0.3";
const DEFAULT_EXECUTABLE_FINGERPRINT: &str = "aloha-revm-worker-rust-v1";
const DEFAULT_GAS_LIMIT: u64 = 16_777_216;
const MAX_CANONICAL_BYTES: usize = 1_048_576;
const MAX_CANONICAL_DEPTH: usize = 64;
const MAX_CANONICAL_ARRAY_ITEMS: usize = 16_384;
const MAX_CANONICAL_OBJECT_PROPERTIES: usize = 16_384;
const MAX_CANONICAL_STRING_CODE_UNITS: usize = 131_072;
const MAX_CANONICAL_DECIMAL_DIGITS: usize = 128;

#[derive(Debug, Clone)]
struct Options {
    worker_epoch: String,
    engine_build_fingerprint: String,
    executable_fingerprint: String,
}

#[derive(Debug)]
struct WorkerError(String);

impl WorkerError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WorkerError {}

fn main() {
    if let Err(error) = run() {
        eprintln!("aloha-revm-worker: {error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), WorkerError> {
    let options = Options::from_env_and_args()?;
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    write_line(&mut stdout, &hello(&options))?;

    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    let mut line = String::new();
    loop {
        line.clear();
        if stdin
            .read_line(&mut line)
            .map_err(|error| WorkerError::new(format!("stdin: {error}")))?
            == 0
        {
            break;
        }
        if line.ends_with('\n') {
            line.pop();
        }
        if line.is_empty() {
            continue;
        }
        if line.len() > MAX_CANONICAL_BYTES {
            eprintln!("aloha-revm-worker: ignored oversized JSONL request");
            continue;
        }

        // The wire decoder requires canonical JSON bytes. Parse and compare
        // before simulation so hashes bind exactly what the TypeScript codec
        // accepts. A structurally bindable non-canonical envelope receives a
        // fail-closed protocol error instead of being silently converted into
        // a request deadline.
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("aloha-revm-worker: ignored malformed JSONL request: {error}");
                continue;
            }
        };
        if canonical_json(&value).ok().as_deref() != Some(line.as_str()) {
            if let Some(request) = value.as_object().and_then(request_for_error) {
                write_line(
                    &mut stdout,
                    &error_response(
                        &request,
                        "invalid-request",
                        "REVM request is not canonical JSON".to_string(),
                    ),
                )?;
            } else {
                eprintln!("aloha-revm-worker: rejected non-canonical JSONL request");
            }
            continue;
        }

        let response = match parse_request(&value) {
            Ok(request) => match simulate(&request, &options) {
                Ok(result) => result,
                Err(error) => error_response(&request, "worker-error", error.to_string()),
            },
            Err((request, message)) => match request {
                Some(request) => error_response(&request, "invalid-request", message),
                None => {
                    eprintln!("aloha-revm-worker: rejected request: {message}");
                    continue;
                }
            },
        };
        write_line(&mut stdout, &response)?;
    }
    Ok(())
}

impl Options {
    fn from_env_and_args() -> Result<Self, WorkerError> {
        let mut worker_epoch = env::var("REVM_WORKER_EPOCH").unwrap_or_default();
        let mut engine_build_fingerprint =
            env::var("REVM_ENGINE_BUILD_FINGERPRINT").unwrap_or_default();
        let mut executable_fingerprint =
            env::var("REVM_EXECUTABLE_FINGERPRINT").unwrap_or_default();
        let mut args = env::args().skip(1);
        while let Some(arg) = args.next() {
            let destination = match arg.as_str() {
                "--worker-epoch" => &mut worker_epoch,
                "--engine-build-fingerprint" => &mut engine_build_fingerprint,
                "--executable-fingerprint" => &mut executable_fingerprint,
                "--help" | "-h" => {
                    println!(
                        "aloha-revm-worker [--worker-epoch EPOCH] [--engine-build-fingerprint HASH] [--executable-fingerprint HASH]"
                    );
                    std::process::exit(0);
                }
                other => return Err(WorkerError::new(format!("unsupported argument {other}"))),
            };
            *destination = args
                .next()
                .ok_or_else(|| WorkerError::new(format!("{arg} requires a value")))?;
        }
        if worker_epoch.is_empty() {
            worker_epoch = "worker-epoch-unconfigured".to_string();
        }
        if engine_build_fingerprint.is_empty() {
            engine_build_fingerprint = DEFAULT_ENGINE_BUILD.to_string();
        }
        if executable_fingerprint.is_empty() {
            executable_fingerprint = DEFAULT_EXECUTABLE_FINGERPRINT.to_string();
        }
        Ok(Self {
            worker_epoch,
            engine_build_fingerprint,
            executable_fingerprint,
        })
    }
}

fn hello(options: &Options) -> Value {
    json!({
        "wireVersion": WIRE_VERSION,
        "kind": "hello",
        "op": "hello",
        "workerEpoch": options.worker_epoch,
        "engine": ENGINE,
        "engineBuildFingerprint": options.engine_build_fingerprint,
        "executableFingerprint": options.executable_fingerprint,
    })
}

fn write_line(writer: &mut impl Write, value: &Value) -> Result<(), WorkerError> {
    let encoded = canonical_json(value)?;
    writer
        .write_all(encoded.as_bytes())
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|error| WorkerError::new(format!("stdout: {error}")))
}

#[derive(Debug, Clone)]
struct Request {
    raw: Map<String, Value>,
}

fn parse_request(value: &Value) -> Result<Request, (Option<Request>, String)> {
    let Some(object) = value.as_object() else {
        return Err((None, "REVM request must be an object".to_string()));
    };
    let maybe_request = request_for_error(object);
    if let Err(error) = exact_keys(
        object,
        &[
            "wireVersion",
            "kind",
            "op",
            "requestId",
            "workerEpoch",
            "ownerRef",
            "generationId",
            "attemptId",
            "authority",
            "source",
            "caller",
            "observeAccounts",
            "program",
            "input",
            "inputHash",
            "deadlineAtMs",
        ],
    ) {
        return Err((maybe_request, error));
    }
    if get_u64(object, "wireVersion") != Some(WIRE_VERSION)
        || get_string(object, "kind") != Some("request")
        || get_string(object, "op") != Some("simulate")
    {
        return Err((
            maybe_request,
            "unsupported REVM request envelope".to_string(),
        ));
    }
    if object.contains_key("disable_eip3607") || object.contains_key("disableEip3607") {
        return Err((
            maybe_request,
            "global EIP-3607 disable is not a valid REVM request".to_string(),
        ));
    }

    let request = Request {
        raw: object.clone(),
    };
    if let Err(error) = validate_request(&request) {
        return Err((request_for_error(&request.raw), error));
    }
    Ok(request)
}

fn request_for_error(object: &Map<String, Value>) -> Option<Request> {
    // We only emit a protocol error once enough fields exist to preserve the
    // exact response envelope.  Structurally incomplete input is rejected on
    // stderr because the protocol has no authority facts to echo.
    let required = [
        "requestId",
        "workerEpoch",
        "ownerRef",
        "generationId",
        "attemptId",
        "authority",
        "inputHash",
        "deadlineAtMs",
    ];
    if !required.iter().all(|key| object.contains_key(*key)) {
        return None;
    }
    for key in [
        "requestId",
        "workerEpoch",
        "ownerRef",
        "generationId",
        "attemptId",
        "inputHash",
    ] {
        if require_string(object, key).is_err() {
            return None;
        }
    }
    if require_number(object, "deadlineAtMs").is_err() {
        return None;
    }
    let authority = match require_object(object, "authority") {
        Ok(value) => value,
        Err(_) => return None,
    };
    if validate_authority_projection(authority).is_err() {
        return None;
    }
    Some(Request {
        raw: object.clone(),
    })
}

fn validate_request(request: &Request) -> Result<(), String> {
    let object = &request.raw;
    for key in [
        "requestId",
        "workerEpoch",
        "ownerRef",
        "generationId",
        "attemptId",
        "inputHash",
    ] {
        require_string(object, key)?;
    }
    require_number(object, "deadlineAtMs")?;
    let authority = require_object(object, "authority")?;
    validate_authority_projection(authority)?;
    let runtime = require_object(authority, "runtime")?;
    if get_string(authority, "workerEpoch") != get_string(runtime, "workerEpoch")
        || get_string(authority, "executorSessionHash")
            != get_string(runtime, "executorSessionHash")
        || get_string(authority, "authorityRoot") != get_string(runtime, "executorAuthorityRoot")
    {
        return Err("authority binding does not match runtime lease".to_string());
    }
    if get_string(object, "workerEpoch") != get_string(authority, "workerEpoch") {
        return Err("request worker epoch does not match authority".to_string());
    }

    let source = require_object(object, "source")?;
    exact_keys(source, &["chainId", "number", "hash", "stateRoot"])?;
    for key in ["chainId", "number", "hash", "stateRoot"] {
        require_string(source, key)?;
    }

    let caller = require_object(object, "caller")?;
    exact_keys(
        caller,
        &["address", "mode", "observedSender", "verifiedActors"],
    )?;
    let address = require_string(caller, "address")?;
    let observed_sender = require_string(caller, "observedSender")?;
    let mode = require_string(caller, "mode")?;
    if mode != "top-level" && mode != "impersonated-call-frame" {
        return Err("caller.mode is unsupported".to_string());
    }
    let actors = require_object(caller, "verifiedActors")?;
    for value in actors.values() {
        if value.as_str().is_none_or(str::is_empty) {
            return Err("caller.verifiedActors values must be non-empty strings".to_string());
        }
    }
    if mode == "top-level" && observed_sender != address {
        return Err("top-level caller observedSender must equal address".to_string());
    }
    if mode == "impersonated-call-frame" && actors.is_empty() {
        return Err("impersonated caller requires verified actors".to_string());
    }

    let observed = require_array(object, "observeAccounts")?;
    let mut previous: Option<&str> = None;
    let mut seen = BTreeSet::new();
    for item in observed {
        let account = item
            .as_str()
            .ok_or_else(|| "observeAccounts entries must be strings".to_string())?;
        if account.is_empty()
            || !seen.insert(account.to_string())
            || previous.is_some_and(|value| compare_utf16(value, account) != Ordering::Less)
        {
            return Err("observeAccounts must be sorted and unique".to_string());
        }
        previous = Some(account);
    }

    let program = require_object(object, "program")?;
    let mut program_keys = vec!["format", "schemaHash", "programHash", "bytes"];
    if program.contains_key("effectTransport") {
        program_keys.push("effectTransport");
    }
    exact_keys(program, &program_keys)?;
    if get_string(program, "format") != Some("frozen-program-v1") {
        return Err("program format is unsupported".to_string());
    }
    for key in ["schemaHash", "programHash", "bytes"] {
        require_string(program, key)?;
    }
    if let Some(effect_transport) = program.get("effectTransport") {
        validate_effect_transport(effect_transport)?;
        let mode =
            get_string(caller, "mode").ok_or_else(|| "caller.mode is required".to_string())?;
        let declaration = effect_transport
            .as_object()
            .ok_or_else(|| "effectTransport must be an object".to_string())?;
        let effect_caller = require_object(declaration, "caller")?;
        if get_string(effect_caller, "executionMode") != Some(mode) {
            return Err("effect transport caller mode does not match request caller".to_string());
        }
        let ref_value = effect_caller
            .get("ref")
            .ok_or_else(|| "effectTransport.caller.ref is required".to_string())?;
        if let Some(address) = ref_value.as_str() {
            if address != get_string(caller, "address").unwrap_or_default() {
                return Err(
                    "effect transport caller address does not match request caller".to_string(),
                );
            }
        }
    }

    let expected_input_hash = hash_domain(
        "aloha/revm-program-input/v1",
        object
            .get("input")
            .ok_or_else(|| "input is required".to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if get_string(object, "inputHash") != Some(expected_input_hash.as_str()) {
        return Err("inputHash does not bind input".to_string());
    }
    let mut without_program_hash = json!({
        "format": program.get("format").cloned().unwrap_or(Value::Null),
        "schemaHash": program.get("schemaHash").cloned().unwrap_or(Value::Null),
        "bytes": program.get("bytes").cloned().unwrap_or(Value::Null),
    });
    if let Some(effect_transport) = program.get("effectTransport") {
        without_program_hash
            .as_object_mut()
            .expect("program hash payload is an object")
            .insert("effectTransport".to_string(), effect_transport.clone());
    }
    let expected_program_hash = hash_domain("aloha/frozen-program-wire/v1", &without_program_hash)
        .map_err(|error| error.to_string())?;
    if get_string(program, "programHash") != Some(expected_program_hash.as_str()) {
        return Err("programHash does not bind frozen program bytes".to_string());
    }
    Ok(())
}

fn validate_authority_projection(authority: &Map<String, Value>) -> Result<(), String> {
    exact_keys(
        authority,
        &[
            "runtime",
            "authorityRoot",
            "workerEpoch",
            "executorSessionHash",
        ],
    )?;
    require_string(authority, "authorityRoot")?;
    require_string(authority, "workerEpoch")?;
    require_string(authority, "executorSessionHash")?;
    let runtime = require_object(authority, "runtime")?;
    validate_runtime_lease(runtime)?;
    if get_string(authority, "workerEpoch") != get_string(runtime, "workerEpoch")
        || get_string(authority, "executorSessionHash")
            != get_string(runtime, "executorSessionHash")
        || get_string(authority, "authorityRoot") != get_string(runtime, "executorAuthorityRoot")
    {
        return Err("authority binding does not match runtime lease".to_string());
    }
    Ok(())
}

fn validate_runtime_lease(runtime: &Map<String, Value>) -> Result<(), String> {
    const FIELDS: &[&str] = &[
        "runtimeAuthority",
        "executorAuthorityRoot",
        "qualifiedExecutorRegistryRoot",
        "selectedExecutorLeafHash",
        "executorKind",
        "engineBuildFingerprint",
        "executableFingerprint",
        "closureFingerprint",
        "protocolFingerprint",
        "schemaFingerprint",
        "workerEpoch",
        "executorSessionHash",
    ];
    exact_keys(runtime, FIELDS)?;
    let runtime_authority = require_object(runtime, "runtimeAuthority")?;
    exact_keys(
        runtime_authority,
        &["authorityBindingHash", "implementationCommit"],
    )?;
    for key in ["authorityBindingHash", "implementationCommit"] {
        require_string(runtime_authority, key)?;
    }
    for key in FIELDS
        .iter()
        .copied()
        .filter(|key| *key != "runtimeAuthority")
    {
        require_string(runtime, key)?;
    }
    for key in [
        "executorAuthorityRoot",
        "qualifiedExecutorRegistryRoot",
        "selectedExecutorLeafHash",
        "engineBuildFingerprint",
        "executableFingerprint",
        "closureFingerprint",
        "protocolFingerprint",
        "schemaFingerprint",
        "executorSessionHash",
    ] {
        require_hash(runtime, key)?;
    }
    require_hash(runtime_authority, "authorityBindingHash")?;
    let commit = get_string(runtime_authority, "implementationCommit").unwrap_or_default();
    if commit.len() != 40
        || !commit
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(
            "runtimeAuthority.implementationCommit must be 40 lowercase hexadecimal characters"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_effect_transport(value: &Value) -> Result<(), String> {
    let declaration = value
        .as_object()
        .ok_or_else(|| "effectTransport must be an object".to_string())?;
    exact_keys(
        declaration,
        &["caller", "preCalls", "observeTokenBalances", "observeLogs"],
    )?;
    if !declaration
        .get("observeLogs")
        .is_some_and(Value::is_boolean)
    {
        return Err("effectTransport.observeLogs must be boolean".to_string());
    }
    let caller = require_object(declaration, "caller")?;
    validate_effect_caller(caller, "effectTransport.caller")?;
    let pre_calls = require_array(declaration, "preCalls")?;
    for (index, value) in pre_calls.iter().enumerate() {
        let call = value
            .as_object()
            .ok_or_else(|| format!("effectTransport.preCalls[{index}] must be an object"))?;
        exact_keys(call, &["caller", "to", "data"])?;
        validate_effect_caller(
            require_object(call, "caller")?,
            &format!("effectTransport.preCalls[{index}].caller"),
        )?;
        require_address(call, "to")?;
        require_hex_bytes(call, "data")?;
    }
    let observations = require_array(declaration, "observeTokenBalances")?;
    let mut seen = BTreeSet::new();
    for (index, value) in observations.iter().enumerate() {
        let pair = value.as_object().ok_or_else(|| {
            format!("effectTransport.observeTokenBalances[{index}] must be an object")
        })?;
        exact_keys(pair, &["token", "account"])?;
        let token = require_address(pair, "token")?;
        let account = pair.get("account").ok_or_else(|| {
            format!("effectTransport.observeTokenBalances[{index}].account is required")
        })?;
        let account_key = if let Some(account) = account.as_str() {
            validate_address(
                account,
                &format!("effectTransport.observeTokenBalances[{index}].account"),
            )?;
            account.to_string()
        } else {
            validate_observed_sender(
                account,
                &format!("effectTransport.observeTokenBalances[{index}].account"),
            )?;
            "observed-sender".to_string()
        };
        if !seen.insert(format!("{token}\u{0}{account_key}")) {
            return Err(
                "effectTransport.observeTokenBalances contains duplicate token/account pair"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn validate_effect_caller(value: &Map<String, Value>, path: &str) -> Result<(), String> {
    exact_keys(value, &["ref", "executionMode"])?;
    let mode = require_string(value, "executionMode")?;
    if mode != "top-level" && mode != "impersonated-call-frame" {
        return Err(format!("{path}.executionMode is unsupported"));
    }
    let reference = value
        .get("ref")
        .ok_or_else(|| format!("{path}.ref is required"))?;
    if let Some(address) = reference.as_str() {
        validate_address(address, &format!("{path}.ref"))?;
    } else {
        validate_observed_sender(reference, &format!("{path}.ref"))?;
    }
    Ok(())
}

fn validate_observed_sender(value: &Value, path: &str) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{path} must be an address or observed-sender ref"))?;
    exact_keys(object, &["kind"])?;
    if get_string(object, "kind") != Some("observed-sender") {
        return Err(format!("{path}.kind is unsupported"));
    }
    Ok(())
}

fn require_address<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    let value = require_string(object, key)?;
    validate_address(value, key)?;
    Ok(value)
}

fn validate_address(value: &str, path: &str) -> Result<(), String> {
    if value.len() != 42
        || !value.starts_with("0x")
        || !value[2..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(format!("{path} must be a lowercase 20-byte address"));
    }
    Ok(())
}

fn require_hex_bytes<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    let value = require_string(object, key)?;
    if !value.starts_with("0x")
        || value.len() % 2 != 0
        || !value[2..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(format!("{key} must be lowercase even-length hex bytes"));
    }
    Ok(value)
}

fn require_hash<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    let value = require_string(object, key)?;
    if value.len() != 66
        || !value.starts_with("0x")
        || !value[2..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(format!("{key} must be a lowercase 32-byte hash"));
    }
    Ok(value)
}

fn exact_keys(object: &Map<String, Value>, expected: &[&str]) -> Result<(), String> {
    let expected: BTreeSet<&str> = expected.iter().copied().collect();
    let actual: BTreeSet<&str> = object.keys().map(String::as_str).collect();
    if actual != expected {
        let unknown: Vec<&str> = actual.difference(&expected).copied().collect();
        let missing: Vec<&str> = expected.difference(&actual).copied().collect();
        if !unknown.is_empty() {
            return Err(format!("unknown field {}", unknown.join(",")));
        }
        return Err(format!("missing field {}", missing.join(",")));
    }
    Ok(())
}

fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn get_string<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn require_string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    let value =
        get_string(object, key).ok_or_else(|| format!("{key} must be a non-empty string"))?;
    if value.is_empty() {
        return Err(format!("{key} must be a non-empty string"));
    }
    Ok(value)
}

fn require_object<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a Map<String, Value>, String> {
    object
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{key} must be an object"))
}

fn require_array<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a Vec<Value>, String> {
    object
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{key} must be an array"))
}

fn require_number(object: &Map<String, Value>, key: &str) -> Result<f64, String> {
    let value = object
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("{key} must be finite"))?;
    if !value.is_finite() {
        return Err(format!("{key} must be finite"));
    }
    Ok(value)
}

fn get_u64(object: &Map<String, Value>, key: &str) -> Option<u64> {
    object.get(key).and_then(Value::as_u64)
}

fn error_response(request: &Request, code: &str, message: String) -> Value {
    let o = &request.raw;
    json!({
        "wireVersion": WIRE_VERSION,
        "kind": "error",
        "op": "simulate",
        "requestId": o.get("requestId").cloned().unwrap_or(Value::String("invalid-request".to_string())),
        "workerEpoch": o.get("workerEpoch").cloned().unwrap_or(Value::String("invalid-request".to_string())),
        "ownerRef": o.get("ownerRef").cloned().unwrap_or(Value::String("invalid-request".to_string())),
        "generationId": o.get("generationId").cloned().unwrap_or(Value::String("invalid-request".to_string())),
        "attemptId": o.get("attemptId").cloned().unwrap_or(Value::String("invalid-request".to_string())),
        "authority": o.get("authority").cloned().unwrap_or(json!({
            "runtime": {}, "authorityRoot": "invalid-request", "workerEpoch": "invalid-request", "executorSessionHash": "invalid-request"
        })),
        "inputHash": o.get("inputHash").cloned().unwrap_or(Value::String("invalid-request".to_string())),
        "deadlineAtMs": o.get("deadlineAtMs").cloned().unwrap_or_else(|| Value::Number(Number::from(0))),
        "code": code,
        "message": message,
    })
}

fn simulate(request: &Request, options: &Options) -> Result<Value, WorkerError> {
    let o = &request.raw;
    let authority = o
        .get("authority")
        .cloned()
        .ok_or_else(|| WorkerError::new("authority missing"))?;
    let source = o
        .get("source")
        .cloned()
        .ok_or_else(|| WorkerError::new("source missing"))?;
    let caller = o
        .get("caller")
        .cloned()
        .ok_or_else(|| WorkerError::new("caller missing"))?;
    let observe_accounts = o
        .get("observeAccounts")
        .cloned()
        .ok_or_else(|| WorkerError::new("observeAccounts missing"))?;
    let program = o
        .get("program")
        .and_then(Value::as_object)
        .ok_or_else(|| WorkerError::new("program missing"))?;
    let input = o
        .get("input")
        .ok_or_else(|| WorkerError::new("input missing"))?;

    let caller_object = caller
        .as_object()
        .ok_or_else(|| WorkerError::new("caller must be an object"))?;
    let caller_address =
        parse_address(require_string(caller_object, "address").map_err(WorkerError::new)?)?;
    let caller_mode = require_string(caller_object, "mode").map_err(WorkerError::new)?;
    let target = input_target(input, caller_address)?;
    let calldata = input_bytes(input, &["data", "calldata"])?;
    let gas_limit =
        input_u64(input, &["gasLimit", "gas_limit", "gas"])?.unwrap_or(DEFAULT_GAS_LIMIT);
    let tx_value = input_u256(input, &["value"])?.unwrap_or(U256::ZERO);
    let source_chain_id = source
        .as_object()
        .and_then(|value| value.get("chainId"))
        .and_then(Value::as_str)
        .map(parse_u64)
        .transpose()?
        .unwrap_or(1);
    let chain_id = input_u64(input, &["chainId", "chain_id"])?.unwrap_or(source_chain_id);
    let mut db = CacheDB::new(EmptyDB::default());

    load_input_state(&mut db, input)?;
    // REVM performs this check during transaction pre-execution, but the
    // worker may have owner-declared observation calls before the main call.
    // Rejecting a top-level deployed-code caller immediately preserves the
    // EIP-3607 boundary and prevents those calls from consuming the entire
    // request deadline before the caller error is emitted.  Keep the exact
    // REVM EIP-7702 delegation exception in sync with its handler.
    reject_top_level_caller_code(&mut db, caller_address, caller_mode)?;
    // A frozen program is executable bytecode when the input does not provide
    // code for its target.  If input state already supplies target code, the
    // frozen bytes remain the content-addressed program identity but do not
    // overwrite the caller's explicit chain state.
    let target_has_code = db
        .basic(target)
        .map_err(|error| WorkerError::new(format!("state read: {error:?}")))?
        .and_then(|info| info.code)
        .is_some_and(|code| !code.is_empty());
    if !target_has_code {
        let bytes = parse_hex(require_string(program, "bytes").map_err(WorkerError::new)?)?;
        let mut info = db
            .basic(target)
            .map_err(|error| WorkerError::new(format!("state read: {error:?}")))?
            .unwrap_or_default();
        info.code = Some(
            Bytecode::new_raw_checked(Bytes::from(bytes))
                .map_err(|error| WorkerError::new(format!("target bytecode: {error:?}")))?,
        );
        db.insert_account_info(target, info);
    }

    let block = block_env(o.get("source").and_then(Value::as_object), input)?;
    let before = snapshots(&mut db, &observe_accounts)?;
    let effect_transport = program.get("effectTransport").cloned();
    let token_before = match effect_transport.as_ref() {
        Some(declaration) => token_snapshots(
            &mut db,
            declaration,
            caller_address,
            caller_object,
            &block,
            source_chain_id,
            chain_id,
            gas_limit,
        )?,
        None => Value::Null,
    };
    let mut pre_call_results = Vec::new();
    let mut pre_calls_success = true;
    let mut pre_call_gas = 0u64;
    if let Some(declaration) = effect_transport.as_ref() {
        let pre_calls = declaration
            .as_object()
            .and_then(|value| value.get("preCalls"))
            .and_then(Value::as_array)
            .ok_or_else(|| WorkerError::new("effectTransport.preCalls missing"))?;
        for (index, call) in pre_calls.iter().enumerate() {
            let call_object = call.as_object().ok_or_else(|| {
                WorkerError::new(format!(
                    "effectTransport.preCalls[{index}] is not an object"
                ))
            })?;
            let call_caller = require_object(call_object, "caller").map_err(WorkerError::new)?;
            let call_address = resolve_effect_account(
                call_caller.get("ref").ok_or_else(|| {
                    WorkerError::new(format!(
                        "effectTransport.preCalls[{index}].caller.ref missing"
                    ))
                })?,
                caller_object,
            )?;
            let call_mode =
                require_string(call_caller, "executionMode").map_err(WorkerError::new)?;
            let call_target =
                parse_address(require_address(call_object, "to").map_err(WorkerError::new)?)?;
            let call_data =
                parse_hex(require_hex_bytes(call_object, "data").map_err(WorkerError::new)?)?;
            let outcome = transact_call(
                &mut db,
                &block,
                source_chain_id,
                chain_id,
                call_address,
                call_target,
                call_data,
                gas_limit,
                U256::ZERO,
                call_mode,
            )?;
            pre_call_gas = pre_call_gas.saturating_add(outcome.gas_used);
            pre_calls_success &= outcome.success;
            pre_call_results.push(json!({
                "index": index,
                "to": call_object.get("to").cloned().unwrap_or(Value::Null),
                "status": if outcome.success { "returned" } else { "reverted" },
                "output": outcome.output,
                "gasUsed": outcome.gas_used.to_string(),
            }));
            if !pre_calls_success {
                break;
            }
        }
    }
    let main_outcome = if pre_calls_success {
        transact_call(
            &mut db,
            &block,
            source_chain_id,
            chain_id,
            caller_address,
            target,
            calldata,
            gas_limit,
            tx_value,
            caller_mode,
        )?
    } else {
        CallOutcome {
            success: false,
            output: "0x".to_string(),
            gas_used: 0,
        }
    };
    let success = main_outcome.success;
    let output = main_outcome.output;
    let gas_used = pre_call_gas.saturating_add(main_outcome.gas_used);
    let after = snapshots(&mut db, &observe_accounts)?;
    let token_after = match effect_transport.as_ref() {
        Some(declaration) => token_snapshots(
            &mut db,
            declaration,
            caller_address,
            caller_object,
            &block,
            source_chain_id,
            chain_id,
            gas_limit,
        )?,
        None => Value::Null,
    };
    let status = if success { "returned" } else { "reverted" };
    let mut effects_value = json!({
        "accounts": after,
        "before": before,
        "gasUsed": gas_used.to_string(),
        "output": output,
        "status": status,
    });
    if effect_transport.is_some() {
        let effects_object = effects_value
            .as_object_mut()
            .expect("effects payload is an object");
        effects_object.insert("preCalls".to_string(), Value::Array(pre_call_results));
        effects_object.insert("tokenBalancesBefore".to_string(), token_before);
        effects_object.insert("tokenBalancesAfter".to_string(), token_after);
    }
    let effects_bytes = canonical_json(&effects_value)?;
    let observed = observe_accounts;
    let effects_hash = hash_domain(
        "aloha/revm-effects-wire/v1",
        &json!({
            "format": "revm-effects-v1",
            "bytes": effects_bytes,
            "observedAccounts": observed,
        }),
    )?;
    let effects = json!({
        "format": "revm-effects-v1",
        "bytes": effects_bytes,
        "observedAccounts": observed,
        "effectsHash": effects_hash,
    });
    let mut response = json!({
        "wireVersion": WIRE_VERSION,
        "kind": "response",
        "op": "simulate",
        "requestId": o["requestId"].clone(),
        "workerEpoch": o["workerEpoch"].clone(),
        "ownerRef": o["ownerRef"].clone(),
        "generationId": o["generationId"].clone(),
        "attemptId": o["attemptId"].clone(),
        "authority": authority,
        "inputHash": o["inputHash"].clone(),
        "deadlineAtMs": o["deadlineAtMs"].clone(),
        "engine": ENGINE,
        "engineBuildFingerprint": options.engine_build_fingerprint,
        "source": source,
        "caller": caller,
        "observeAccounts": observed,
        "programHash": program["programHash"].clone(),
        "status": status,
        "output": output,
        "effects": effects,
        "executionReceiptHash": "",
    });
    if let Some(effect_transport) = program.get("effectTransport") {
        response["effectTransport"] = effect_transport.clone();
    }
    let receipt_hash = execution_receipt_hash(&response)?;
    response["executionReceiptHash"] = Value::String(receipt_hash);
    Ok(response)
}

fn reject_top_level_caller_code(
    db: &mut CacheDB<EmptyDB>,
    caller: Address,
    mode: &str,
) -> Result<(), WorkerError> {
    if mode != "top-level" {
        return Ok(());
    }
    let Some(info) = db
        .basic(caller)
        .map_err(|error| WorkerError::new(format!("caller state read: {error:?}")))?
    else {
        return Ok(());
    };
    let Some(code) = info.code else {
        return Ok(());
    };
    if !code.is_empty() && !code.is_eip7702() {
        return Err(WorkerError::new(
            "EIP-3607 rejects top-level caller with deployed code",
        ));
    }
    Ok(())
}

struct CallOutcome {
    success: bool,
    output: String,
    gas_used: u64,
}

fn transact_call(
    db: &mut CacheDB<EmptyDB>,
    block: &BlockEnv,
    source_chain_id: u64,
    chain_id: u64,
    caller: Address,
    target: Address,
    calldata: Vec<u8>,
    gas_limit: u64,
    value: U256,
    mode: &str,
) -> Result<CallOutcome, WorkerError> {
    if mode != "top-level" && mode != "impersonated-call-frame" {
        return Err(WorkerError::new(
            "effect call execution mode is unsupported",
        ));
    }
    let tx = build_tx(caller, target, calldata, gas_limit, value, chain_id);
    let context = Context::mainnet()
        .modify_cfg_chained(|cfg| {
            cfg.set_spec_and_mainnet_gas_params(SpecId::PRAGUE);
            cfg.disable_nonce_check = true;
            cfg.tx_chain_id_check = false;
            cfg.chain_id = source_chain_id;
            // EIP-3607 relaxation is scoped to this individual call frame.
            cfg.disable_eip3607 = mode == "impersonated-call-frame";
        })
        .with_block(block.clone())
        .with_db(&mut *db);
    let mut evm = context.build_mainnet();
    let result = evm
        .transact(tx)
        .map_err(|error| WorkerError::new(format!("revm transact failed: {error:?}")))?;
    let success = result.result.is_success();
    let output = result
        .result
        .output()
        .map(|bytes| format!("0x{}", hex::encode(bytes.as_ref())))
        .unwrap_or_else(|| "0x".to_string());
    let gas_used = result.result.tx_gas_used();
    db.commit(result.state);
    Ok(CallOutcome {
        success,
        output,
        gas_used,
    })
}

fn resolve_effect_account(
    value: &Value,
    caller: &Map<String, Value>,
) -> Result<Address, WorkerError> {
    if let Some(address) = value.as_str() {
        return parse_address(address);
    }
    validate_observed_sender(value, "effect account").map_err(WorkerError::new)?;
    parse_address(require_string(caller, "observedSender").map_err(WorkerError::new)?)
}

fn token_snapshots(
    db: &mut CacheDB<EmptyDB>,
    declaration: &Value,
    caller: Address,
    caller_object: &Map<String, Value>,
    block: &BlockEnv,
    source_chain_id: u64,
    chain_id: u64,
    gas_limit: u64,
) -> Result<Value, WorkerError> {
    let declaration = declaration
        .as_object()
        .ok_or_else(|| WorkerError::new("effectTransport must be an object"))?;
    let observations = declaration
        .get("observeTokenBalances")
        .and_then(Value::as_array)
        .ok_or_else(|| WorkerError::new("effectTransport.observeTokenBalances missing"))?;
    let caller_mode = declaration
        .get("caller")
        .and_then(Value::as_object)
        .and_then(|value| value.get("executionMode"))
        .and_then(Value::as_str)
        .ok_or_else(|| WorkerError::new("effectTransport.caller.executionMode missing"))?;
    let mut result = Vec::with_capacity(observations.len());
    for (index, value) in observations.iter().enumerate() {
        let pair = value.as_object().ok_or_else(|| {
            WorkerError::new(format!(
                "effectTransport.observeTokenBalances[{index}] is not an object"
            ))
        })?;
        let token = parse_address(require_address(pair, "token").map_err(WorkerError::new)?)?;
        let account_value = pair.get("account").ok_or_else(|| {
            WorkerError::new(format!(
                "effectTransport.observeTokenBalances[{index}].account missing"
            ))
        })?;
        let account = resolve_effect_account(account_value, caller_object)?;
        let mut calldata = Vec::with_capacity(36);
        calldata.extend_from_slice(&[0x70, 0xa0, 0x82, 0x31]);
        calldata.extend_from_slice(&[0u8; 12]);
        calldata.extend_from_slice(account.as_slice());
        let outcome = transact_call(
            db,
            block,
            source_chain_id,
            chain_id,
            caller,
            token,
            calldata,
            gas_limit,
            U256::ZERO,
            caller_mode,
        )?;
        if !outcome.success {
            return Err(WorkerError::new(format!(
                "token balance observation {index} reverted"
            )));
        }
        let bytes = parse_hex(&outcome.output)?;
        if bytes.len() < 32 {
            return Err(WorkerError::new(format!(
                "token balance observation {index} returned less than 32 bytes"
            )));
        }
        let balance = parse_u256(&format!("0x{}", hex::encode(&bytes[bytes.len() - 32..])))?;
        let account_ref = account_value.clone();
        result.push(json!({
            "token": format!("{token:#x}"),
            "account": account_ref,
            "balance": balance.to_string(),
        }));
    }
    Ok(Value::Array(result))
}

fn execution_receipt_hash(response: &Value) -> Result<String, WorkerError> {
    let o = response
        .as_object()
        .ok_or_else(|| WorkerError::new("response is not an object"))?;
    let payload = json!({
        "requestId": o["requestId"].clone(),
        "workerEpoch": o["workerEpoch"].clone(),
        "ownerRef": o["ownerRef"].clone(),
        "generationId": o["generationId"].clone(),
        "attemptId": o["attemptId"].clone(),
        "authority": o["authority"].clone(),
        "inputHash": o["inputHash"].clone(),
        "deadlineAtMs": o["deadlineAtMs"].clone(),
        "source": o["source"].clone(),
        "caller": o["caller"].clone(),
        "observeAccounts": o["observeAccounts"].clone(),
        "programHash": o["programHash"].clone(),
        "status": o["status"].clone(),
        "output": o["output"].clone(),
        "effects": o["effects"].clone(),
    });
    let mut payload = payload;
    if let Some(effect_transport) = o.get("effectTransport") {
        payload
            .as_object_mut()
            .expect("receipt payload is an object")
            .insert("effectTransport".to_string(), effect_transport.clone());
    }
    hash_domain("aloha/revm-execution-receipt/v1", &payload)
}

fn build_tx(
    caller: Address,
    target: Address,
    data: Vec<u8>,
    gas_limit: u64,
    value: U256,
    chain_id: u64,
) -> TxEnv {
    let mut tx = TxEnv::builder()
        .caller(caller)
        .to(target)
        .gas_limit(gas_limit)
        .gas_price(0u128)
        .gas_priority_fee(Some(0u128))
        .value(value)
        .data(Bytes::from(data))
        .chain_id(Some(chain_id))
        .build_fill();
    tx.nonce = 0;
    tx
}

fn block_env(source: Option<&Map<String, Value>>, input: &Value) -> Result<BlockEnv, WorkerError> {
    let number = source
        .and_then(|value| value.get("number"))
        .map(parse_u64_value)
        .transpose()?
        .unwrap_or(0);
    let block = input
        .as_object()
        .and_then(|object| object.get("block"))
        .and_then(Value::as_object);
    let mut env = BlockEnv {
        number: U256::from(number),
        timestamp: block
            .and_then(|value| value.get("timestamp"))
            .map(parse_u64_value)
            .transpose()?
            .map(U256::from)
            .unwrap_or(U256::ZERO),
        gas_limit: block
            .and_then(|value| value.get("gasLimit").or_else(|| value.get("gas_limit")))
            .map(parse_u64_value)
            .transpose()?
            .unwrap_or(30_000_000),
        basefee: block
            .and_then(|value| value.get("baseFeePerGas").or_else(|| value.get("basefee")))
            .map(parse_u64_value)
            .transpose()?
            .unwrap_or(0),
        ..BlockEnv::default()
    };
    if let Some(value) = block
        .and_then(|object| object.get("beneficiary").or_else(|| object.get("coinbase")))
        .and_then(Value::as_str)
    {
        env.beneficiary = parse_address(value)?;
    }
    if let Some(value) = block
        .and_then(|object| object.get("prevrandao").or_else(|| object.get("mixHash")))
        .and_then(Value::as_str)
    {
        let bytes = parse_hex(value)?;
        if bytes.len() != 32 {
            return Err(WorkerError::new("block prevrandao must be 32 bytes"));
        }
        env.prevrandao = Some(revm::primitives::B256::from_slice(&bytes));
    }
    Ok(env)
}

fn input_target(input: &Value, caller: Address) -> Result<Address, WorkerError> {
    let Some(object) = input.as_object() else {
        return Ok(caller);
    };
    for key in ["to", "target", "contract", "executor"] {
        if let Some(value) = object.get(key) {
            return parse_address(
                value
                    .as_str()
                    .ok_or_else(|| WorkerError::new(format!("input.{key} must be an address")))?,
            );
        }
    }
    Ok(caller)
}

fn input_bytes(input: &Value, keys: &[&str]) -> Result<Vec<u8>, WorkerError> {
    let Some(object) = input.as_object() else {
        return Ok(Vec::new());
    };
    for key in keys {
        if let Some(value) = object.get(*key) {
            return parse_hex(
                value
                    .as_str()
                    .ok_or_else(|| WorkerError::new(format!("input.{key} must be hex")))?,
            );
        }
    }
    Ok(Vec::new())
}

fn input_u64(input: &Value, keys: &[&str]) -> Result<Option<u64>, WorkerError> {
    let Some(object) = input.as_object() else {
        return Ok(None);
    };
    for key in keys {
        if let Some(value) = object.get(*key) {
            return parse_u64_value(value).map(Some);
        }
    }
    Ok(None)
}

fn input_u256(input: &Value, keys: &[&str]) -> Result<Option<U256>, WorkerError> {
    let Some(object) = input.as_object() else {
        return Ok(None);
    };
    for key in keys {
        if let Some(value) = object.get(*key) {
            return parse_u256_value(value).map(Some);
        }
    }
    Ok(None)
}

fn load_input_state(db: &mut CacheDB<EmptyDB>, input: &Value) -> Result<(), WorkerError> {
    let Some(object) = input.as_object() else {
        return Ok(());
    };
    for key in ["accounts", "state", "stateOverrides"] {
        let Some(value) = object.get(key) else {
            continue;
        };
        if key == "state" {
            if let Some(state_object) = value.as_object() {
                let mut recognized = false;
                if let Some(accounts) = state_object.get("accounts") {
                    load_accounts(db, accounts)?;
                    recognized = true;
                }
                if let Some(storage) = state_object.get("storage") {
                    load_storage_map(db, storage)?;
                    recognized = true;
                }
                if !recognized {
                    load_accounts(db, value)?;
                }
            } else {
                load_accounts(db, value)?;
            }
        } else if key == "stateOverrides" && value.is_array() {
            load_accounts_array(db, value)?;
        } else {
            load_accounts(db, value)?;
        }
    }
    Ok(())
}

fn load_accounts(db: &mut CacheDB<EmptyDB>, value: &Value) -> Result<(), WorkerError> {
    if let Some(array) = value.as_array() {
        return load_accounts_array(db, &Value::Array(array.clone()));
    }
    let object = value
        .as_object()
        .ok_or_else(|| WorkerError::new("input accounts must be an object or array"))?;
    for (address, account) in object {
        load_account(db, address, account)?;
    }
    Ok(())
}

fn load_accounts_array(db: &mut CacheDB<EmptyDB>, value: &Value) -> Result<(), WorkerError> {
    for account in value
        .as_array()
        .ok_or_else(|| WorkerError::new("input account list must be an array"))?
    {
        let object = account
            .as_object()
            .ok_or_else(|| WorkerError::new("input account must be an object"))?;
        let address = object
            .get("address")
            .and_then(Value::as_str)
            .ok_or_else(|| WorkerError::new("input account.address is required"))?;
        load_account(db, address, account)?;
    }
    Ok(())
}

fn load_account(
    db: &mut CacheDB<EmptyDB>,
    raw_address: &str,
    value: &Value,
) -> Result<(), WorkerError> {
    let address = parse_address(raw_address)?;
    let object = value
        .as_object()
        .ok_or_else(|| WorkerError::new("input account must be an object"))?;
    let mut info = db
        .basic(address)
        .map_err(|error| WorkerError::new(format!("state read: {error:?}")))?
        .unwrap_or_default();
    if let Some(balance) = object.get("balance") {
        info.balance = parse_u256_value(balance)?;
    }
    if let Some(nonce) = object.get("nonce") {
        info.nonce = parse_u64_value(nonce)?;
    }
    if let Some(code) = object.get("code") {
        let bytes = parse_hex(
            code.as_str()
                .ok_or_else(|| WorkerError::new("account.code must be hex"))?,
        )?;
        info.code = if bytes.is_empty() {
            None
        } else {
            Some(
                Bytecode::new_raw_checked(Bytes::from(bytes))
                    .map_err(|error| WorkerError::new(format!("account bytecode: {error:?}")))?,
            )
        };
    }
    db.insert_account_info(address, info);
    for key in ["storage", "state", "stateDiff"] {
        if let Some(storage) = object.get(key) {
            load_storage_for_account(db, address, storage)?;
        }
    }
    Ok(())
}

fn load_storage_map(db: &mut CacheDB<EmptyDB>, value: &Value) -> Result<(), WorkerError> {
    let object = value
        .as_object()
        .ok_or_else(|| WorkerError::new("input state.storage must be an object"))?;
    for (address, slots) in object {
        let address = parse_address(address)?;
        load_storage_for_account(db, address, slots)?;
    }
    Ok(())
}

fn load_storage_for_account(
    db: &mut CacheDB<EmptyDB>,
    address: Address,
    value: &Value,
) -> Result<(), WorkerError> {
    let object = value
        .as_object()
        .ok_or_else(|| WorkerError::new("account.storage must be an object"))?;
    for (slot, stored) in object {
        db.insert_account_storage(address, parse_u256(slot)?, parse_u256_value(stored)?)
            .map_err(|error| WorkerError::new(format!("state storage: {error:?}")))?;
    }
    Ok(())
}

fn snapshots(db: &mut CacheDB<EmptyDB>, accounts: &Value) -> Result<Value, WorkerError> {
    let array = accounts
        .as_array()
        .ok_or_else(|| WorkerError::new("observeAccounts must be an array"))?;
    let mut output = Vec::with_capacity(array.len());
    for account in array {
        let raw = account
            .as_str()
            .ok_or_else(|| WorkerError::new("observeAccounts entries must be strings"))?;
        let address = parse_address(raw)?;
        let info = db
            .basic(address)
            .map_err(|error| WorkerError::new(format!("observation read: {error:?}")))?;
        output.push(json!({
            "account": raw,
            "balance": info.as_ref().map(|value| value.balance.to_string()).unwrap_or_else(|| "0".to_string()),
            "nonce": info.as_ref().map(|value| value.nonce.to_string()).unwrap_or_else(|| "0".to_string()),
            "codeHash": info.as_ref().map(|value| format!("{:#x}", value.code_hash)).unwrap_or_else(|| "0x0".to_string()),
        }));
    }
    Ok(Value::Array(output))
}

fn parse_address(value: &str) -> Result<Address, WorkerError> {
    let bytes = parse_hex(value)?;
    if bytes.len() != 20 {
        return Err(WorkerError::new(format!(
            "address must be 20 bytes: {value}"
        )));
    }
    Ok(Address::from_slice(&bytes))
}

fn parse_hex(value: &str) -> Result<Vec<u8>, WorkerError> {
    let body = value
        .strip_prefix("0x")
        .ok_or_else(|| WorkerError::new("hex value must use 0x prefix"))?;
    if body.len() % 2 != 0 {
        return Err(WorkerError::new("hex value must have even length"));
    }
    hex::decode(body).map_err(|error| WorkerError::new(format!("invalid hex: {error}")))
}

fn parse_u64_value(value: &Value) -> Result<u64, WorkerError> {
    match value {
        Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| WorkerError::new("number must be an unsigned integer")),
        Value::String(string) => parse_u64(string),
        _ => Err(WorkerError::new("integer must be a number or string")),
    }
}

fn parse_u64(value: &str) -> Result<u64, WorkerError> {
    if let Some(body) = value.strip_prefix("0x") {
        u64::from_str_radix(body, 16).map_err(|_| WorkerError::new("invalid hexadecimal integer"))
    } else {
        value
            .parse::<u64>()
            .map_err(|_| WorkerError::new("invalid decimal integer"))
    }
}

fn parse_u256(value: &str) -> Result<U256, WorkerError> {
    if let Some(body) = value.strip_prefix("0x") {
        U256::from_str_radix(body, 16).map_err(|_| WorkerError::new("invalid hexadecimal U256"))
    } else {
        U256::from_str_radix(value, 10).map_err(|_| WorkerError::new("invalid decimal U256"))
    }
}

fn parse_u256_value(value: &Value) -> Result<U256, WorkerError> {
    match value {
        Value::String(string) => parse_u256(string),
        Value::Number(number) => parse_u256(&number.to_string()),
        _ => Err(WorkerError::new("U256 must be a number or string")),
    }
}

fn hash_domain(domain: &str, payload: &Value) -> Result<String, WorkerError> {
    let encoded = canonical_json(payload)?;
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    hasher.update([0]);
    hasher.update(encoded.as_bytes());
    Ok(format!("0x{}", hex::encode(hasher.finalize())))
}

fn canonical_json(value: &Value) -> Result<String, WorkerError> {
    let encoded = canonical_json_at(value, 0)?;
    if encoded.len() > MAX_CANONICAL_BYTES {
        return Err(WorkerError::new("canonical JSON exceeds byte policy"));
    }
    Ok(encoded)
}

fn canonical_json_at(value: &Value, depth: usize) -> Result<String, WorkerError> {
    if depth > MAX_CANONICAL_DEPTH {
        return Err(WorkerError::new("JSON nesting exceeds policy"));
    }
    match value {
        Value::Null => Ok("null".to_string()),
        Value::Bool(value) => Ok(if *value { "true" } else { "false" }.to_string()),
        Value::Number(value) => canonical_number(value),
        Value::String(value) => {
            if value.encode_utf16().count() > MAX_CANONICAL_STRING_CODE_UNITS {
                return Err(WorkerError::new("JSON string exceeds policy"));
            }
            serde_json::to_string(value)
                .map_err(|error| WorkerError::new(format!("JSON string: {error}")))
        }
        Value::Array(values) => {
            if values.len() > MAX_CANONICAL_ARRAY_ITEMS {
                return Err(WorkerError::new("array exceeds policy"));
            }
            let mut encoded = String::from("[");
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    encoded.push(',');
                }
                encoded.push_str(&canonical_json_at(value, depth + 1)?);
            }
            encoded.push(']');
            Ok(encoded)
        }
        Value::Object(values) => {
            if values.len() > MAX_CANONICAL_OBJECT_PROPERTIES {
                return Err(WorkerError::new("object exceeds policy"));
            }
            let mut keys: Vec<&String> = values.keys().collect();
            if keys
                .iter()
                .any(|key| key.encode_utf16().count() > MAX_CANONICAL_STRING_CODE_UNITS)
            {
                return Err(WorkerError::new("object key exceeds string policy"));
            }
            // JavaScript's `Object.keys(value).sort()` compares UTF-16 code
            // units.  Rust's default string ordering compares UTF-8 bytes,
            // which differs for non-BMP keys and would change wire hashes.
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            let mut encoded = String::from("{");
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    encoded.push(',');
                }
                encoded.push_str(
                    &serde_json::to_string(*key)
                        .map_err(|error| WorkerError::new(format!("JSON key: {error}")))?,
                );
                encoded.push(':');
                encoded.push_str(&canonical_json_at(&values[*key], depth + 1)?);
            }
            encoded.push('}');
            Ok(encoded)
        }
    }
}

fn canonical_number(value: &Number) -> Result<String, WorkerError> {
    // JSON.parse produces an IEEE-754 number and the TypeScript codec then
    // uses JSON.stringify. Generic Ryu may choose a different shortest
    // round-trip decimal than ECMAScript for the same f64; ryu-js implements
    // the ECMAScript choice and exponent thresholds exactly.
    let number = value
        .as_f64()
        .ok_or_else(|| WorkerError::new("invalid JSON number"))?;
    if !number.is_finite()
        || (number == 0.0 && number.is_sign_negative())
        || number.abs() > 9_007_199_254_740_991.0
    {
        return Err(WorkerError::new("invalid JSON number"));
    }
    let mut buffer = ryu_js::Buffer::new();
    let encoded = buffer.format(number).to_string();
    if encoded.bytes().filter(u8::is_ascii_digit).count() > MAX_CANONICAL_DECIMAL_DIGITS {
        return Err(WorkerError::new("decimal representation exceeds policy"));
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_lease() -> Value {
        let hash = format!("0x{}", "11".repeat(32));
        json!({
            "runtimeAuthority": {
                "authorityBindingHash": hash,
                "implementationCommit": "0123456789abcdef0123456789abcdef01234567",
            },
            "executorAuthorityRoot": hash,
            "qualifiedExecutorRegistryRoot": hash,
            "selectedExecutorLeafHash": hash,
            "executorKind": "revm",
            "engineBuildFingerprint": hash,
            "executableFingerprint": hash,
            "closureFingerprint": hash,
            "protocolFingerprint": hash,
            "schemaFingerprint": hash,
            "workerEpoch": "epoch-1",
            "executorSessionHash": hash,
        })
    }

    #[test]
    fn runtime_authority_projection_has_exact_neutral_keys() {
        let valid = runtime_lease();
        assert!(validate_runtime_lease(valid.as_object().unwrap()).is_ok());

        let mut tagged = valid.clone();
        tagged["runtimeAuthority"]["authorityClass"] = json!("dry-run");
        assert!(validate_runtime_lease(tagged.as_object().unwrap()).is_err());

        let mut release_bound = valid;
        release_bound["releaseProvenanceHash"] = json!(format!("0x{}", "22".repeat(32)));
        assert!(validate_runtime_lease(release_bound.as_object().unwrap()).is_err());
    }

    #[test]
    fn canonical_objects_sort_keys() {
        let value: Value =
            serde_json::from_str(r#"{"z":1,"a":[true,{"b":"x","a":null}]}"#).unwrap();
        assert_eq!(
            canonical_json(&value).unwrap(),
            r#"{"a":[true,{"a":null,"b":"x"}],"z":1}"#
        );
    }

    #[test]
    fn hash_domain_uses_nul_separator() {
        assert_eq!(
            hash_domain("test", &json!("value")).unwrap(),
            "0xc3721c76c2f1603a771b07e2c42e83433b5102a468ccc69381a8a660fc91dac8"
        );
    }

    #[test]
    fn canonical_numbers_follow_json_stringify_boundaries() {
        let cases = [
            ("1.0", "1"),
            ("1e3", "1000"),
            ("1e-3", "0.001"),
            ("1e-6", "0.000001"),
            ("1e-7", "1e-7"),
            ("1e15", "1000000000000000"),
            ("10592.671624999999", "10592.671624999999"),
        ];
        for (raw, expected) in cases {
            let value: Value = serde_json::from_str(raw).unwrap();
            assert_eq!(canonical_json(&value).unwrap(), expected, "{raw}");
        }
        let negative_zero: Value = serde_json::from_str("-0").unwrap();
        assert!(canonical_json(&negative_zero).is_err());
        assert_eq!(
            hash_domain("aloha/revm-program-input/v1", &json!({"value": 0.000001})).unwrap(),
            "0x461de9d0afa37b7860a929b38b4e0263a8d6c5a073125d3afb26a75dd91e03b4"
        );
    }

    #[test]
    fn canonical_object_order_matches_javascript_utf16_sort() {
        let value: Value = serde_json::from_str(r#"{"\ue000":2,"\ud800\udc00":1}"#).unwrap();
        assert_eq!(
            canonical_json(&value).unwrap(),
            format!("{{\"𐀀\":1,\"{}\":2}}", '\u{e000}')
        );
    }

    #[test]
    fn effect_transport_is_exact_and_rejects_duplicate_observations() {
        let valid = json!({
            "caller": { "ref": { "kind": "observed-sender" }, "executionMode": "impersonated-call-frame" },
            "preCalls": [{ "caller": { "ref": { "kind": "observed-sender" }, "executionMode": "impersonated-call-frame" }, "to": "0x1111111111111111111111111111111111111111", "data": "0x095ea7b3" }],
            "observeTokenBalances": [{ "token": "0x1111111111111111111111111111111111111111", "account": { "kind": "observed-sender" } }],
            "observeLogs": true,
        });
        assert!(validate_effect_transport(&valid).is_ok());
        let mut duplicate = valid.clone();
        duplicate["observeTokenBalances"] = json!([
            { "token": "0x1111111111111111111111111111111111111111", "account": { "kind": "observed-sender" } },
            { "token": "0x1111111111111111111111111111111111111111", "account": { "kind": "observed-sender" } },
        ]);
        assert!(validate_effect_transport(&duplicate).is_err());
        let mut extra = valid.clone();
        extra["unexpected"] = Value::Bool(true);
        assert!(validate_effect_transport(&extra).is_err());
    }

    #[test]
    fn top_level_eip3607_preflight_rejects_code_and_preserves_impersonation_exception() {
        let caller = Address::from([0x11; 20]);
        let mut db = CacheDB::new(EmptyDB::default());
        let mut info = db.basic(caller).unwrap().unwrap_or_default();
        info.code = Some(Bytecode::new_raw(Bytes::from(vec![0x60, 0x00])));
        db.insert_account_info(caller, info);

        assert!(reject_top_level_caller_code(&mut db, caller, "top-level").is_err());
        assert!(reject_top_level_caller_code(&mut db, caller, "impersonated-call-frame").is_ok());

        let mut delegation = vec![0xef, 0x01, 0x00];
        delegation.extend_from_slice(&[0x22; 20]);
        let mut delegated_info = db.basic(caller).unwrap().unwrap_or_default();
        delegated_info.code = Some(Bytecode::new_raw_checked(Bytes::from(delegation)).unwrap());
        db.insert_account_info(caller, delegated_info);
        assert!(reject_top_level_caller_code(&mut db, caller, "top-level").is_ok());
    }
}
