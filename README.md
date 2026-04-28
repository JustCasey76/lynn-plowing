# Lynn Plowing — Scenario Optimizer

Browser-based snow-plow route scenario optimizer for Lynn, MA.

- **Map**: Leaflet + OpenStreetMap tiles
- **Roads**: live Lynn road network from the Overpass API
- **Engine**: clustering (grid / k-means / priority-weighted), assignment (round-robin / capacity-balanced / priority-first), routing (nearest-neighbor + 2-opt)
- **Side nav**: ranked scenarios with replay, pin, export, and Compare Top 3

Results are labelled "best simulated scenarios," not a proven mathematical optimum.

## Run locally

```bash
npm install
npm start
# open http://localhost:8000
```

## Deploy to Railway

Railway auto-detects `package.json` and runs `npm start`. The app serves static files on `$PORT`.
