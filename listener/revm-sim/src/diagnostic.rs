//! Stderr-only observations. Never echo endpoint, request parameters, response
//! bodies, remote messages, or arbitrary error Display strings.
use std::{collections::BTreeMap, error::Error, io::{self, Write}, time::{SystemTime, UNIX_EPOCH}};
use serde_json::{Value, json};

pub fn emit(stage: &'static str, fields: Value) {
    let record = json!({"schemaVersion":1,"pid":std::process::id(),"stage":stage,
        "timeUnixMs":SystemTime::now().duration_since(UNIX_EPOCH).ok().map(|d|d.as_millis()),
        "details":fields});
    // Broken diagnostics must not change the operation's result or fatal latch.
    let _ = writeln!(std::io::stderr().lock(), "[revm-diagnostic] {record}");
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
