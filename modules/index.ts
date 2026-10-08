/** The single registration list for all Mosaic Core modules. */
import type { ModuleDescriptor } from "../core/index.ts";
import { module as foundation } from "./foundation/index.ts";
import { module as coreRuntime } from "./core-runtime/index.ts";
import { module as intelligence } from "./intelligence/index.ts";
import { module as resource } from "./resource/index.ts";
import { module as data } from "./data/index.ts";
import { module as policySecurity } from "./policy-security/index.ts";
import { module as validation } from "./validation/index.ts";
import { module as resourceOptimization } from "./resource-optimization/index.ts";
import { module as reliability } from "./reliability/index.ts";
import { module as observability } from "./observability/index.ts";
import { module as control } from "./control/index.ts";
import { module as universalIntegration } from "./universal-integration/index.ts";

export const coreModules: readonly ModuleDescriptor[] = Object.freeze([
  foundation, coreRuntime, intelligence, resource, data, policySecurity, validation,
  resourceOptimization, reliability, observability, control, universalIntegration,
]);
