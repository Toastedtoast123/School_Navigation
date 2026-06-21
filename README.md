# Campus Navigation — Backend

Node.js + Express + SQLite backend for the ICCT School Navigation System.

---

## Project Structure

```
campus-nav-backend/
├── server.js                    ← Entry point (Express app)
├── package.json
├── data/
│   └── campus.db                ← SQLite database (auto-created on first run)
├── public/
│   └── roomjs/
│       └── floorRoutingData.API.js  ← Frontend API integration snippet
└── src/
    ├── db/
    │   ├── database.js          ← DB setup + seeder
    │   └── seedData.js          ← Your floor graph data (floors 1 & 2 included)
    └── routes/
        ├── floors.js            ← GET /api/floors
        ├── rooms.js             ← GET /api/rooms, GET /api/rooms/graph/:floor
        └── route.js             ← GET /api/route?from=X&to=Y
```

---

## Setup

### 1. Install dependencies

```bash
cd campus-nav-backend
npm install
```

### 2. Add remaining floor data

Open `src/db/seedData.js` and add floors 3–6 following the same pattern as floors 1 and 2. The data is already in your original `floorRoutingData.js` file.

### 3. Start the server

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

Server starts at **http://localhost:3000**

---

## API Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET | `/api/health` | Server health check |
| GET | `/api/floors` | All floors (id, label, model_file) |
| GET | `/api/rooms` | All navigable rooms |
| GET | `/api/rooms?floor=1` | Rooms on floor 1 only |
| GET | `/api/rooms/graph/1` | Full graph + connection points for floor 1 |
| GET | `/api/route?from=Library&to=Admission` | Find shortest path between two rooms |

### Example: Find a route

```
GET http://localhost:3000/api/route?from=Library&to=Admission
```

Response:
```json
{
  "from": "F1_Library",
  "to": "F1_Admission",
  "path": ["F1_Library", "F1_Hallway12b", "F1_Hallway12a", "..."],
  "steps": [
    { "nodeId": "F1_Library", "displayName": "Library", "floor": 1, "x": 188, "y": 0, "z": -115 },
    ...
  ],
  "segments": { "1": ["F1_Library", "F1_Hallway12b", "..."] },
  "floors": [1]
}
```

---

## Connecting the Frontend

1. Copy `public/roomjs/floorRoutingData.API.js` into your frontend's `roomjs/` folder.

2. In `room1.html` (and all other room pages), swap the script tag:

```html
<!-- OLD -->
<script src="../roomjs/floorRoutingData.js"></script>

<!-- NEW -->
<script src="../roomjs/floorRoutingData.API.js"></script>
```

3. Keep `floorRoutingData.js` as a fallback — the API script falls back to it automatically if the server is unreachable.

---

## Database

The SQLite file lives at `data/campus.db` and is created automatically on first run. Tables:

- **floors** — floor metadata (id, label, model_file)
- **rooms** — all nodes with coordinates and display names
- **edges** — graph connections between nodes

To reset and re-seed the database, delete `data/campus.db` and restart the server.

---

## Deployment (school server / shared hosting)

If you have a Linux server:

```bash
# Install Node.js (if not present)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Clone / upload your project, then:
npm install --production
npm start

# Keep it running with PM2
npm install -g pm2
pm2 start server.js --name campus-nav
pm2 save
```
# School_Navigation
