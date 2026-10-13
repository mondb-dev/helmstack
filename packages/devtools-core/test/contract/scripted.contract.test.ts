// Fast, always-on: HelmstackCore over the scripted in-memory backend (no browser).
import { scriptedBackend } from "./backends.js";
import { defineContractSuite } from "./suite.js";

defineContractSuite(scriptedBackend);
