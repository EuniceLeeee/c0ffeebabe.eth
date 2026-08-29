import type { SixStepQualificationFixtureV1 } from "../src/qualification.ts";
import {
  issueTestOnlySixStepPositiveFixtureV1,
  type IssuedSixStepQualificationCorpusV1,
} from "../src/internal/qualification-corpus-owner.ts";

/** Test closure only. Production code must never import this module. */
export function issueSixStepQualificationCorpusFixtureV1(
  positiveFixture: SixStepQualificationFixtureV1,
): IssuedSixStepQualificationCorpusV1 {
  return issueTestOnlySixStepPositiveFixtureV1(positiveFixture);
}
