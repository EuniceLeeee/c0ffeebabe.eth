import assert from 'node:assert/strict';
import {receiptEvidenceSql,receiptSubscriberSql} from './selector-sql-sources/receipt-evidence.mjs';

// Only an inventory of candidates. Topic subscriptions say which ABI families
// might own an observation, not which function was called or can be executed.
export function draftTopicFamilies(rules) {
  const result = new Map();
  for (const {familyId,callPatterns,logPatterns} of rules) {
    const match = /^execution:(0x[0-9a-f]{8}):abi-[0-9a-f]{64}$/.exec(familyId);
    if (!match) continue; // This draft contains ordinary execution edges only.
    assert(callPatterns.some(p=>p.selector.toLowerCase()===match[1]),'Family selector disagrees with catalog');
    for (const {topic} of logPatterns) {
      assert(/^0x[0-9a-f]{64}$/i.test(topic));
      const t=topic.toLowerCase();
      result.set(t+':'+familyId,{topic:t,familyId,selector:match[1]});
    }
  }
  return [...result.values()].sort((a,b)=>a.topic.localeCompare(b.topic)||a.familyId.localeCompare(b.familyId));
}

export function renderReadyGraphDraftSql({calls,events,rules}) {
  const table = x => {
    assert(/^[a-z][a-z0-9-]+\.[A-Za-z_]\w*\.[A-Za-z0-9_-]+$/.test(x),'Invalid SQL source');
    return '`'+x+'`';
  };
  const entries=draftTopicFamilies(rules).map(x=>"('"+x.topic+"','"+x.familyId+"','"+x.selector+"')");
  return `WITH catalog AS (
  SELECT topic,ARRAY_AGG(STRUCT(familyId,selector) ORDER BY familyId) candidates
  FROM UNNEST(ARRAY<STRUCT<topic STRING,familyId STRING,selector STRING>>[${entries}]) GROUP BY topic
), observed AS (
  SELECT JSON_VALUE(body,'$.topic0') topic,JSON_VALUE(body,'$.address') poolAddress,
   JSON_VALUE(body,'$.poolId') poolId,JSON_VALUE(body,'$.tokenIn') tokenIn,JSON_VALUE(body,'$.tokenOut') tokenOut,
   JSON_VALUE(body,'$.evidence') provenance,CAST(JSON_VALUE(body,'$.observations') AS INT64) n,
   TO_JSON_STRING(STRUCT(JSON_VALUE(body,'$.txTo') AS txTo,JSON_VALUE(body,'$.txSelector') AS txSelector)) entrance
  FROM ${table(events)} WHERE IF(kind='event',IF(${receiptEvidenceSql("JSON_VALUE(body,'$.evidence')")},TRUE,ERROR('Unsupported receipt evidence; rebuild from transaction evidence')),FALSE)
), target_matches AS (
  SELECT o.*,ARRAY(SELECT AS STRUCT f.* FROM UNNEST(candidates) f
      WHERE ${receiptSubscriberSql('o.provenance','f.selector')} ORDER BY f.familyId) byTopic,
    ARRAY(SELECT AS STRUCT f.* FROM UNNEST(candidates) f
      WHERE JSON_VALUE(entrance,'$.txTo')=poolAddress AND JSON_VALUE(entrance,'$.txSelector')=f.selector
      AND ${receiptSubscriberSql('o.provenance','f.selector')} ORDER BY f.familyId) direct
  FROM observed o LEFT JOIN catalog USING(topic)
), tagged AS (
  SELECT * EXCEPT(direct,byTopic),TO_JSON_STRING(IF(ARRAY_LENGTH(direct)>0,direct,byTopic)) AS owners,
    CASE WHEN ARRAY_LENGTH(direct)=1 THEN 'top-level-target-selector+event'
         WHEN ARRAY_LENGTH(direct)>1 THEN 'ambiguous-target-selector'
         WHEN ARRAY_LENGTH(byTopic)=1 THEN 'single-event-candidate'
         WHEN ARRAY_LENGTH(byTopic)>1 THEN 'ambiguous-event-candidates' ELSE 'no-catalog-match' END AS familyEvidence
  FROM target_matches
), collapsed AS (
  SELECT topic,poolAddress,poolId,tokenIn,tokenOut,provenance,owners,familyEvidence,SUM(n) observations,
    ARRAY_AGG(DISTINCT entrance ORDER BY entrance) entrances FROM tagged GROUP BY topic,poolAddress,poolId,tokenIn,tokenOut,provenance,owners,familyEvidence
), assigned AS (
  SELECT *,ARRAY(SELECT AS STRUCT JSON_VALUE(f,'$.familyId') familyId,JSON_VALUE(f,'$.selector') selector FROM UNNEST(JSON_QUERY_ARRAY(owners)) f ORDER BY familyId) candidates
  FROM collapsed
), event_rows AS (
  SELECT 1 chainId,IF(ARRAY_LENGTH(candidates)=1,candidates[SAFE_OFFSET(0)].familyId,NULL) familyId,
    IF(ARRAY_LENGTH(candidates)=1,candidates[SAFE_OFFSET(0)].selector,NULL) familySelector,
    IFNULL(candidates,[]) candidateFamilies,
    familyEvidence,
    CAST(NULL AS STRING) programKey,CAST(NULL AS STRING) observationId,CAST(NULL AS STRING) immutableParametersJson,
    poolAddress,poolId,CAST(NULL AS STRING) poolNamespace,tokenIn,tokenOut,CAST(NULL AS STRING) tokenInId,CAST(NULL AS STRING) tokenOutId,
    topic AS topic0,provenance,observations,
    ARRAY(SELECT AS STRUCT JSON_VALUE(s,'$.txTo') txTo,JSON_VALUE(s,'$.txSelector') txSelector FROM UNNEST(entrances) s ORDER BY s) txEntrypoints
  FROM assigned
), call_rows AS (
  SELECT CAST(JSON_VALUE(body,'$.chainId') AS INT64) chainId,JSON_VALUE(body,'$.familyId') familyId,JSON_VALUE(body,'$.selector') familySelector,
    [STRUCT(JSON_VALUE(body,'$.familyId') AS familyId,JSON_VALUE(body,'$.selector') AS selector)] candidateFamilies,
    'top-level-abi-nomination' familyEvidence,JSON_VALUE(body,'$.programKey') programKey,JSON_VALUE(body,'$.observationId') observationId,
    JSON_QUERY(body,'$.immutableParameters') immutableParametersJson,
    JSON_VALUE(body,'$.target') poolAddress,JSON_VALUE(body,'$.poolId') poolId,JSON_VALUE(body,'$.poolNamespace') poolNamespace,
    JSON_VALUE(body,'$.tokenIn') tokenIn,JSON_VALUE(body,'$.tokenOut') tokenOut,JSON_VALUE(body,'$.tokenInId') tokenInId,JSON_VALUE(body,'$.tokenOutId') tokenOutId,
    CAST(NULL AS STRING) topic0,'transaction-calldata+receipt' provenance,CAST(NULL AS INT64) observations,
    [STRUCT(JSON_VALUE(body,'$.target') AS txTo,JSON_VALUE(body,'$.selector') AS txSelector)] txEntrypoints
  FROM ${table(calls)} WHERE row_kind='witness'
), all_rows AS (SELECT * FROM event_rows UNION ALL SELECT * FROM call_rows)
SELECT TO_JSON_STRING((SELECT AS STRUCT all_rows.*,FALSE AS verified,
  CASE WHEN tokenIn IS NULL OR tokenOut IS NULL THEN 'missing-direction'
       WHEN tokenIn=tokenOut AND tokenInId IS NOT DISTINCT FROM tokenOutId THEN 'same-asset'
       WHEN familyId IS NULL THEN 'unresolved-family'
       ELSE 'needs-ready-verification' END AS draftStatus)) AS body FROM all_rows
ORDER BY body`;
}

/** A candidate ledger, not admitted Ready state. Preserve unresolved evidence
 * separately. Do not manufacture a reverse direction or an observed call. */
export function renderFamilyCandidateEdgesSql(draftTable) {
  assert(/^[a-z][a-z0-9-]+\.[A-Za-z_]\w*\.[A-Za-z0-9_-]+$/.test(draftTable),'Invalid draft table');
  return `WITH src AS (
 SELECT JSON_VALUE(body,'$.draftStatus') AS state,CAST(JSON_VALUE(body,'$.chainId') AS INT64) AS chainId,
 JSON_VALUE(body,'$.poolAddress') poolAddress,JSON_VALUE(body,'$.poolId') poolId,JSON_VALUE(body,'$.poolNamespace') poolNamespace,
 JSON_VALUE(body,'$.tokenIn') tokenIn,JSON_VALUE(body,'$.tokenInId') tokenInId,JSON_VALUE(body,'$.tokenOut') tokenOut,JSON_VALUE(body,'$.tokenOutId') tokenOutId,
 JSON_VALUE(body,'$.familyEvidence') evidence,JSON_VALUE(body,'$.topic0') topic0,JSON_VALUE(body,'$.programKey') programKey,
 JSON_VALUE(body,'$.observationId') observationId,JSON_QUERY_ARRAY(body,'$.candidateFamilies') candidates
 FROM \`${draftTable}\`
), expanded AS (
 SELECT src.* EXCEPT(candidates),JSON_VALUE(c,'$.familyId') familyId,JSON_VALUE(c,'$.selector') familySelector
 FROM src LEFT JOIN UNNEST(candidates) c ON TRUE
), grouped AS (
 SELECT CASE WHEN state='missing-direction' THEN 'missing-direction' WHEN state='same-asset' THEN 'same-asset'
   WHEN familyId IS NULL THEN 'unknown-family' ELSE 'candidate-edge' END AS kind,
 chainId,familyId,familySelector,poolAddress,poolId,poolNamespace,tokenIn,tokenInId,tokenOut,tokenOutId,
 LOGICAL_OR(evidence IN ('top-level-abi-nomination','top-level-target-selector+event','ambiguous-target-selector')) AS observedTargetSelector,
 ARRAY_AGG(DISTINCT evidence ORDER BY evidence) AS evidenceTypes,
 ARRAY_AGG(DISTINCT topic0 IGNORE NULLS ORDER BY topic0) AS topics,
 ARRAY_AGG(DISTINCT programKey IGNORE NULLS ORDER BY programKey) AS programKeys,
 ARRAY_AGG(DISTINCT observationId IGNORE NULLS ORDER BY observationId) AS nominationIds,
 FALSE AS verified
 FROM expanded GROUP BY kind,chainId,familyId,familySelector,poolAddress,poolId,poolNamespace,tokenIn,tokenInId,tokenOut,tokenOutId)
SELECT kind,TO_JSON_STRING(g) body FROM grouped g`;
}
