import { describe, expect, it } from "vitest";

import { componentTreeCollectorScript } from "../src/main/component-tree.js";

type RawTree = { framework: string; tree: ComponentNodeLike | null; nodeCount: number };
type ComponentNodeLike = {
  name: string;
  props: Record<string, string>;
  key: string | null;
  state: Record<string, string>;
  hookCount: number;
  source?: string;
  children: ComponentNodeLike[];
};

/** Run the collector against the current jsdom document. */
function run(): RawTree {
  return eval(componentTreeCollectorScript()) as RawTree;
}

describe("componentTreeCollectorScript", () => {
  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(`return ${componentTreeCollectorScript()};`)).not.toThrow();
  });

  it("returns unknown/null when no framework hook is present", () => {
    document.body.innerHTML = `<div id="root"></div>`;
    const r = run();
    expect(r.framework).toBe("unknown");
    expect(r.tree).toBeNull();
    expect(r.nodeCount).toBe(0);
  });

  it("extracts a planted React fiber tree with name, key, source and children", () => {
    document.body.innerHTML = `<div id="root"></div>`;
    const root = document.getElementById("root") as unknown as Record<string, unknown>;

    const child = {
      type: { name: "Button" },
      key: "btn-1",
      memoizedProps: { label: "Save" },
      memoizedState: null,
      _debugSource: { fileName: "src/Button.tsx", lineNumber: 7 },
      child: null,
      sibling: null
    };
    root["__reactFiber$test"] = {
      type: { displayName: "App" },
      key: "app-root",
      memoizedProps: { title: "Hi" },
      memoizedState: null,
      child,
      sibling: null
    };

    const r = run();
    expect(r.framework).toBe("react");
    expect(r.tree?.name).toBe("App");
    expect(r.tree?.key).toBe("app-root");
    expect(r.tree?.children).toHaveLength(1);
    const btn = r.tree!.children[0];
    expect(btn).toMatchObject({ name: "Button", key: "btn-1", source: "src/Button.tsx:7" });
    expect(btn.props).toMatchObject({ label: "Save" });
    expect(r.nodeCount).toBe(2);
  });

  it("summarises nested props one level deep instead of collapsing to [object]", () => {
    document.body.innerHTML = `<div id="root"></div>`;
    const root = document.getElementById("root") as unknown as Record<string, unknown>;
    root["__reactFiber$test"] = {
      type: { name: "Card" },
      key: null,
      memoizedProps: { config: { theme: "dark", deep: { x: 1 } }, items: [1, 2, 3, 4] },
      memoizedState: null,
      child: null,
      sibling: null
    };
    const r = run();
    // one level into the object; the doubly-nested object collapses to [object]
    expect(r.tree?.props.config).toBe("{theme: dark, deep: [object]}");
    // array summarised, capped at 3 with an ellipsis
    expect(r.tree?.props.items).toBe("[1, 2, 3, …]");
  });

  it("extracts React hook state (useState values) and a hook count", () => {
    document.body.innerHTML = `<div id="root"></div>`;
    const root = document.getElementById("root") as unknown as Record<string, unknown>;
    // function-component hook linked list: useState(5), useState("open"), useEffect(...)
    const hooks = {
      memoizedState: 5,
      next: {
        memoizedState: "open",
        next: {
          memoizedState: { tag: 8, create: () => {} }, // effect — skipped
          next: null
        }
      }
    };
    root["__reactFiber$test"] = {
      type: { name: "Widget" },
      key: null,
      memoizedProps: {},
      memoizedState: hooks,
      child: null,
      sibling: null
    };
    const r = run();
    expect(r.tree?.hookCount).toBe(3);
    expect(r.tree?.state.hook0).toBe("5");
    expect(r.tree?.state.hook1).toBe("open");
    expect(r.tree?.state.hook2).toBeUndefined(); // effect hook carries no value
  });
});
