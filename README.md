# p_wiz — WiZ light control plane

Mobile-style web UI + UDP control plane for WiZ smart lights. No dependencies — node core modules only (`dgram` + `http` + `fs`).

## Features

- **Devices** — rooms with nested lights: tap name/title to toggle, fat brightness slider, color popup (2D field, presets, ❤ favorites, CCT whites), per-room + per-device scenes
- **Scenes** — reusable timed color/off sequences (e.g. red 1s → off 2s → blue 2s, loop), server-side player keeps running with UI closed, drag-to-reorder steps
- **Settings → Sync** — pull hardware identity (`getSystemConfig`: mac, numeric `roomId`, module, firmware) + friendly names from the WiZ app export
- Names/rooms always derive from WiZ (hardware ids + export labels) — no manual mapping in the UI

## Run (docker, port 10000)

```sh
docker build -t p_wiz .
docker run -d --name p_wiz --restart unless-stopped --network host \
  -v $PWD/server/lights.json:/app/server/lights.json \
  -v $PWD/server/scenes.json:/app/server/scenes.json \
  p_wiz
# → http://<host>:10000/
```

`--network host` is required: UDP broadcast discovery (port 38899) cannot reach LAN bulbs from a bridged network. The two JSON bind mounts keep lights cache + scenes across recreates. HTTP only, no TLS.

## Run (bare node)

```sh
PORT=10000 node server/index.js
```

## Env

| var | default | notes |
|---|---|---|
| `PORT` | `10000` | HTTP port |
| `HOST` | `0.0.0.0` | bind |

## API

- `GET /api/lights` — cached lights (no scan)
- `GET /api/discover` — live UDP scan + hardware identity, refreshes cache
- `POST /api/pilot` `{ip, method, params}` — raw WiZ call (`setPilot` …)
- `GET/POST /api/scenes`, `POST /api/scenes/delete|play|stop` — scenes; `play` takes `{id, target:{type:'room'|'device', room?, mac?}}`, `stop` takes `{target}` or `{all:true}`

## WiZ notes

- Local UDP exposes numeric `roomId`/`homeId` only — friendly names come from the WiZ app export (`KNOWN` in `server/index.js`).
- True white = `temp` (white LEDs), not `r,g,b 255` (tints). Tunable-white-only modules (e.g. `ESP24_SHTWC`) ignore RGB.
