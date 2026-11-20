import {v3LineageReceiptEvidence} from './v3-factory-assets.mjs';
import {v4SiblingReceiptEvidence,v4TransferPairReceiptEvidence,v4WindowPoolKeyEvidence} from './v4-receipt-bindings.mjs';
// Provenance emitted by the supplemental receipt query, not the Family
// registry. This prevents old materialized enrichment from reintroducing
// identities obtained from creation history into a new candidate export.
const origins=['explicit-swap-event','swap-assets-unresolved','swap+amount-matched-transfers',
 'swap+v2-transfer-calldata-create2','swap+v2-receipt-create2','swap+v2-issuance-receipt-create2','swap+v2-lineage-receipt-create2','swap+v3-receipt-create2',
 'swap+receipt-proven-v3-assets','swap+manager-swap-call-poolkey','swap+calldata-poolkey-hash','swap+native-transfer-poolkey-hash','swap+native-input-poolkey-hash','swap+native-packed-poolkey-hash'];
// A restricted proof identifies a compatible ABI; it never establishes which
// function was called. The latter still requires independent call evidence.
const restricted=[v3LineageReceiptEvidence,v4SiblingReceiptEvidence,v4TransferPairReceiptEvidence,v4WindowPoolKeyEvidence];
export function receiptEvidenceSql(column) {
 return column+' IN ('+[...origins,...restricted.map(x=>x.tag)].map(x=>"'"+x+"'").join(',')+')';
}
export function receiptSubscriberSql(origin,selector) {
 return 'CASE '+origin+' '+restricted.map(x=>"WHEN '"+x.tag+"' THEN "+selector+"='"+x.selector+"'").join(' ')+' ELSE TRUE END';
}
