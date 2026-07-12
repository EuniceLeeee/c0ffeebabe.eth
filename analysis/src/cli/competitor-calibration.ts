import { runCompetitorCalibration } from "../competitor-calibration.js";

const result = runCompetitorCalibration();
console.log(JSON.stringify(result, null, 2));
if (result.status !== "pass") process.exit(1);
