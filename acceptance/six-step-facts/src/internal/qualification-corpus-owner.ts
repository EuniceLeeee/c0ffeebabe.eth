import type { SixStepQualificationFixtureV1 } from "../qualification.ts";

/** Process-local proof that the base positive fixture came from the owner.
 * Mutation cases are never carried by this capability. */
export interface IssuedSixStepQualificationCorpusV1 {
  readonly kind: "aloha.issued-six-step-qualification-corpus-v1";
}

const issued = new WeakMap<object, SixStepQualificationFixtureV1>();

/** TEST-ONLY positive-fixture bridge. It deliberately remains absent from the
 * package export map; all mutation construction still belongs to src/. */
export function issueTestOnlySixStepPositiveFixtureV1(
  positiveFixture: SixStepQualificationFixtureV1,
): IssuedSixStepQualificationCorpusV1 {
  const capability = Object.freeze({
    kind: "aloha.issued-six-step-qualification-corpus-v1" as const,
  });
  issued.set(capability, positiveFixture);
  return capability;
}

export function readIssuedSixStepQualificationCorpusV1(
  capability: IssuedSixStepQualificationCorpusV1,
): SixStepQualificationFixtureV1 {
  const positiveFixture = issued.get(capability as object);
  if (positiveFixture === undefined) throw new TypeError("six-step qualification positive fixture was not issued by the package owner");
  return positiveFixture;
}
