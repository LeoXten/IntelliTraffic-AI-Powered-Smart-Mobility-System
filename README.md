# IntelliTraffic (Integrated) — Role-based Auth + Route Planner + Python YOLO pipeline

This project merges your **role-based auth** and the **traffic route planner** into a single app.

## Features
- Navbar **Sign In** opens `/login/` (same app).
- After login:
  - **user** → redirected to `/` (map app). Navbar shows **Log Out**.
  - **emergency** → redirected to `/emergency` (blank placeholder).
  - **admin** → redirected to `/admin` (blank placeholder).
- The app writes `python/routeSignal.csv`, runs `python/mainAlgo.py`, and returns `python/fastest_route.json` to the frontend when you click **Find Optimal Route**.
- **MongoDB** is used if available. If not, a safe **file-based fallback** with default accounts is created automatically:
  - `user@example.com / 123456` (role: user)
  - `emergency@example.com / 123456` (role: emergency)
  - `admin@example.com / 123456` (role: admin)

## Quick Start

1. **Install Node dependencies**
   ```bash
   npm install
   ```

2. **Copy env**
   ```bash
   cp .env.example .env
   # Edit .env if you want to point to Mongo or change JWT secret.
   ```

3. **(Optional) Start MongoDB** and set `MONGO_URI` in `.env`. If Mongo is not available, the server will use the file store automatically.

4. **Run the server**
   ```bash
   npm start
   ```
   Visit http://localhost:3000

5. **Login**
   Use any of the default accounts above or register a new one via `POST /api/auth/register`.

## Python (YOLO) pipeline
- The Python script is at `python/mainAlgo.py`. Your uploaded version is included. It looks for:
  - `python/All_Crossings/...` lane images (optional),
  - `python/routeSignal.csv` (auto-written by the server),
  - it writes `python/fastest_route.json` used by the frontend to display total times that include signal delays.
- If Ultralytics / OpenCV / model weights are missing, your `mainAlgo.py` already falls back to a **limited mode** (no detection) but still returns valid timing JSON.

## Files you may want to add
- `python/All_Crossings/` — your actual crossing data.
- Update `/public/signal.csv` with the full signal list (the app already reads it).

## Endpoints
- `POST /api/auth/login` — { email, password }
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /saveRouteSignals` — array of routes from the frontend; triggers python and returns `{success, result}` where `result` is `fastest_route.json`.

## Notes
- The **Sign In** button in the navbar automatically turns into **Log Out** after login.
- If a logged-in **admin/emergency** tries to visit `/`, they will be redirected to their placeholder area.
- You can later replace `/public/admin` and `/public/emergency` with full apps.

Enjoy!
