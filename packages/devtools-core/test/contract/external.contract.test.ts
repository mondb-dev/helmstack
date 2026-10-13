// Opt-in: an already-running instance (e.g. the desktop app). Runs only when
// HELMSTACK_CONTRACT_URL is set; never defaults to 127.0.0.1:7070.
import { externalBackend } from "./backends.js";
import { defineContractSuite } from "./suite.js";

defineContractSuite(externalBackend);
