# Sprint Planner

A shared sprint capacity planner. Set the sprint dates, add fixed story points and a buffer %, paste the team's leave table from Excel, and get the capacity left for new stories. Edits autosave and sync live for everyone in the room. Data is deleted 3 months after the last edit.

- **UI:** static site in `web/` (GitHub Pages, no build step)
- **Backend:** Cloudflare Worker + one Durable Object in `worker/` (room `playwright`)

## How capacity is calculated

```
working days = sprint days - weekends - holidays
person-days  = sum over people of (working days - leave)
gross        = person-days x points per person-day
net          = (gross - fixed points) x (1 - buffer %)     // floored at 0
```

## Pasting leave from Excel

Select the people and dates in Excel (the `Resource | 2-Nov | 3-Nov ...` block), copy, and paste in the dialog. Cells are read as availability: `1` working, `0.5` half day, `0` off, blank = off. Header, `Total` and `Sprint Capacity` rows are skipped, only dates inside the sprint are used, and days where everyone is off are offered as holidays. A plain `Name | Date | Half/Full` list also works.

## Run locally

```sh
npm install
npm run dev:worker   # Worker on :8787
npm run dev:web      # site on :8080
```

## Tests

Every change ships with tests; CI runs all of them and blocks the deploy if any fail.

```sh
npm test               # everything
npm run test:unit      # capacity, parser, sync client, view helpers (node:test)
npm run test:worker    # Durable Object, retention alarm, origin rules (vitest)
npm run test:e2e       # browser tests (Playwright; starts both servers itself)
```

## Deploy

1. **Worker:** edit `ALLOWED_ORIGINS` in `worker/wrangler.toml` (your GitHub Pages origin, e.g. `https://<user>.github.io`), then `npx wrangler deploy --config worker/wrangler.toml`. Note the `*.workers.dev` URL it prints.
2. **Site:** set `PROD_WORKER_URL` in `web/config.js` to `wss://<that host>`. In the GitHub repo settings choose Pages > Source: GitHub Actions. Pushing to `main` runs the tests, then publishes `web/`.

## Adding rooms and security later

The room name is a parameter end to end (`ROOMS` in `worker/src/index.ts`, `ROOM_ID` in `web/config.js`). Today only `playwright` is accepted and anyone who can open the page can edit it. Passcodes would be added in the Durable Object's `set` handling.
