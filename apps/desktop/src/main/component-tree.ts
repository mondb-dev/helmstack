import type { WebContents } from "electron";

import type { ComponentTreeReport, TabId } from "../../../../packages/shared/src/index.js";

/**
 * Probe React / Vue / Svelte devtools hooks and return a lightweight component
 * tree (with source `file:line` where dev metadata is present). Extracted from
 * `TabManager`. Assumes the CDP debugger is attached.
 */
export async function runComponentTree(webContents: WebContents, tabId: TabId): Promise<ComponentTreeReport> {


    const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: `(function() {
        function truncate(v) {
          var s = String(v);
          return s.length > 80 ? s.slice(0, 77) + '...' : s;
        }
        function safeProps(p) {
          if (!p || typeof p !== 'object') return {};
          var out = {};
          try {
            for (var k in p) {
              if (Object.prototype.hasOwnProperty.call(p, k)) {
                var t = typeof p[k];
                if (t === 'function') out[k] = '[function]';
                else if (t === 'object' && p[k] !== null) out[k] = '[object]';
                else out[k] = truncate(p[k]);
              }
            }
          } catch(e) { out['_err'] = 'failed'; }
          return out;
        }

        // React 18+ __reactFiber / React 16-17 __reactInternalInstance
        function buildReactTree(fiber, depth) {
          if (!fiber || depth > 30) return null;
          var name = null;
          var t = fiber.type;
          if (typeof t === 'function') name = t.displayName || t.name || null;
          else if (typeof t === 'string') name = t;
          if (!name || name.length === 0) {
            return buildReactTree(fiber.child, depth + 1);
          }
          var src = fiber._debugSource;
          var node = { name: name, props: safeProps(fiber.memoizedProps), children: [] };
          if (src && src.fileName) node.source = src.fileName + ':' + src.lineNumber;
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
          var node = { name: name, props: safeProps(vnode.props), children: [] };
          if (vnode.type && vnode.type.__file) node.source = vnode.type.__file;
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
          return { name: 'SvelteRoot', props: {}, children: comps.map(function(k) {
            return { name: k, props: {}, children: [] };
          })};
        }

        // Detect and build
        var framework = 'unknown', tree = null, count = 0;

        // React: walk DOM looking for __reactFiber
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

        // Vue 3
        if (!tree) {
          var vueRoot = document.querySelector('#app') || document.querySelector('[data-v-app]');
          if (vueRoot && vueRoot.__vue_app__) {
            framework = 'vue';
            var vnode = vueRoot.__vue_app__._context && vueRoot.__vue_app__._context.app
              ? vueRoot.__vue_app__._instance && vueRoot.__vue_app__._instance.subTree : null;
            tree = buildVue3Tree(vueRoot.__vue_app__._instance && vueRoot.__vue_app__._instance.subTree, 0);
          }
        }

        // Vue 2
        if (!tree) {
          var vue2Root = document.querySelector('#app');
          if (vue2Root && vue2Root.__vue__) {
            framework = 'vue';
            var vm = vue2Root.__vue__;
            tree = { name: vm.$options.name || 'App', props: safeProps(vm.$props), children: [] };
          }
        }

        // Svelte
        if (!tree) {
          var svelteTree = buildSvelteTree();
          if (svelteTree) { framework = 'svelte'; tree = svelteTree; }
        }

        function countNodes(n) {
          if (!n) return 0;
          return 1 + n.children.reduce(function(s, c) { return s + countNodes(c); }, 0);
        }

        return { framework: framework, tree: tree, nodeCount: countNodes(tree) };
      })()`,
      returnByValue: true
    }) as { result: { value: { framework: string; tree: unknown; nodeCount: number } } };

    const val = result.result.value;
    return {
      tabId,
      url: webContents.getURL(),
      capturedAt: Date.now(),
      framework: (val.framework as import("../../../../packages/shared/src/index.js").ComponentFramework),
      tree: val.tree as import("../../../../packages/shared/src/index.js").ComponentNode | null,
      nodeCount: val.nodeCount ?? 0
    };
}
