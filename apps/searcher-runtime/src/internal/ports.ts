import type {
  ProducerSessionV1,
} from "../../../../packages/canonical-source/src/index.ts";
import type {
  StartupProducerLeaseV1,
} from "../../../../packages/startup-runtime/src/index.ts";

export type SearcherProducerSessionV1 = ProducerSessionV1<StartupProducerLeaseV1>;
