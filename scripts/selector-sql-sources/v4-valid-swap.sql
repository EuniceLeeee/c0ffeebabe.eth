v4_valid_swaps AS (SELECT s.*,LOWER(s.topics[SAFE_OFFSET(1)]) poolId
 FROM v4_checked s
 WHERE s.validReceipt AND s.emitter=@MANAGER AND s.topic0=@V4 AND ARRAY_LENGTH(s.topics)=3
 AND REGEXP_CONTAINS(s.topics[SAFE_OFFSET(1)],r'^0x[0-9a-f]{64}$') AND addr(s.topics[SAFE_OFFSET(2)]) IS NOT NULL
 AND REGEXP_CONTAINS(s.d,r'^0x[0-9a-f]{384}$') AND signw(word(s.d,0))*signw(word(s.d,1))=-1
 AND REGEXP_CONTAINS(word(s.d,0),r'^(?:0{32}[0-7]|f{32}[89a-f])') AND REGEXP_CONTAINS(word(s.d,1),r'^(?:0{32}[0-7]|f{32}[89a-f])')
 AND STARTS_WITH(word(s.d,2),REPEAT('0',24)) AND STARTS_WITH(word(s.d,3),REPEAT('0',32))
 AND REGEXP_CONTAINS(word(s.d,4),r'^(?:0{58}[0-7]|f{58}[89a-f])') AND STARTS_WITH(word(s.d,5),REPEAT('0',58)))
