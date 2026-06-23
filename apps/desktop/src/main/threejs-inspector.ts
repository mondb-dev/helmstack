import type { WebContents } from "electron";

import type { ThreeSceneReport, TabId } from "../../../../packages/shared/src/index.js";

/**
 * Three.js scene inspector — probes a live renderer/scene without app-side
 * instrumentation, walks the scene graph, reads renderer draw-call stats, and
 * estimates FPS via a short rAF sample. Extracted from `TabManager`. Assumes the
 * CDP debugger is already attached.
 */
export async function captureThreeScene(webContents: WebContents, tabId: TabId): Promise<ThreeSceneReport> {
  const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
    expression: `(function() {
      // ── Helpers ────────────────────────────────────────────────────────
      function hex(c) {
        try { return '#' + c.getHexString(); } catch(e) { return null; }
      }
      function v3(v) {
        return v ? { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) } : null;
      }
      function euler(e) {
        return e ? { x: +e.x.toFixed(4), y: +e.y.toFixed(4), z: +e.z.toFixed(4), order: e.order } : null;
      }

      function matInfo(m) {
        if (!m) return null;
        return {
          uuid: m.uuid || '', type: m.type || 'Material', name: m.name || '',
          color: m.color ? hex(m.color) : null,
          transparent: !!m.transparent, opacity: m.opacity != null ? m.opacity : 1,
          wireframe: !!m.wireframe, side: m.side != null ? m.side : 0,
          depthWrite: m.depthWrite != null ? m.depthWrite : true
        };
      }

      function geoInfo(g) {
        if (!g) return null;
        var pos = g.attributes && g.attributes.position;
        var idx = g.index;
        return {
          uuid: g.uuid || '', type: g.type || 'BufferGeometry',
          vertexCount: pos ? pos.count : 0,
          indexCount: idx ? idx.count : 0,
          attributes: g.attributes ? Object.keys(g.attributes) : []
        };
      }

      function objInfo(obj, depth) {
        if (!obj || depth > 8) return null;
        var type = obj.type || 'Object3D';
        var node = {
          uuid: obj.uuid || '', name: obj.name || '', type: type,
          visible: obj.visible !== false,
          castShadow: !!obj.castShadow, receiveShadow: !!obj.receiveShadow,
          position: v3(obj.position), rotation: euler(obj.rotation), scale: v3(obj.scale),
          children: []
        };

        // Geometry
        if (obj.geometry) node.geometry = geoInfo(obj.geometry);

        // Materials (single or array)
        if (obj.material) {
          var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          node.materials = mats.map(matInfo).filter(Boolean);
        }

        // Lights
        var isLight = obj.isLight || type.endsWith('Light');
        if (isLight) {
          node.lightProps = {
            intensity: obj.intensity != null ? obj.intensity : 1,
            color: obj.color ? hex(obj.color) : '#ffffff',
            castShadow: !!obj.castShadow,
            distance: obj.distance,
            angle: obj.angle
          };
        }

        // Cameras
        var isCamera = obj.isCamera || type.endsWith('Camera');
        if (isCamera) {
          node.cameraProps = {
            fov: obj.fov, near: obj.near, far: obj.far, zoom: obj.zoom != null ? obj.zoom : 1
          };
        }

        // InstancedMesh
        if (obj.isInstancedMesh) node.instanceCount = obj.count;

        // Recurse children
        if (obj.children && depth < 8) {
          for (var i = 0; i < obj.children.length; i++) {
            var child = objInfo(obj.children[i], depth + 1);
            if (child) node.children.push(child);
          }
        }
        return node;
      }

      // ── Locate renderer ────────────────────────────────────────────────
      var renderer = null;
      var scene = null;

      // Common patterns devs use to expose renderer
      var candidates = [
        window.__threeRenderer, window.renderer, window.threeRenderer,
        window.__three && window.__three.renderer,
        window.app && window.app.renderer,
        window.experience && window.experience.renderer && window.experience.renderer.instance
      ].filter(Boolean);

      // Fallback: scan canvas elements for __threeRenderer__ property set by Three.js devtools
      if (!candidates.length) {
        var canvases = document.querySelectorAll('canvas');
        for (var c of canvases) {
          if (c.__threeRenderer__) { candidates.push(c.__threeRenderer__); break; }
        }
      }

      for (var r of candidates) {
        if (r && (r.isWebGLRenderer || r.render)) { renderer = r; break; }
      }

      // Locate scene
      var sceneCandidates = [
        window.__threeScene, window.scene, window.threeScene,
        window.__three && window.__three.scene,
        window.app && window.app.scene,
        window.experience && window.experience.scene
      ].filter(Boolean);

      for (var s of sceneCandidates) {
        if (s && (s.isScene || s.type === 'Scene')) { scene = s; break; }
      }

      if (!renderer && !scene) {
        return { detected: false, scene: null, renderer: null, fps: null, materials: [], summary: null };
      }

      // ── Renderer info ──────────────────────────────────────────────────
      var rendererInfo = null;
      if (renderer && renderer.info) {
        var ri = renderer.info;
        rendererInfo = {
          drawCalls: (ri.render && ri.render.calls) || 0,
          triangles:  (ri.render && ri.render.triangles) || 0,
          points:     (ri.render && ri.render.points) || 0,
          lines:      (ri.render && ri.render.lines) || 0,
          programs:   (ri.programs && ri.programs.length) || 0,
          geometries: (ri.memory && ri.memory.geometries) || 0,
          textures:   (ri.memory && ri.memory.textures) || 0
        };
      }

      // ── Scene graph ────────────────────────────────────────────────────
      var sceneNode = scene ? objInfo(scene, 0) : null;

      // ── Collect all unique materials ───────────────────────────────────
      var matMap = {};
      function collectMats(node) {
        if (!node) return;
        if (node.materials) { for (var m of node.materials) { if (m) matMap[m.uuid] = m; } }
        for (var ch of node.children) collectMats(ch);
      }
      collectMats(sceneNode);
      var allMats = Object.values(matMap);

      // ── Summary counters ───────────────────────────────────────────────
      var totalObj = 0, meshes = 0, lights = 0, cameras = 0, verts = 0, tris = 0;
      function summarise(node) {
        if (!node) return;
        totalObj++;
        var t = node.type;
        if (t === 'Mesh' || t === 'SkinnedMesh' || t === 'InstancedMesh') meshes++;
        if (t.endsWith('Light')) lights++;
        if (t.endsWith('Camera')) cameras++;
        if (node.geometry) { verts += node.geometry.vertexCount; tris += Math.floor(node.geometry.indexCount / 3) || Math.floor(node.geometry.vertexCount / 3); }
        for (var ch of node.children) summarise(ch);
      }
      summarise(sceneNode);

      return {
        detected: true,
        scene: sceneNode,
        renderer: rendererInfo,
        fps: null,   // filled separately via rAF sample below
        materials: allMats,
        summary: {
          totalObjects: totalObj, meshCount: meshes, lightCount: lights, cameraCount: cameras,
          materialCount: allMats.length, uniqueMaterialCount: allMats.length,
          totalVertices: verts, totalTriangles: tris
        }
      };
    })()`,
    returnByValue: true,
    awaitPromise: false
  }) as { result: { value: Record<string, unknown> } };

  // FPS estimate via a short rAF sample (100ms window)
  const fpsResult = await webContents.debugger.sendCommand("Runtime.evaluate", {
    expression: `new Promise(function(resolve) {
      var t0 = performance.now(); var frames = 0;
      function tick() {
        frames++;
        if (performance.now() - t0 < 300) { requestAnimationFrame(tick); }
        else { resolve({ fps: Math.round(frames / ((performance.now() - t0) / 1000)), framesSampled: frames }); }
      }
      requestAnimationFrame(tick);
    })`,
    returnByValue: true,
    awaitPromise: true
  }) as { result: { value: { fps: number; framesSampled: number } | null } };

  const val = result.result.value as ThreeSceneReport & { detected: boolean };
  const fpsVal = fpsResult.result.value ?? null;

  return {
    tabId,
    url: webContents.getURL(),
    capturedAt: Date.now(),
    detected: val.detected ?? false,
    scene: (val.scene ?? null) as ThreeSceneReport["scene"],
    renderer: (val.renderer ?? null) as ThreeSceneReport["renderer"],
    fps: fpsVal ? { fps: fpsVal.fps, framesSampled: fpsVal.framesSampled } : null,
    materials: (val.materials ?? []) as ThreeSceneReport["materials"],
    summary: (val.summary ?? {
      totalObjects: 0, meshCount: 0, lightCount: 0, cameraCount: 0,
      materialCount: 0, uniqueMaterialCount: 0, totalVertices: 0, totalTriangles: 0
    }) as ThreeSceneReport["summary"]
  };
}
