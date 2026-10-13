// Real headless Chrome via ChromeBackend + HelmstackCore + createAgentServer.
// Skipped when no Chrome is found, unless CI_REQUIRE_CHROME=1 (then it fails).
import { daemonBackend } from "./backends.js";
import { defineContractSuite } from "./suite.js";

defineContractSuite(daemonBackend);
