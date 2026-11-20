import assert from 'node:assert/strict';

// A discovery key for a directed edge, not the attested runtime instanceKey.
// Keep the tuple alongside its hash. Different Families for an identical
// selector and tuple remain as evidence on the same row.
export const candidateCoordinateFields = Object.freeze([
  'chainId','selector','poolAddress','poolNamespace','poolId','tokenIn','tokenInId','tokenOut','tokenOutId',
]);
export function renderSelectorCandidateInstancesSql(ledgerTable) {
  assert(/^[a-z][a-z0-9-]+\.[A-Za-z_]\w*\.[A-Za-z0-9_-]+$/.test(ledgerTable),'Invalid ledger table');
  const fields=candidateCoordinateFields;
  const columns=fields.map(k=>{
    const value="JSON_VALUE(body,'$."+(k==='selector'?'familySelector':k)+"')";
    const expression=k==='chainId'?'CAST('+value+' AS INT64)':
      ['selector','poolAddress','tokenIn','tokenOut'].includes(k)?'LOWER('+value+')':value;
    return expression+' AS '+k;
  }).join(', ');
  const tuple=fields.join(', ');
  const encoded='TO_JSON_STRING([CAST(chainId AS STRING), '+fields.slice(1).join(', ')+'])';
  return `WITH evidence AS (
    SELECT ${columns}, JSON_VALUE(body,'$.familyId') AS familyId,
      CAST(JSON_VALUE(body,'$.observedTargetSelector') AS BOOL) AS observed
    FROM \`${ledgerTable}\`
  ), grouped AS (
    SELECT ${tuple}, ARRAY_AGG(DISTINCT familyId ORDER BY familyId) AS familyIds,
      IFNULL(ARRAY_AGG(DISTINCT IF(observed,familyId,NULL) IGNORE NULLS ORDER BY IF(observed,familyId,NULL)), ARRAY<STRING>[]) AS observedFamilyIds,
      LOGICAL_OR(observed) AS observedTargetSelector
    FROM evidence GROUP BY ${tuple}
  )
  SELECT TO_JSON_STRING(STRUCT(CONCAT('candidate-edge:v1:',LOWER(TO_HEX(SHA256(${encoded})))) AS candidateInstanceKey,
    ${tuple}, familyIds, observedFamilyIds, observedTargetSelector, FALSE AS verified)) AS body FROM grouped`;
}
