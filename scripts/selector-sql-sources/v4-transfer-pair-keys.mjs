import assert from 'node:assert/strict';
import {v4MainnetManager} from './v4-history.mjs';

const zero='0x'+'0'.repeat(40);

// Ordinary settlement nominates currencies only. The authenticated tail stays
// intact; the exact same receipt's signed Swap supplies the target PoolId.
export function renderV4TransferPairKeys(){
 assert.equal(arguments.length,0,'transfer-pair evidence does not accept external sources');
 const ctes=`v4_tp_swaps AS (
 SELECT bh,th,manager,ARRAY_AGG(DISTINCT poolId LIMIT 65) ids,COUNT(DISTINCT poolId) nIds
 FROM v4_native_unresolved_swaps WHERE manager='${v4MainnetManager}' GROUP BY bh,th,manager
), v4_tp_coins AS (
 SELECT bh,th,ARRAY_AGG(DISTINCT c1 LIMIT 33) coins,COUNT(DISTINCT c1) nCoins
 FROM v4_native_valid_transfers
 WHERE '${v4MainnetManager}' IN (src,dst) AND src!='${zero}' AND dst!='${zero}' AND src!=dst
 GROUP BY bh,th HAVING COUNT(DISTINCT c1)>=2
), v4_tp_occurrences AS (
 SELECT s.bh,s.th,s.manager,s.ids,c0,c1
 FROM v4_tp_swaps s JOIN v4_tp_coins t USING(bh,th)
 CROSS JOIN UNNEST(IF(s.nIds<=64 AND t.nCoins<=32,t.coins,ERROR('V4 transfer pair receipt budget exceeded'))) c0
 CROSS JOIN UNNEST(t.coins) c1 WHERE c0<c1
), v4_tp_pairs AS (
 SELECT c0,c1,ARRAY_AGG(STRUCT(bh AS bh,th AS th,manager AS manager,ids AS ids) LIMIT 10001) receipts,
 COUNT(*) nReceipts,COUNT(*) OVER() nPairs
 FROM v4_tp_occurrences GROUP BY c0,c1
), v4_tp_images AS (
 SELECT p.c0,p.c1,p.receipts,
 IF(p.nReceipts<=10000 AND SAFE_MULTIPLY(p.nPairs,t.nTails)<=2000000,
 CONCAT(REPEAT('0',24),SUBSTR(p.c0,3),REPEAT('0',24),SUBSTR(p.c1,3),t.tail),
 ERROR('V4 transfer pair window budget exceeded')) preimage
 FROM v4_tp_pairs p CROSS JOIN (SELECT tail,COUNT(*) OVER() nTails FROM v4_native_templates) t
), v4_tp_digests AS (
 SELECT c0,c1,receipts,preimage,v4ReceiptKeyId(preimage) poolId FROM v4_tp_images
), v4_tp_matches AS (
 SELECT r.bh,r.th,r.manager,k.poolId,k.c0,k.c1,k.preimage FROM v4_tp_digests k
 CROSS JOIN UNNEST(k.receipts) r WHERE k.poolId IN UNNEST(r.ids)
), v4_transfer_pair_evidence AS (
 SELECT bh,th,manager,poolId,MIN(c0) c0,MIN(c1) c1,MIN(m.preimage) preimage FROM v4_tp_matches m
 GROUP BY bh,th,manager,poolId HAVING COUNT(DISTINCT m.preimage)=1
)`;
 return {ctes};
}
