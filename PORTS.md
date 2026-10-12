# Local ports

Otter's local stack reserves these ports on `localhost`:

| Port    | Service                          | Notes                                  |
| ------- | -------------------------------- | -------------------------------------- |
| `5173`  | **App UI** (Vite dev server)     | 👉 open this one: http://localhost:5173 |
| `8000`  | Backend API (FastAPI/uvicorn)    | Google OAuth callback lives here       |
| `3000`  | Electric sync service            | container                              |
| `54321` | Postgres (source of truth)       | container; maps to 5432 inside         |

## Launching without remembering the port

- **Double-click `scripts/otter.command`** in Finder — it boots the stack and
  opens the app automatically. Drag it to the Dock for a one-click icon.
- Or **install the app as a desktop app** so it gets its own Dock icon:
  - Chrome/Edge: open http://localhost:5173 → ⋮ menu → *Cast, save, and share* →
    *Install page as app*.
  - Safari (macOS Sonoma+): open the URL → *File → Add to Dock*.
- Or add a shell alias (`~/.zshrc`): `alias otter='~/Documents/my-super-app/scripts/otter.command'`
  then just run `otter`.

## Avoiding port collisions with future apps

The ports above are effectively "taken" while Otter is a project you keep. To
stop a future app from fighting over them:

1. **Give each project its own port block** and write it down here / in that
   project's own `PORTS.md`. A simple convention that scales:
   | Project | UI   | API  | infra range |
   | ------- | ---- | ---- | ----------- |
   | Otter   | 5173 | 8000 | 3000, 54321 |
   | (next)  | 5273 | 8100 | 3100, 54322 |
   Bump each project by +100 so nothing overlaps.

2. **Make dev servers fail loudly, not drift silently.** Vite by default hunts
   for the next free port if 5173 is busy — which is exactly how you end up not
   knowing which port an app is on. Pin it instead so a collision is obvious:
   in `frontend/vite.config.ts`, set `server: { port: 5173, strictPort: true }`.
   Do the same per project with its assigned port.

3. **Only one stack's containers run at a time** unless you renamed them —
   `docker compose` here names them `otter-postgres` / `otter-electric` and binds
   fixed host ports, so a second project reusing this compose file would clash.
   Give each project distinct container names and host ports.

4. **Check what's on a port** before assuming it's free: `lsof -i :5173`.
