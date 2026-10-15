/**
 * Machine-readable description of the lite action set: tool names, one-line
 * descriptions and parameters with enums. Single source of truth for the MCP
 * registration and for constraining a local model's decoding (JSON-schema or
 * GBNF). Data only: there is no decoding loop here.
 */

export type LiteParamType = "integer" | "string" | "boolean" | "enum";

export type LiteParamSchema = {
  name: string;
  type: LiteParamType;
  required: boolean;
  description: string;
  /** Allowed values when `type` is "enum". */
  enum?: readonly string[];
};

export type LiteToolSchema = {
  name: LiteToolName;
  /** One sentence. */
  description: string;
  params: readonly LiteParamSchema[];
};

export const LITE_TOOL_NAMES = [
  "look",
  "click",
  "type",
  "select",
  "go",
  "back",
  "forward",
  "reload",
  "scroll",
  "tabs",
  "audit",
  "details",
  "viewport",
  "screenshot"
] as const;
export type LiteToolName = (typeof LITE_TOOL_NAMES)[number];

const n = (what: string): LiteParamSchema => ({ name: "n", type: "integer", required: true, description: what });

export const LITE_TOOL_SCHEMAS: readonly LiteToolSchema[] = [
  {
    name: "look",
    description: "Show the current page as a short numbered list of things you can act on.",
    params: [{ name: "all", type: "boolean", required: false, description: "true to list everything that did not fit" }]
  },
  { name: "click", description: "Click item n from the latest look.", params: [n("item number from look")] },
  {
    name: "type",
    description: "Type text into text field n (set submit true to press its form's submit button after).",
    params: [
      n("field number from look"),
      { name: "text", type: "string", required: true, description: "text to enter" },
      { name: "submit", type: "boolean", required: false, description: "true to submit the form afterwards" }
    ]
  },
  {
    name: "select",
    description: "Choose an option in dropdown n.",
    params: [n("dropdown number from look"), { name: "option", type: "string", required: true, description: "option text" }]
  },
  { name: "go", description: "Open a web address in the current tab.", params: [{ name: "url", type: "string", required: true, description: "full URL, e.g. http://localhost:3000" }] },
  { name: "back", description: "Go back one page.", params: [] },
  { name: "forward", description: "Go forward one page.", params: [] },
  { name: "reload", description: "Reload the current page.", params: [] },
  {
    name: "scroll",
    description: "Scroll the page up or down by one screen.",
    params: [{ name: "direction", type: "enum", required: true, description: "scroll direction", enum: ["up", "down"] }]
  },
  {
    name: "tabs",
    description: "List open tabs, or switch to tab n.",
    params: [{ name: "n", type: "integer", required: false, description: "tab number to switch to" }]
  },
  {
    name: "audit",
    description: "Check the page and report the top problems.",
    params: [
      {
        name: "kind",
        type: "enum",
        required: true,
        description: "what to check",
        enum: ["accessibility", "seo", "layout", "performance", "health"]
      }
    ]
  },
  { name: "details", description: "Explain item n of the latest audit and how to fix it.", params: [n("audit item number")] },
  {
    name: "viewport",
    description: "Resize the page to a phone, tablet or desktop screen, or reset it.",
    params: [
      {
        name: "size",
        type: "enum",
        required: true,
        description: "screen size",
        enum: ["mobile", "tablet", "desktop", "reset"]
      }
    ]
  },
  { name: "screenshot", description: "Save a screenshot and say where it is and what is on screen.", params: [] }
];

/** JSON-schema (draft-07 subset) for one tool call: `{ "tool": "click", "n": 3 }`. */
export function liteToolCallJsonSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    oneOf: LITE_TOOL_SCHEMAS.map((tool) => ({
      type: "object",
      title: tool.name,
      description: tool.description,
      additionalProperties: false,
      required: ["tool", ...tool.params.filter((p) => p.required).map((p) => p.name)],
      properties: {
        tool: { const: tool.name },
        ...Object.fromEntries(
          tool.params.map((p) => [
            p.name,
            p.type === "enum"
              ? { enum: [...(p.enum ?? [])], description: p.description }
              : { type: p.type, ...(p.type === "integer" ? { minimum: 1 } : {}), description: p.description }
          ])
        )
      }
    }))
  };
}

/**
 * GBNF grammar (llama.cpp / Ollama `format` grammar style) for exactly one
 * compact-JSON tool call, e.g. `{"tool":"click","n":3}`. Keys appear in the
 * schema order; optional parameters may be omitted.
 */
export function liteToolCallGbnf(): string {
  const rules: string[] = [];
  const names: string[] = [];
  for (const tool of LITE_TOOL_SCHEMAS) {
    const rule = `call-${tool.name}`;
    names.push(rule);
    const parts = [`"{\\"tool\\":\\"${tool.name}\\""`];
    for (const p of tool.params) {
      const value =
        p.type === "integer"
          ? "integer"
          : p.type === "boolean"
            ? "boolean"
            : p.type === "enum"
              ? `(${(p.enum ?? []).map((v) => `"\\"${v}\\""`).join(" | ")})`
              : "string";
      const piece = `",\\"${p.name}\\":" ${value}`;
      parts.push(p.required ? piece : `(${piece})?`);
    }
    parts.push('"}"');
    rules.push(`${rule} ::= ${parts.join(" ")}`);
  }
  return [
    `root ::= ${names.join(" | ")}`,
    ...rules,
    'integer ::= [1-9] [0-9]{0,2}',
    'boolean ::= "true" | "false"',
    'string ::= "\\"" ([^"\\\\\\x00-\\x1f] | "\\\\" ["\\\\/bfnrt])* "\\""'
  ].join("\n");
}
