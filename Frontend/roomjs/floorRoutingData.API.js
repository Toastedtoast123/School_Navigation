(async function () {
  const API_BASE = 'https://school-navigation-volg.onrender.com/api';

  const FLOOR_DATA = {};

  try {
    const floorNums = [1, 2, 3, 4, 5, 6];
    const results   = await Promise.all(
      floorNums.map(f =>
        fetch(`${API_BASE}/rooms/graph/${f}`).then(r => r.json())
      )
    );

    for (const data of results) {
      if (!data.floor) continue;

      // Normalise connectionPoints so every entry has a displayName
      // new.js displayName() checks cp.displayName — must be set correctly
      const normCP = {};
      for (const [nodeId, pos] of Object.entries(data.connectionPoints || {})) {
        normCP[nodeId] = {
          x: pos.x,
          y: pos.y,
          z: pos.z || 0,
          // displayName = clean name without the F1_ prefix
          displayName: pos.displayName || nodeId.replace(/^F\d+_/, ''),
          // optional custom text shown instead of the room id/displayName
          offsetLabel: pos.offsetLabel,
        };
      }

      // Normalise graph so neighbour IDs are always prefixed (F1_Library etc.)
      const normGraph = {};
      for (const [fromId, neighbours] of Object.entries(data.graph || {})) {
        normGraph[fromId] = neighbours;
      }

      FLOOR_DATA[data.floor] = {
        graph:            normGraph,
        connectionPoints: normCP,
        roomLabels:       data.roomLabels || [],
      };
    }

    window.FLOOR_DATA = FLOOR_DATA;
    console.log('✅  Floor data loaded from API');

  } catch (err) {
    console.error('❌  Could not load floor data from API — falling back to static file.', err);
  }

  window.findRouteViaAPI = async function (fromDisplay, toDisplay) {
    const url = `${API_BASE}/route?from=${encodeURIComponent(fromDisplay)}&to=${encodeURIComponent(toDisplay)}`;
    const res  = await fetch(url);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Route API error');
    }
    return res.json();
  };
})();
