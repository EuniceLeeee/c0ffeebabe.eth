import { availableParallelism, cpus, totalmem } from "node:os";
import { hashDomain } from "../../../../packages/canonical-codec/src/index.ts";
import {
  createHardwareProfileObservationV1,
  type HardwareProfileObservationV1,
} from "../../../../specs/performance/src/index.ts";

/** Host-owned observation shared by installed and pre-release policy issuers. */
export function observeRuntimeReleaseHardwareProfileV1(): HardwareProfileObservationV1 {
  const processors = cpus();
  if (processors.length === 0) throw new TypeError("hardware profile has no logical CPUs");
  return createHardwareProfileObservationV1({
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    availableParallelism: availableParallelism().toString(),
    logicalCpuCount: processors.length.toString(),
    cpuModelSetRoot: hashDomain(
      "aloha/hardware-profile-cpu-model-set/v1",
      [...new Set(processors.map(cpu => cpu.model))].sort(),
    ),
    totalMemoryBytes: totalmem().toString(),
  });
}
