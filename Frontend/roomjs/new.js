const STAIR_NODES = [
  'B2.up', 'B2.up1', 'B2.down', 'B2.down1',
  'B4.up', 'B4.up1', 'B4.down', 'B4.down1',
];

function displayName(nodeId) {
  if (!nodeId) return nodeId;
  const cp = connectionPoints[nodeId];
  if (cp && cp.displayName) return cp.displayName;
  return nodeId.replace(/^F\d+_/, '');
}

function prefixedId(rawName) {
  const p = `F${currentFloorNumber}_`;
  return rawName.startsWith(p) ? rawName : p + rawName;
}

const viewerEl = document.getElementById('viewer');

function getViewerSize() {
  // Fall back to window size only if #viewer has no measurable box yet
  // (e.g. before layout/CSS has applied).
  const w = viewerEl?.clientWidth  || window.innerWidth;
  const h = viewerEl?.clientHeight || window.innerHeight;
  return { w, h };
}

const { w: initW, h: initH } = getViewerSize();

const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(60, initW / initH, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(initW, initH);
renderer.setClearColor(0x1a1a1a, 1);
document.getElementById('viewer').appendChild(renderer.domElement);

const ambientLight     = new THREE.AmbientLight(0x404040, 0.6);
scene.add(ambientLight);
const directionalLight = new THREE.DirectionalLight(0xffffff, 1.8);
directionalLight.position.set(0, 1000, 100);
scene.add(directionalLight);

const loader = new THREE.GLTFLoader();
let gltfScene        = null;
let currentModelRoot = null;

const MODELS = [
  { labels: 'Floor 1', file: '../models/floor1.glb' },
  { labels: 'Floor 2', file: '../models/floor2s.glb' },
  { labels: 'Floor 3', file: '../models/floor3.glb' },
  { labels: 'Floor 4', file: '../models/floor4s.glb' },
  { labels: 'Floor 5', file: '../models/floor5s.glb' },
  { labels: 'Floor 6', file: '../models/floor6s.glb' },
];
window.MODELS = MODELS;

let graph            = {};   
let connectionPoints = {};   
let nodes            = [];   

let currentFloorNumber = 1;

let routeFollowRafId   = null;
let movingPin          = null;
let routeFollowPoints  = null;
let routeFollowStartTs = 0;
const routeFollowTotalMs = 6000;
let   routeFloorOrder    = [];   
let   routeSegments      = {};   
let   routeIsFinalFloor  = true; 

// ── 2D / 3D view ────────────────────────────────────────────────────────────
let is2DView = false;
const CAM_3D = { x: 0, y: 920, z: 400 };
const CAM_2D = { x: 0, y: 1200, z: 0.001 }; // near-zero z keeps lookAt stable

function activateFloorData(floorNum) {
  const data = (window.FLOOR_DATA || {})[floorNum];
  if (!data) {
    console.warn(`activateFloorData: no data for floor ${floorNum}`);
    graph            = {};
    connectionPoints = {};
    nodes            = [];
    return;
  }

  currentFloorNumber = floorNum;
  graph              = data.graph            || {};
  connectionPoints   = data.connectionPoints || {};
  nodes              = Array.from(new Set(Object.keys(connectionPoints)));

  rebuildAutocomplete();
}

function getFloorNumberFromURL() {
  const p = (window.location.pathname || '').toLowerCase();
  const m = p.match(/(room|floor)([1-6])\.html/);
  return m ? Number(m[2]) : 1;
}

function setModelByIndex(modelIndex) {
  const idx      = Math.max(0, Math.min(MODELS.length - 1, Number(modelIndex) || 0));
  const floorNum = idx + 1;           

  // keep floor button highlighted while routing switches floors
  window.__highlightActiveFloor?.(floorNum);

  const file     = MODELS[idx]?.file;
  if (!file) return;

  clearAllFloorOverlays();

  if (currentModelRoot) {
    scene.remove(currentModelRoot);
    currentModelRoot = null;
  }
  gltfScene = null;

  activateFloorData(floorNum);

  loader.load(
    file,
    function (gltf) {
      gltfScene        = gltf.scene;
      currentModelRoot = gltf.scene;
      scene.add(gltf.scene);

      const box    = new THREE.Box3().setFromObject(gltf.scene);
      const center = box.getCenter(new THREE.Vector3());
      gltf.scene.position.sub(center);
      camera.position.set(0, 920, box.getSize(new THREE.Vector3()).length() * 1.5);

      gltfScene.traverse((child) => {
        if (child.isMesh) {
          if (child.material?.color) child.originalColor = child.material.color.clone();
          if (child.material)         child.material = child.material.clone();
        }
      });

      highlightConnectionPoints();
      buildFloatingRoomLabels();

      // Restore view mode after floor switch
      if (is2DView) {
        controls.enableRotate  = false;
        controls.maxPolarAngle = Math.PI;
        camera.position.set(CAM_2D.x, CAM_2D.y, CAM_2D.z);
        camera.lookAt(0, 0, 0);
        controls.target.set(0, 0, 0);
        controls.update();
      }

      try {
        const allSegs = sessionStorage.getItem('allFloorSegments');
        if (allSegs) {
          const segsMap    = JSON.parse(allSegs);
              const seg        = segsMap[floorNum];
              // Prefer an explicit route order persisted earlier; otherwise sort ascending
              const storedOrder = sessionStorage.getItem('routeFloorOrder');
              const floorKeys  = storedOrder ? (JSON.parse(storedOrder).map(Number)) : Object.keys(segsMap).map(Number).sort((a, b) => a - b);
              const currentIdx = floorKeys.indexOf(floorNum);
              const isFinal    = currentIdx === floorKeys.length - 1;

          // if (seg && seg.length) {
          //   sessionStorage.setItem('latestPath', JSON.stringify(seg));
          //   routeFloorOrder   = floorKeys;
          //   routeSegments     = segsMap;
          //   routeIsFinalFloor = isFinal;
          //   highlightPath(seg, isFinal);
          //   // Auto-advance to next floor after animation if not on final floor
          //   // (startRouteFollow handles the actual timing via the moveStep callback)
          // }
          routeFloorOrder   = floorKeys;
          routeSegments     = segsMap;
          routeIsFinalFloor = isFinal;

          if (seg && seg.length) {
            // This floor has a path — draw it, pin animation handles next advance
            sessionStorage.setItem('latestPath', JSON.stringify(seg));
            highlightPath(seg, isFinal);
          } else {
            // This floor has NO path — show for 3s then advance
            if (!_advancingFloor) {
              const currentIdx = floorKeys.indexOf(floorNum);
              scheduleFloorAdvance(floorKeys, currentIdx, segsMap);
            }
          }
        } else {
          const latest = sessionStorage.getItem('latestPath');
          if (latest) {
            const path     = JSON.parse(latest);
            const filtered = (path || []).filter((id) => nodes.includes(id));
            if (filtered.length) highlightPath(filtered, true);
          }
        }
      } catch {  }
    },
    undefined,
    function (error) { console.error('GLTFLoader error', error); }
  );
}

window.__setFloorModel = setModelByIndex;

function setModelByFile(file) {
  const idx = MODELS.findIndex((m) => m.file === file);
  setModelByIndex(idx === -1 ? 0 : idx);
}

// setModelByFile(MODELS[Math.max(0, getFloorNumberFromURL() - 1)].file);
function initWhenReady() {
  if (window.FLOOR_DATA && Object.keys(window.FLOOR_DATA).length > 0) {
    setModelByFile(MODELS[Math.max(0, getFloorNumberFromURL() - 1)].file);
  } else {
    // API data not ready yet — retry every 100ms
    setTimeout(initWhenReady, 100);
  }
}

initWhenReady();

function clearAllFloorOverlays() {
  stopRouteFollow();
  for (let i = scene.children.length - 1; i >= 0; i--) {
    const obj = scene.children[i];
    if (!obj) continue;
    const n = obj.name || '';
    if (
      n.startsWith('highlight_') ||
      n.startsWith('floatingAnchor_') ||
      n === 'pathLinesGroup'
    ) {
      scene.remove(obj);
    }
  }
}

// ── Label configuration ──────────────────────────────────────────────────────
const LABEL_OFFSET = { x: 10, y: 10, z: 0 };
const LABEL_EXCLUDE_SUFFIXES = [
  'B2.up', 'B2.up1', 'B2.down', 'B2.down1',
  'B4.up', 'B4.up1', 'B4.down', 'B4.down1',
];

function shouldShowLabel(roomId) {
  const dName = displayName(roomId);
  if (dName.startsWith('Hallway')) return false;
  if (LABEL_EXCLUDE_SUFFIXES.some((s) => dName.endsWith(s))) return false;
  return true;
}

// ── Floating (HTML) room labels ─────────────────────────────────────────────
// Positions come from window.FLOOR_DATA[floor].roomLabels (see seedData.js),
// so each room's label can be repositioned independently of its connection
// point or hallway node, just by editing that array.

let floatingLabelEls = [];
let floatingLabelAnchors = [];

function clearFloatingLabelAnchors() {
  floatingLabelAnchors.forEach((mesh) => scene.remove(mesh));
  floatingLabelAnchors = [];
}

function ensureFloatingLabelsLayer() {
  let layer = document.getElementById('floatingLabelsLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'floatingLabelsLayer';
    layer.style.position = 'absolute';
    layer.style.inset = '0';
    layer.style.pointerEvents = 'none';
    layer.style.zIndex = '5';
    const viewerEl = document.getElementById('viewer') || document.body;
    viewerEl.style.position = viewerEl.style.position || 'relative';
    viewerEl.appendChild(layer);
  }
  return layer;
}

// Rebuilds the floating label DOM (and their anchor spheres) for the current
// floor. Call this whenever the floor changes (already wired into
// setModelByIndex below).
function buildFloatingRoomLabels() {
  const layer = ensureFloatingLabelsLayer();
  layer.innerHTML = '';
  floatingLabelEls = [];
  clearFloatingLabelAnchors();

  const anchorGeometry = new THREE.SphereGeometry(1, 12, 12);

  const floorData = (window.FLOOR_DATA || {})[currentFloorNumber];
  let floorLabels = floorData?.roomLabels;

  if (!floorLabels || !floorLabels.length) {
    // Fallback: window.FLOOR_DATA has no roomLabels for this floor (e.g. the
    // data pipeline serving FLOOR_DATA hasn't picked up the new field yet).
    // Derive a default set from connectionPoints so labels still show.
    console.warn(
      `buildFloatingRoomLabels: no roomLabels for floor ${currentFloorNumber}, falling back to connectionPoints.`
    );
    floorLabels = Object.entries(floorData?.connectionPoints || {})
      .filter(([roomId]) => shouldShowLabel(roomId))
      .map(([roomId, pos]) => ({
        id: roomId,
        x: pos.x,
        y: (pos.y || 0) + LABEL_OFFSET.y,
        z: pos.z || 0,
        offsetLabel: pos.offsetLabel,
      }));
  }

  if (!floorLabels.length) {
    console.warn(`buildFloatingRoomLabels: nothing to show for floor ${currentFloorNumber}.`);
    return;
  }

  floorLabels.forEach((lbl) => {
    // Anchor sphere — a real mesh in the scene that the label is pinned to.
    // Because the label's screen position is projected from THIS mesh's
    // world position every frame (not a raw stored x/y/z), it can never
    // drift or detach from it during orbit/pan/zoom.
    const anchorColor = lbl.color ? new THREE.Color(lbl.color) : new THREE.Color(0x3b6cf6);
    const anchor = new THREE.Mesh(
      anchorGeometry.clone(),
      new THREE.MeshBasicMaterial({ color: anchorColor, transparent: true, opacity: 0.9 })
    );
    anchor.position.set(lbl.x, lbl.y, lbl.z || 0);
    anchor.name = `floatingAnchor_${lbl.id}`;
    scene.add(anchor);
    floatingLabelAnchors.push(anchor);

    // offsetLabel overrides the displayed text without changing which room
    // the label is anchored to (lbl.id still drives positioning/lookups).
    const text = lbl.offsetLabel || lbl.text || displayName(lbl.id) || lbl.id;

    const el = document.createElement('div');
    el.textContent = text;
    el.style.position = 'absolute';
    el.style.transform = 'translate(-50%, -100%)';
    el.style.background = lbl.color || 'rgba(20, 20, 20, 0)';
    el.style.color = '#fff';
    el.style.padding = '3px 9px';
    el.style.borderRadius = '12px';
    el.style.fontSize = '12px';
    el.style.fontWeight = '600';
    el.style.whiteSpace = 'nowrap';
    el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.35)';
    el.style.pointerEvents = 'none';

    // const dot = document.createElement('div');
    // dot.style.position = 'absolute';
    // dot.style.left = '50%';
    // dot.style.top = '100%';
    // dot.style.width = '6px';
    // dot.style.height = '6px';
    // dot.style.marginLeft = '-3px';
    // dot.style.borderRadius = '50%';
    // dot.style.background = lbl.color || '#3b6cf6';
    // el.appendChild(dot);

    layer.appendChild(el);
    floatingLabelEls.push({ el, data: lbl, anchor });
  });
}

const _labelProjectVec = new THREE.Vector3();

// Projects each floating label's anchor's live world position to screen
// space. Called every animate() frame so labels track the camera as you
// orbit/zoom/pan without ever drifting from their anchor sphere.
//
// Labels are plain DOM text with a fixed font-size (see buildFloatingRoomLabels),
// so they always render at the same pixel size on screen no matter how far
// the camera is from the model — zooming in/out only moves their position,
// never their size.
function updateFloatingRoomLabels() {
  if (!floatingLabelEls.length) return;
  const { w, h } = getViewerSize();

  floatingLabelEls.forEach((item) => {
    item.anchor.getWorldPosition(_labelProjectVec);
    _labelProjectVec.project(camera);

    const behindCamera = _labelProjectVec.z > 1;
    item.el.style.display = behindCamera ? 'none' : 'block';
    item.el.style.left = ((_labelProjectVec.x * 0.5 + 0.5) * w) + 'px';
    item.el.style.top = ((-_labelProjectVec.y * 0.5 + 0.5) * h) + 'px';
  });
}

function highlightConnectionPoints() {
  
  clearAllFloorOverlays();

  const sphereGeometry = new THREE.SphereGeometry(0.8, 10, 10);
  const sphereMaterial = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    transparent: true,
    opacity: 0,
  });

  const excludeSuffixes = [
    'B2.up', 'B2.up1', 'B2.down', 'B2.down1',
    'B4.up', 'B4.up1', 'B4.down', 'B4.down1',
  ];

  Object.entries(connectionPoints).forEach(([roomId, pos]) => {
    const sphere = new THREE.Mesh(sphereGeometry.clone(), sphereMaterial.clone());
    sphere.position.set(pos.x, pos.y, pos.z || 0);
    sphere.name = `highlight_${roomId}`;
    scene.add(sphere);
    // Note: in-scene sprite labels removed — room labels now render as
    // floating HTML via buildFloatingRoomLabels()/updateFloatingRoomLabels(),
    // positioned independently from window.FLOOR_DATA[floor].roomLabels.
  });
  
}

function findShortestPath(start, end) {
  if (start === end) return [start];
  if (!nodes.includes(start) || !nodes.includes(end)) return null;

  const queue   = [[start, [start]]];
  const visited = new Set([start]);

  while (queue.length > 0) {
    const [current, path] = queue.shift();
    for (const neighbor of graph[current] || []) {
      if (neighbor === end) return [...path, neighbor];
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([neighbor, [...path, neighbor]]);
      }
    }
  }
  return null;
}

function getConnectionPoint(roomId) {
  
  if (connectionPoints[roomId]) return connectionPoints[roomId];
  
  for (let f = 1; f <= 6; f++) {
    const cp = (window.FLOOR_DATA || {})[f]?.connectionPoints?.[roomId];
    if (cp) return cp;
  }
  return null;
}

function buildMultiFloorGraph(direction) {
  // direction: 'up' | 'down' | null (null = both, for single-floor searches)
  const mega = {};

  for (let f = 1; f <= 6; f++) {
    const data = (window.FLOOR_DATA || {})[f];
    if (!data) continue;
    for (const [node, neighbours] of Object.entries(data.graph)) {
      mega[node] = [...neighbours];
    }
  }

  // Cross-floor stair connections (floor numbers increase going UP).
  // Going UP:   F(n)_B2.up   → F(n+1)_B2.up1   (delta +1)
  //             F(n)_B4.up   → F(n+1)_B4.up1
  // Going DOWN: F(n)_B2.down → F(n-1)_B2.down1  (delta -1)
  //             F(n)_B4.down → F(n-1)_B4.down1
  //
  // Each link is one-directional: from → to only (no reverse).
  // We only add the links that match the requested travel direction so BFS
  // cannot accidentally use "up" stairs when the destination is below, or
  // "down" stairs when the destination is above.
  const upLinks   = [
    { from: 'B2.up',   to: 'B2.up1',   delta: +1 },
    { from: 'B4.up',   to: 'B4.up1',   delta: +1 },
  ];
  const downLinks = [
    { from: 'B2.down', to: 'B2.down1', delta: -1 },
    { from: 'B4.down', to: 'B4.down1', delta: -1 },
  ];

  // Choose which cross-floor links to wire based on travel direction.
  const crossLinks =
    direction === 'up'   ? upLinks   :
    direction === 'down' ? downLinks :
    [...upLinks, ...downLinks];   // null / same-floor fallback

  function megaLinkOneWay(a, b) {
    if (!mega[a]) mega[a] = [];
    if (!mega[b]) mega[b] = [];
    if (!mega[a].includes(b)) mega[a].push(b);
    // intentionally NOT adding b→a so the stair is strictly directional
  }

  // Add intra-floor bridge links so BFS can continue through intermediate floors.
  // When going UP:   landing (B2.up1) → departure (B2.up)  on the same floor
  // When going DOWN: landing (B2.down1) → departure (B2.down) on the same floor
  const intraLinks =
    direction === 'up'   ? [{ landing: 'B2.up1', depart: 'B2.up' }, { landing: 'B4.up1', depart: 'B4.up' }] :
    direction === 'down' ? [{ landing: 'B2.down1', depart: 'B2.down' }, { landing: 'B4.down1', depart: 'B4.down' }] :
    [];

  for (let f = 1; f <= 6; f++) {
    for (const { landing, depart } of intraLinks) {
      const landNode   = `F${f}_${landing}`;
      const departNode = `F${f}_${depart}`;
      const floorData  = (window.FLOOR_DATA || {})[f];
      const landExists   = (mega[landNode]   !== undefined) || floorData?.connectionPoints?.[landNode];
      const departExists = (mega[departNode] !== undefined) || floorData?.connectionPoints?.[departNode];
      if (landExists && departExists) {
        megaLinkOneWay(landNode, departNode);
      }
    }
  }

  for (let f = 1; f <= 6; f++) {
    for (const { from, to, delta } of crossLinks) {
      const destFloor = f + delta;
      if (destFloor < 1 || destFloor > 6) continue;

      const nodeHere       = `F${f}_${from}`;
      const thereFloorData = (window.FLOOR_DATA || {})[destFloor];

      // Resolve the best landing node on the destination floor.
      // Preference order:
      //   1. The canonical landing name  (e.g. F2_B2.down1)
      //   2. The same staircase, any node whose raw name starts with the
      //      staircase prefix (B2 or B4) — catches floors that only have
      //      e.g. B2.up / B2.up1 as their stair entry/exit point.
      const staircasePrefix = from.split('.')[0]; // 'B2' or 'B4'
      const primaryKey      = `F${destFloor}_${to}`;

      const primaryExists =
        (mega[primaryKey] !== undefined) ||
        thereFloorData?.connectionPoints?.[primaryKey];

      let nodeThere = null;
      if (primaryExists) {
        nodeThere = primaryKey;
      } else {
        // Scan destination floor's connectionPoints for any node belonging to
        // the same staircase (B2.* or B4.*)
        const cpKeys = Object.keys(thereFloorData?.connectionPoints || {});
        const match  = cpKeys.find((k) => {
          const raw = k.replace(/^F\d+_/, '');
          return raw.startsWith(staircasePrefix + '.');
        });
        if (match) nodeThere = match;
      }

      if (!nodeThere) continue; // staircase truly absent on dest floor

      // Only link if the origin node also exists
      const hereExists =
        (mega[nodeHere] !== undefined) ||
        (window.FLOOR_DATA || {})[f]?.connectionPoints?.[nodeHere];

      if (hereExists) {
        megaLinkOneWay(nodeHere, nodeThere);
      }
    }
  }

  return mega;
}

function findMultiFloorPath(start, end) {
  if (start === end) return [start];

  // Determine travel direction so we only wire the correct stair nodes.
  const startFloor = Number(start.match(/^F(\d+)_/)?.[1] || 0);
  const endFloor   = Number(end.match(/^F(\d+)_/)?.[1]   || 0);
  const direction  =
    startFloor < endFloor ? 'up'   :
    startFloor > endFloor ? 'down' :
    null;  // same floor — no cross-floor links needed

  const mega = buildMultiFloorGraph(direction);
  if (!mega[start] || !mega[end]) return null;

  const queue   = [[start, [start]]];
  const visited = new Set([start]);

  while (queue.length > 0) {
    const [current, path] = queue.shift();
    for (const neighbor of mega[current] || []) {
      if (neighbor === end) return [...path, neighbor];
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([neighbor, [...path, neighbor]]);
      }
    }
  }
  return null;
}

function groupPathByFloor(path) {
  const segments = {};
  for (const nodeId of path) {
    const m = nodeId.match(/^F(\d+)_/);
    if (!m) continue;
    const f = Number(m[1]);
    if (!segments[f]) segments[f] = [];
    segments[f].push(nodeId);
  }
  return segments;
}

function multiFloorLabel(nodeId, nextNodeId) {
  const m = nodeId.match(/^F(\d+)_(.+)$/);
  if (!m) return nodeId;
  const [, floorNum, rawName] = m;
  if (STAIR_NODES.includes(rawName) && nextNodeId) {
    const nm = nextNodeId.match(/^F(\d+)_/);
    if (nm && nm[1] !== floorNum) {
      return `${rawName} (Floor ${floorNum}→${nm[1]})`;
    }
  }
  
  const cp = (window.FLOOR_DATA || {})[Number(floorNum)]?.connectionPoints?.[nodeId];
  return cp?.displayName || rawName;
}

function buildPathSummary(fullPath) {
  if (!fullPath || fullPath.length === 0) return 'No path found.';
  const parts = [];
  for (let i = 0; i < fullPath.length; i++) {
    const id   = fullPath[i];
    const next = fullPath[i + 1] || null;
    const m    = id.match(/^F(\d+)_(.+)$/);
    if (!m) continue;
    const [, floorNum, rawName] = m;
    const isHall   = rawName.startsWith('Hallway');
    const isStair  = STAIR_NODES.includes(rawName);
    const isStart  = i === 0;
    const isEnd    = i === fullPath.length - 1;
    const isFloorChange = isStair && next && next.match(/^F(\d+)_/)?.[1] !== floorNum;

    if (isStart || isEnd || isFloorChange || (!isHall && !isStair)) {
      parts.push(multiFloorLabel(id, next));
    }
  }
  return parts.join(' → ');
}

function renderFloorStepGuide(fullPath) {
  const el = document.getElementById('floorSteps');
  if (!el) return;

  if (!fullPath || fullPath.length === 0) { el.innerHTML = ''; return; }

  const segments = groupPathByFloor(fullPath);
  const floors   = Object.keys(segments).map(Number).sort((a, b) => a - b);

  let html = '<ol style="margin:0;padding-left:1.2em;">';
  for (let i = 0; i < floors.length; i++) {
    const f    = floors[i];
    const seg  = segments[f];
    const last = seg[seg.length - 1];
    const next = floors[i + 1];

    const firstLabel = multiFloorLabel(seg[0], seg[1]);
    let stepText = `<strong>Floor ${f}:</strong> Start at ${firstLabel}`;

    if (next) {
      
      const stairNode = seg.find(n => STAIR_NODES.includes(n.replace(/^F\d+_/, '')));
      const stairName = stairNode ? stairNode.replace(/^F\d+_/, '') : 'staircase';
      stepText += ` → Take <em>${stairName}</em> to Floor ${next}`;
    } else {
      const destLabel = multiFloorLabel(last, null);
      stepText += ` → Arrive at <strong>${destLabel}</strong>`;
    }

    html += `<li style="margin-bottom:4px;">${stepText}</li>`;
  }
  html += '</ol>';
  el.innerHTML = html;
}

function stopRouteFollow() {
  if (routeFollowRafId !== null) {
    cancelAnimationFrame(routeFollowRafId);
    routeFollowRafId = null;
  }
  routeFollowPoints  = null;
  routeFollowStartTs = 0;
}

function clearPathLines() {
  stopRouteFollow();
  const existing = scene.getObjectByName('pathLinesGroup');
  if (existing) scene.remove(existing);
}

function resetHighlights() {
  if (!gltfScene) return;
  gltfScene.traverse((child) => {
    if (child.isMesh && nodes.includes(child.name) && child.originalColor && child.material?.color) {
      child.material.color.copy(child.originalColor);
    }
  });
}

function createPinMesh(color) {
  const pinGroup = new THREE.Group();

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(2, 16, 16),
    new THREE.MeshBasicMaterial({ color })
  );
  head.position.y = 3.75;
  pinGroup.add(head);

  const point = new THREE.Mesh(
    new THREE.ConeGeometry(2, 8, 16),
    new THREE.MeshBasicMaterial({ color })
  );
  point.position.y = -0.5;
  point.rotateX(Math.PI);
  pinGroup.add(point);

  return pinGroup;
}

function drawPathLines(path, isFinalFloor) {
  clearPathLines();
  if (!path || path.length < 2) return;

  const pathGroup = new THREE.Group();
  pathGroup.name  = 'pathLinesGroup';
  scene.add(pathGroup);

  const yOffset  = 1;
  const points   = [];
  for (const roomId of path) {
    const pt = getConnectionPoint(roomId);
    if (pt) points.push(new THREE.Vector3(pt.x, pt.y + yOffset, pt.z || 0));
  }
  if (points.length < 2) return;

  const startPin = createPinMesh(0x22c55e);
  startPin.position.copy(points[0]);
  startPin.position.y += 4;
  pathGroup.add(startPin);

  const endPin = createPinMesh(0xff0000);
  endPin.position.copy(points[points.length - 1]);
  endPin.position.y += 4;
  pathGroup.add(endPin);

  movingPin          = startPin;
  routeFollowPoints  = points.slice();

  const dashLength   = 2;
  const gapLength    = 2;
  const radius       = 0.5;
  const dashMaterial = new THREE.MeshBasicMaterial({ color: 0x0ea5a4, transparent: true, opacity: 1 });

  for (let i = 0; i < points.length - 1; i++) {
    const segStart    = points[i];
    const segEnd      = points[i + 1];
    const direction   = new THREE.Vector3().subVectors(segEnd, segStart);
    const totalLength = direction.length();
    direction.normalize();

    let dist = 0;
    while (dist < totalLength) {
      const dStart  = segStart.clone().add(direction.clone().multiplyScalar(dist));
      const actual  = Math.min(dashLength, totalLength - dist);
      if (actual > 0) {
        const dEnd = dStart.clone().add(direction.clone().multiplyScalar(actual));
        const geo  = new THREE.CylinderGeometry(radius, radius, actual, 8);
        const mesh = new THREE.Mesh(geo, dashMaterial);
        mesh.position.copy(dStart.clone().add(dEnd).multiplyScalar(0.5));
        mesh.lookAt(dEnd);
        mesh.rotateX(Math.PI / 2);
        pathGroup.add(mesh);
      }
      dist += dashLength + gapLength;
    }
  }

  startRouteFollow(points, isFinalFloor !== false); 
}

function startRouteFollow(points, isFinalFloor) {
  stopRouteFollow();
  if (!movingPin || !points || points.length < 2) return;

  const routePoints = points.slice();

  const destId = window.__lastRouteDestId || null;

  const segLengths  = [];

  let   totalLen    = 0;
  for (let i = 0; i < routePoints.length - 1; i++) {
    const len = routePoints[i].distanceTo(routePoints[i + 1]);
    segLengths.push(len);
    totalLen += len;
  }

  routeFollowStartTs = performance.now();

  const moveStep = (ts) => {
    if (!movingPin) return;   

    const elapsed    = ts - routeFollowStartTs;
    const t          = Math.min(1, elapsed / routeFollowTotalMs);
    const targetDist = totalLen * t;

    let accum = 0;
    for (let i = 0; i < segLengths.length; i++) {
      const next = accum + segLengths[i];
      if (targetDist <= next || i === segLengths.length - 1) {
        const localT = segLengths[i] === 0
          ? 0
          : Math.min(1, (targetDist - accum) / segLengths[i]);
        movingPin.position.copy(
          routePoints[i].clone().lerp(routePoints[i + 1] ?? routePoints[i], localT)
        );
        break;
      }
      accum = next;
    }

    if (t < 1) {
      
      routeFollowRafId = requestAnimationFrame(moveStep);
    } else {
      
      movingPin.position.copy(routePoints[routePoints.length - 1]);

      if (isFinalFloor) {
        stopRouteFollow();
        const destLabel = getRouteDestLabel();
        // showRouteModal('Destination reached', destLabel ? `You have arrived at ${destLabel}.` : 'You have arrived at your destination.');

      } else {
        stopRouteFollow();
        const currentIdx = routeFloorOrder.indexOf(currentFloorNumber);
        const nextFloor  = routeFloorOrder[currentIdx + 1];
        if (nextFloor) {
          // Animation just finished on stair — switch immediately, no pause
          setModelByIndex(nextFloor - 1);
        }
      }
    }
  };

  movingPin.position.copy(points[0]);
  routeFollowRafId = requestAnimationFrame(moveStep);
}

function getRouteDestLabel() {
  const destId = window.__lastRouteDestId;
  if (!destId) return '';
  return displayName(destId);
}


function showRouteModal(title, message) {
  const modal = document.getElementById('routeModal');
  const modalTitle = document.getElementById('routeModalTitle');
  const modalBody = document.getElementById('routeModalBody');
  const closeBtn = document.getElementById('routeModalClose');
  const okBtn = document.getElementById('routeModalOk');

  if (!modal || !modalTitle || !modalBody) {
    alert(`${title}: ${message}`);
    return;
  }

  modalTitle.textContent = title || 'Message';
  modalBody.textContent = message || '';

  modal.style.display = 'block';
  modal.setAttribute('aria-hidden', 'false');

  const hide = () => {
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  };

  modal.removeEventListener('click', routeModalBackdropHandler);
  modal.removeEventListener('click', routeModalBackdropHandler);

  window.routeModalBackdropHandler = (e) => {
    if (e.target === modal) hide();
  };

  modal.addEventListener('click', window.routeModalBackdropHandler);

  okBtn?.addEventListener('click', hide, { once: true });
  closeBtn?.addEventListener('click', hide, { once: true });
}

function highlightPath(path, isFinalFloor) {

  resetHighlights();
  clearPathLines();

  if (!path || path.length === 0) {
    const el = document.getElementById('pathInfo');
    if (el) el.textContent = 'No path found.';
    return;
  }

  path.forEach((room) => {
    const obj = gltfScene?.getObjectByName(room);
    if (obj?.isMesh && obj.material?.color) obj.material.color.set();
  });

  drawPathLines(path, isFinalFloor);
  const el = document.getElementById('pathInfo');
  if (el) el.textContent = `Shortest path: ${path.map(displayName).join(' → ')}`;
}

// ── Camera animation helper ──────────────────────────────────────────────────
function animateCamera(targetPos, targetLook, duration) {
  const startPos  = camera.position.clone();
  const startLook = controls.target.clone();
  const startTime = performance.now();

  function step(now) {
    const t    = Math.min((now - startTime) / duration, 1);
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    camera.position.lerpVectors(startPos, targetPos, ease);
    controls.target.lerpVectors(startLook, targetLook, ease);
    controls.update();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── 2D / 3D toggle ───────────────────────────────────────────────────────────
function toggleView() {
  is2DView = !is2DView;
  const btn = document.getElementById('viewToggle');

  if (is2DView) {
    controls.enableRotate     = false;
    controls.maxPolarAngle    = Math.PI;   // unlock so top-down works
    animateCamera(
      new THREE.Vector3(CAM_2D.x, CAM_2D.y, CAM_2D.z),
      new THREE.Vector3(0, 0, 0),
      600
    );
    if (btn) {
      btn.title = 'Switch to 3D view';
      btn.style.background = 'rgba(255,255,255,0.25)';
    }
  } else {
    controls.enableRotate  = true;
    controls.maxPolarAngle = Math.PI / 2;
    animateCamera(
      new THREE.Vector3(CAM_3D.x, CAM_3D.y, CAM_3D.z),
      new THREE.Vector3(0, 0, 0),
      600
    );
    if (btn) {
      btn.title = 'Switch to 2D view';
      btn.style.background = '';
    }
  }
}

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping     = true;
controls.dampingFactor     = 0.05;
controls.screenSpacePanning = false;
controls.minDistance       = 1;
controls.maxDistance       = 500;
controls.maxPolarAngle     = Math.PI / 2;

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updateFloatingRoomLabels();
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  const { w, h } = getViewerSize();
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

// Add the display names you want hidden from the search dropdown here.
// Matching is case-sensitive and must match the displayed room name exactly.
const HIDDEN_NAMES = [
  'Registrar',
  'Accounting',
  // 'Storage Room',
  // 'Janitor Closet',
];

// Builds a grouped <select> (optgroups) for window-style nodes like
// "Registrar_Win1", "Accounting_Win9" — grouped by the text before "_Win".
// Call this once a select exists in the DOM, e.g.:
//   <select id="winSelect"><option value="">-- choose a window --</option></select>
function rebuildWindowDropdown(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;

  // Keep the first placeholder option, clear the rest
  const placeholder = select.querySelector('option[value=""]');
  select.innerHTML = '';
  if (placeholder) select.appendChild(placeholder);
  else {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '-- choose a window --';
    select.appendChild(opt);
  }

  // groups: { Registrar: [{nodeId, floor, label}], Accounting: [...] }
  const groups = {};

  for (let f = 1; f <= 6; f++) {
    const data = (window.FLOOR_DATA || {})[f];
    if (!data) continue;

    Object.keys(data.connectionPoints).forEach((nodeId) => {
      const m = nodeId.match(/^(.+)_Win(\d+)$/); // e.g. "Registrar_Win12"
      if (!m) return;
      const [, prefix, num] = m;

      if (!groups[prefix]) groups[prefix] = [];
      groups[prefix].push({ nodeId, floor: f, num: Number(num) });
    });
  }

  Object.keys(groups).sort().forEach((prefix) => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = prefix;

    groups[prefix]
      .sort((a, b) => a.num - b.num)
      .forEach(({ nodeId, floor, num }) => {
        const opt = document.createElement('option');
        opt.value = nodeId;          // e.g. "Registrar_Win12" (use as-is when matching connectionPoints)
        opt.dataset.floor = floor;
        opt.textContent = `Win ${num}`;
        optgroup.appendChild(opt);
      });

    select.appendChild(optgroup);
  });
}

function rebuildAutocomplete() {
  rebuildWindowDropdown('fromWinSelect');
  rebuildWindowDropdown('toWinSelect');

  let datalist = document.getElementById('roomList');
  if (!datalist) {
    datalist    = document.createElement('datalist');
    datalist.id = 'roomList';
    document.body.appendChild(datalist);
  }
  datalist.innerHTML = '';

  const seen = new Set();

  for (let f = 1; f <= 6; f++) {
    const data = (window.FLOOR_DATA || {})[f];
    if (!data) continue;

    Object.entries(data.connectionPoints).forEach(([nodeId, pos]) => {
      const dName = pos.displayName || nodeId.replace(/^F\d+_/, '');
      if (dName.startsWith('Hallway')) return;
      if (STAIR_NODES.some(s => dName === s || dName.endsWith(s))) return;
      if (dName === 'Entrance' || dName === 'Exit') return;
      if (HIDDEN_NAMES.includes(dName)) return;

      const key = `${dName}|F${f}`;
      if (seen.has(key)) return;
      seen.add(key);

      const opt         = document.createElement('option');
      opt.value         = dName;
      opt.dataset.id    = nodeId;
      opt.dataset.floor = f;
      datalist.appendChild(opt);
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  
  rebuildAutocomplete();

  const fromInput = document.getElementById('fromInput');
  const toInput   = document.getElementById('toInput');

  fromInput?.setAttribute('list', 'roomList');
  toInput?.setAttribute('list',   'roomList');

  const fromWinSelect = document.getElementById('fromWinSelect');
  const toWinSelect   = document.getElementById('toWinSelect');

  function fillInputFromWindowSelect(select, input) {
    select?.addEventListener('change', () => {
      if (!select.value) return; // placeholder selected, do nothing
      const nodeId = select.value;
      const dName  = nodeId.replace(/^F\d+_/, '');
      if (input) input.value = dName;
    });
  }
  fillInputFromWindowSelect(fromWinSelect, fromInput);
  fillInputFromWindowSelect(toWinSelect, toInput);

  try {
    const saved = sessionStorage.getItem('multiFloorPath');
    if (saved) {
      const fullPath = JSON.parse(saved);
      if (Array.isArray(fullPath) && fullPath.length) {
        applyMultiFloorPath(fullPath);
        const destFloor = Number((fullPath[fullPath.length - 1].match(/^F(\d+)_/) || [])[1] || 1);
        window.__highlightActiveFloor?.(destFloor);  // in case we reload different floor
      }
    }
  } catch {  }

  document.getElementById('reset')?.addEventListener('click', () => {
    if (fromInput) fromInput.value = '';
    if (toInput)   toInput.value   = '';
    if (fromWinSelect) fromWinSelect.value = '';
    if (toWinSelect)   toWinSelect.value   = '';
    const info = document.querySelector('.info');
    if (info) info.textContent = 'Enter From and To rooms, then search.';
    const pathInfo = document.getElementById('pathInfo');
    if (pathInfo) pathInfo.textContent = '';
    const stepsEl = document.getElementById('floorSteps');
    if (stepsEl) stepsEl.innerHTML = '';
    resetHighlights();
    clearPathLines();
    sessionStorage.removeItem('multiFloorPath');
    sessionStorage.removeItem('latestPath');
    sessionStorage.removeItem('allFloorSegments');
    routeFloorOrder   = [];
    routeSegments     = {};
    routeIsFinalFloor = true;
  });

  document.getElementById('viewToggle')?.addEventListener('click', toggleView);
  document.getElementById('searchBtn')?.addEventListener('click', runSearch);
  toInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') runSearch();
  });
});

function runSearch() {
  const fromInput = document.getElementById('fromInput');
  const toInput   = document.getElementById('toInput');
  const rawFrom   = fromInput?.value.trim();
  const rawTo     = toInput?.value.trim();

  if (!rawFrom || !rawTo) { alert('Please enter both From and To rooms.'); return; }

  // Prefer a match on the current floor, then fall back to other floors
  let from = null;
  const fromOrder = [currentFloorNumber, 1,2,3,4,5,6].filter((v, i, a) => a.indexOf(v) === i);
  for (let f of fromOrder) {
    const candidate = `F${f}_${rawFrom}`;
    if ((window.FLOOR_DATA || {})[f]?.connectionPoints?.[candidate]) {
      from = candidate;
      break;
    }
  }
  
  if (!from && rawFrom.toLowerCase() === 'entrance') from = 'F1_Entrance';

  if (!from) {
    alert(`Starting room "${rawFrom}" was not found on any floor. Please check the spelling.`);
    return;
  }

  let to = null;
  const toOrder = [currentFloorNumber, 1,2,3,4,5,6].filter((v, i, a) => a.indexOf(v) === i);
  for (let f of toOrder) {
    const candidate = `F${f}_${rawTo}`;
    if ((window.FLOOR_DATA || {})[f]?.connectionPoints?.[candidate]) {
      to = candidate;
      break;
    }
  }
  if (!to && rawTo.toLowerCase() === 'entrance') to = 'F1_Entrance';

  if (!to) {
    alert(`Destination room "${rawTo}" was not found on any floor. Please check the spelling.`);
    return;
  }

  if (from === to) {
    alert('Your starting room and destination are the same!');
    return;
  }

  const fullPath = findMultiFloorPath(from, to);

  if (!fullPath || fullPath.length === 0) {
    const pathInfo = document.getElementById('pathInfo');
    if (pathInfo) pathInfo.textContent = `No path found between "${rawFrom}" and "${rawTo}".`;
    return;
  }

  _advancingFloor = false;
  sessionStorage.setItem('multiFloorPath', JSON.stringify(fullPath));
  applyMultiFloorPath(fullPath);
}

function applyMultiFloorPath(fullPath) {
  const startId    = fullPath[0];
  const destId     = fullPath[fullPath.length - 1];
  const startFloor = Number(startId.match(/^F(\d+)_/)?.[1] || 1);
  const destFloor  = Number(destId.match(/^F(\d+)_/)?.[1] || 1);
  const segments   = groupPathByFloor(fullPath);

  // Persist segments and an explicit traversal order (ascending or descending)
  sessionStorage.setItem('allFloorSegments', JSON.stringify(segments));

  const pathInfo = document.getElementById('pathInfo');
  if (pathInfo) {
    const summary  = buildPathSummary(fullPath);
    // Show floors in traversal order (descend if start>dest)
    const floorKeys = Object.keys(segments).map(Number);
    const shouldAsc = startFloor <= destFloor;
    const floors = floorKeys.sort((a, b) => shouldAsc ? a - b : b - a);
    const floorTag = floors.length > 1
      ? ` [Floors ${floors.join('→')}]`
      : ` [Floor ${floors[0]}]`;
    pathInfo.textContent = summary + floorTag;
  }

  // Save destination so we can show it when the animation finishes (final floor)
  window.__lastRouteDestId = destId;

  // Start label (From room)
  window.__lastRouteStartId = startId;

  // showRouteModal('Route started', `From ${displayName(startId)}. Destination: ${displayName(destId)}.`);

  renderFloorStepGuide(fullPath);

  window.__highlightActiveFloor?.(destFloor);

  // Get all floors involved in traversal order (descend if startFloor>destFloor)
  const floorOrder = Object.keys(segments).map(Number);
  const asc = startFloor <= destFloor;
  floorOrder.sort((a, b) => asc ? a - b : b - a);
  routeFloorOrder  = floorOrder;
  // Persist traversal order so reloads can respect direction
  sessionStorage.setItem('routeFloorOrder', JSON.stringify(floorOrder));
  routeSegments    = segments;

  // Always start from the first floor in the route
  const firstFloor  = floorOrder[0];
  const isFinal     = floorOrder.length === 1;
  routeIsFinalFloor = isFinal;

  const firstSeg = segments[firstFloor] || [];
  sessionStorage.setItem('latestPath', JSON.stringify(firstSeg));

  if (currentFloorNumber !== firstFloor) {
    setModelByIndex(firstFloor - 1);
  } else {
    highlightPath(firstSeg, isFinal);
  }
}

let _advancingFloor = false;

function scheduleFloorAdvance(floorOrder, currentIdx, segments) {
  const nextIdx = currentIdx + 1;
  if (nextIdx >= floorOrder.length) return;
  if (_advancingFloor) return; // guard against double calls
  _advancingFloor = true;

  const nextFloor = floorOrder[nextIdx];
  const isFinal   = nextIdx === floorOrder.length - 1;
  const seg       = segments[nextFloor] || [];

  if (seg.length) {
    // Next floor has a path — switch immediately, pin animation handles the rest
    routeIsFinalFloor = isFinal;
    sessionStorage.setItem('latestPath', JSON.stringify(seg));
    _advancingFloor = false;
    setModelByIndex(nextFloor - 1);
  } else {
    // Passing floor — show for 3s then advance to the one after
    routeIsFinalFloor = isFinal;
    setModelByIndex(nextFloor - 1);
    setTimeout(() => {
      _advancingFloor = false;
      scheduleFloorAdvance(floorOrder, nextIdx, segments);
    }, 3000);
  }
}
