import assert from 'node:assert/strict';
import {draftTopicFamilies} from './ready-graph-draft-sql.mjs';
import {receiptEvidenceSql,receiptSubscriberSql} from './selector-sql-sources/receipt-evidence.mjs';
const tbl=s=>{assert(/^[a-z][a-z0-9-]+\.[A-Za-z_]\w*\.[A-Za-z0-9_-]+$/.test(s));return '`'+s+'`';};

// Catalog is the intake, never the supplemental price-free lookup. The optional
// receipt enrichment resolves directions (e.g. signed amounts plus transfers)
// for a subset of layouts. It does not limit which catalog events are visited.
export function renderSelectorWindowLedger({calls,events,enriched,rules}) {
 const candidates=draftTopicFamilies(rules);
 const subs=candidates.map(x=>"('"+x.topic+"','"+x.familyId+"','"+x.selector+"')").join(',');
 return `WITH subs AS (SELECT * FROM UNNEST(ARRAY<STRUCT<topic0 STRING,familyId STRING,familySelector STRING>>[${subs}])),
 call_rows AS (
 SELECT CAST(JSON_VALUE(body,'$.chainId') AS INT64) chainId,JSON_VALUE(body,'$.familyId') familyId,JSON_VALUE(body,'$.selector') familySelector,
 JSON_VALUE(body,'$.target') poolAddress,JSON_VALUE(body,'$.poolId') poolId,JSON_VALUE(body,'$.poolNamespace') poolNamespace,
 JSON_VALUE(body,'$.tokenIn') tokenIn,JSON_VALUE(body,'$.tokenOut') tokenOut,JSON_VALUE(body,'$.tokenInId') tokenInId,JSON_VALUE(body,'$.tokenOutId') tokenOutId,
 TRUE observedTargetSelector,CAST(NULL AS STRING) topic0,JSON_VALUE(body,'$.programKey') programKey,JSON_VALUE(body,'$.observationId') nominationId,
 'top-level-abi-nomination' evidence FROM ${tbl(calls)} WHERE row_kind='witness'
 ), enrichment AS (
 SELECT JSON_VALUE(body,'$.topic0') topic0,JSON_VALUE(body,'$.address') poolAddress,JSON_VALUE(body,'$.poolId') poolId,
 JSON_VALUE(body,'$.tokenIn') tokenIn,JSON_VALUE(body,'$.tokenOut') tokenOut,JSON_VALUE(body,'$.txTo') txTo,JSON_VALUE(body,'$.txSelector') txSelector,
 JSON_VALUE(body,'$.evidence') evidence FROM ${tbl(enriched)}
 WHERE IF(kind='event',IF(${receiptEvidenceSql("JSON_VALUE(body,'$.evidence')")},TRUE,ERROR('Unsupported receipt evidence; rebuild from transaction evidence')),FALSE)
 ), catalog AS (SELECT * FROM ${tbl(events)}),
 optional_rows AS (
 SELECT DISTINCT e.*,s.familyId,s.familySelector FROM enrichment e JOIN subs s USING(topic0)
 JOIN catalog c ON c.familyId=s.familyId AND c.topic0=e.topic0 AND COALESCE(c.poolAddress,c.emitter)=e.poolAddress
  AND TO_JSON_STRING([c.poolId,c.txTo,c.txSelector])=TO_JSON_STRING([e.poolId,e.txTo,e.txSelector])
  AND (c.status='pending' OR (c.status='candidate' AND c.tokenIn=e.tokenIn AND c.tokenOut=e.tokenOut))
 WHERE e.tokenIn IS NOT NULL AND e.tokenOut IS NOT NULL
 AND ${receiptSubscriberSql('e.evidence','s.familySelector')}
 ), catalog_rows AS (
 SELECT topic0,poolAddress,poolId,tokenIn,tokenOut,txTo,txSelector,'declared-event-fields' AS evidence,familyId,familySelector
 FROM catalog WHERE status='candidate'
 ), combined AS (SELECT * FROM optional_rows UNION ALL SELECT * FROM catalog_rows),
 candidates AS (
 SELECT c.*,IFNULL(txTo=poolAddress AND txSelector=familySelector,FALSE) AS directlyObserved
 FROM combined c
 ), event_rows AS (
 SELECT 1 chainId,familyId,familySelector,poolAddress,poolId,CAST(NULL AS STRING) poolNamespace,
 tokenIn,tokenOut,CAST(NULL AS STRING) tokenInId,CAST(NULL AS STRING) tokenOutId,
 directlyObserved observedTargetSelector,topic0,CAST(NULL AS STRING) programKey,CAST(NULL AS STRING) nominationId,evidence
 FROM candidates
 ), unions AS (SELECT * FROM call_rows UNION ALL SELECT * FROM event_rows),
 ledger AS (SELECT chainId,familyId,familySelector,poolAddress,poolId,poolNamespace,tokenIn,tokenOut,tokenInId,tokenOutId,
 LOGICAL_OR(observedTargetSelector) observedTargetSelector,ARRAY_AGG(DISTINCT topic0 IGNORE NULLS ORDER BY topic0) topics,
 ARRAY_AGG(DISTINCT evidence ORDER BY evidence) evidenceTypes,ARRAY_AGG(DISTINCT programKey IGNORE NULLS ORDER BY programKey) programKeys,
 ARRAY_AGG(DISTINCT nominationId IGNORE NULLS ORDER BY nominationId) nominationIds,FALSE verified
 FROM unions WHERE poolAddress IS NOT NULL AND tokenIn IS NOT NULL AND tokenOut IS NOT NULL AND
 NOT(tokenIn=tokenOut AND tokenInId IS NOT DISTINCT FROM tokenOutId)
 GROUP BY chainId,familyId,familySelector,poolAddress,poolId,poolNamespace,tokenIn,tokenOut,tokenInId,tokenOutId)
 SELECT TO_JSON_STRING(l) body FROM ledger l`;
}
