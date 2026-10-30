// Retained CLI name: the retired whole-transaction registrar cannot issue
// single-leg acceptance. Do not load RPC configuration or rewrite old evidence.
import { refuseLegacySettlementRegistrar } from "./settlement-registrar-evidence.js";

refuseLegacySettlementRegistrar();
