import type { WebContents } from "electron";

import type { ComponentFramework, ComponentNode, ComponentTreeReport, TabId } from "../../../../packages/shared/src/index.js";
import { SELECTOR_FOR_SOURCE } from "../../../../packages/perception/src/page-selector.js";

/**
 * In-page collector that probes React / Vue / Svelte devtools hooks and returns
 * a component tree. Exported as a string so it can be planted-fiber tested in
 * jsdom (see component-tree.test.ts) the same way the source collector is.
 *
 * Beyond name + source it now extracts: React `key`, **one-level-deep** prop
 * summaries (nested objects/arrays are described rather than collapsed to
 * `[object]`), and component **state** — React hooks (`hook0`, `hook1`, …) or
 * class/Vue state — with a hook count.
 */
export function componentTreeCollectorScript(): string {
  return `(function() {
    var selectorFor = ${SELECTOR_FOR_SOURCE};
    // The first host (DOM) descendant of a fiber — the component's rendered root.
    function firstHostNode(fiber, depth) {
      if (!fiber || depth > 40) return null;
      if (typeof fiber.type === 'string' && fiber.stateNode && fiber.stateNode.nodeType === 1) return fiber.stateNode;
      var child = fiber.child;
      while (child) {
        var found = firstHostNode(child, depth + 1);
        if (found) return found;
        child = child.sibling;
      }
      return null;
    }
    function truncate(v) {
      var s = String(v);
      return s.length > 80 ? s.slice(0, 77) + '...' : s;
    }
    // Describe a value, recursing one level into objects/arrays (depth-bounded).
    function describe(v, depth) {
      if (v === null) return 'null';
      if (v === undefined) return 'undefined';
      var t = typeof v;
      if (t === 'function') return '[function]';
      if (t !== 'object') return truncate(v);
      if (depth <= 0) return Array.isArray(v) ? '[…]' : '[object]';
      if (Array.isArray(v)) {
        var items = v.slice(0, 3).map(function(x) { return describe(x, depth - 1); });
        return '[' + items.join(', ') + (v.length > 3 ? ', …' : '') + ']';
      }
      var parts = [], n = 0;
      try {
        for (var k in v) {
          if (Object.prototype.hasOwnProperty.call(v, k)) {
            parts.push(k + ': ' + describe(v[k], depth - 1));
            if (++n >= 8) { parts.push('…'); break; }
          }
        }
      } catch (e) { return '[object]'; }
      return '{' + parts.join(', ') + '}';
    }
    function safeProps(p) {
      if (!p || typeof p !== 'object') return {};
      var out = {};
      try {
        for (var k in p) {
          if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = describe(p[k], 1);
        }
      } catch (e) { out['_err'] = 'failed'; }
      return out;
    }

    // React hooks / class state. Function components store a linked list of
    // hooks on memoizedState (each node: { memoizedState, next }); class
    // components store a plain state object. Effect hooks ({ tag, create }) are
    // skipped — they carry no user-facing value.
    function reactState(fiber) {
      var ms = fiber.memoizedState;
      if (ms == null) return { state: {}, hookCount: 0 };
      var isHookList = typeof ms === 'object' && !Array.isArray(ms) && ('next' in ms || 'memoizedState' in ms);
      if (isHookList) {
        var state = {}, count = 0, node = ms;
        while (node && typeof node === 'object' && count < 25) {
          var hv = node.memoizedState;
          var isEffect = hv && typeof hv === 'object' && 'tag' in hv && 'create' in hv;
          if (!isEffect) state['hook' + count] = describe(hv, 1);
          count++;
          node = node.next;
        }
        return { state: state, hookCount: count };
      }
      if (typeof ms === 'object') return { state: safeProps(ms), hookCount: 0 };
      return { state: {}, hookCount: 0 };
    }

    // Resolve a component display name from a fiber.type, handling host strings,
    // function/class components, and object types (memo / forwardRef / context).
    function reactName(t) {
      if (!t) return null;
      if (typeof t === 'string') return t;
      if (typeof t === 'function') return t.displayName || t.name || null;
      if (typeof t === 'object') {
        return t.displayName || t.name || reactName(t.type) || reactName(t.render) || null;
      }
      return null;
    }

    // React 18+ __reactFiber / React 16-17 __reactInternalInstance
    function buildReactTree(fiber, depth) {
      if (!fiber || depth > 30) return null;
      var name = reactName(fiber.type);
      if (!name || name.length === 0) {
        return buildReactTree(fiber.child, depth + 1);
      }
      var src = fiber._debugSource;
      var rs = reactState(fiber);
      var node = {
        name: name,
        props: safeProps(fiber.memoizedProps),
        key: fiber.key != null ? String(fiber.key) : null,
        state: rs.state,
        hookCount: rs.hookCount,
        children: []
      };
      if (src && src.fileName) node.source = src.fileName + ':' + src.lineNumber;
      var hostNode = firstHostNode(fiber, 0);
      if (hostNode) node.domSelector = selectorFor(hostNode);
      var child = fiber.child;
      while (child) {
        var childNode = buildReactTree(child, depth + 1);
        if (childNode) node.children.push(childNode);
        child = child.sibling;
      }
      return node;
    }

    // Vue 3: __vue_app__ on #app or body
    function buildVue3Tree(vnode, depth) {
      if (!vnode || depth > 30) return null;
      var name = vnode.type && (vnode.type.__name || vnode.type.name || vnode.type) || 'Anonymous';
      if (typeof name !== 'string') name = String(name);
      var node = {
        name: name,
        props: safeProps(vnode.props),
        key: vnode.key != null ? String(vnode.key) : null,
        state: vnode.component && vnode.component.setupState ? safeProps(vnode.component.setupState) : {},
        hookCount: 0,
        children: []
      };
      if (vnode.type && vnode.type.__file) node.source = vnode.type.__file;
      if (vnode.el && vnode.el.nodeType === 1) node.domSelector = selectorFor(vnode.el);
      var children = vnode.component && vnode.component.subTree
        ? [vnode.component.subTree] : (vnode.children ? [].concat(vnode.children) : []);
      for (var c of children) {
        var cn = buildVue3Tree(c, depth + 1);
        if (cn) node.children.push(cn);
      }
      return node;
    }

    // Svelte: window.__svelte__
    function buildSvelteTree() {
      var comps = window.__svelte__ ? Object.keys(window.__svelte__) : [];
      if (!comps.length) return null;
      return { name: 'SvelteRoot', props: {}, state: {}, hookCount: 0, children: comps.map(function(k) {
        return { name: k, props: {}, state: {}, hookCount: 0, children: [] };
      })};
    }

    // Detect and build
    var framework = 'unknown', tree = null;

    var roots = document.querySelectorAll('[data-reactroot], #root, #app, body > div');
    for (var el of roots) {
      var fiberKey = Object.keys(el).find(function(k) {
        return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance');
      });
      if (fiberKey) {
        framework = 'react';
        tree = buildReactTree(el[fiberKey], 0);
        break;
      }
    }

    if (!tree) {
      var vueRoot = document.querySelector('#app') || document.querySelector('[data-v-app]');
      if (vueRoot && vueRoot.__vue_app__) {
        framework = 'vue';
        tree = buildVue3Tree(vueRoot.__vue_app__._instance && vueRoot.__vue_app__._instance.subTree, 0);
      }
    }

    if (!tree) {
      var vue2Root = document.querySelector('#app');
      if (vue2Root && vue2Root.__vue__) {
        framework = 'vue';
        var vm = vue2Root.__vue__;
        tree = { name: vm.$options.name || 'App', props: safeProps(vm.$props), state: safeProps(vm.$data), hookCount: 0, children: [] };
      }
    }

    if (!tree) {
      var svelteTree = buildSvelteTree();
      if (svelteTree) { framework = 'svelte'; tree = svelteTree; }
    }

    function countNodes(n) {
      if (!n) return 0;
      return 1 + n.children.reduce(function(s, c) { return s + countNodes(c); }, 0);
    }

    return { framework: framework, tree: tree, nodeCount: countNodes(tree) };
  })()`;
}

/**
 * Probe React / Vue / Svelte devtools hooks and return a component tree (name,
 * one-level-deep props, source `file:line`, React key, and hook/class state).
 * Extracted from `TabManager`. Assumes the CDP debugger is attached.
 */
export async function runComponentTree(webContents: WebContents, tabId: TabId): Promise<ComponentTreeReport> {
  const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
    expression: componentTreeCollectorScript(),
    returnByValue: true
  }) as { result: { value: { framework: string; tree: unknown; nodeCount: number } } };

  const val = result.result.value;
  return {
    tabId,
    url: webContents.getURL(),
    capturedAt: Date.now(),
    framework: val.framework as ComponentFramework,
    tree: val.tree as ComponentNode | null,
    nodeCount: val.nodeCount ?? 0
  };
}
