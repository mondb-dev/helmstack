export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "desktop",
        "agent-sdk",
        "mcp-server",
        "perception",
        "shared",
        "agent-example",
        "deps",
        "release",
      ],
    ],
    "scope-empty": [0], // allow commits without a scope
  },
};
