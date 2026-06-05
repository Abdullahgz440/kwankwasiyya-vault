# Kwankwasiyya Vault

Political mobilization platform for the Kwankwasiyya movement.

## Features
- Member registration with State/LGA/Ward cascade dropdowns (774 LGAs, 8813 wards)
- PVC (Permanent Voter's Card) verification field
- Referral/invite system with K-Power points
- 10-level progression system
- Real-time leaderboard (national + state)
- PostgreSQL member database

## Tech Stack
- **Backend:** Node.js + Express
- **Database:** PostgreSQL
- **Frontend:** Vanilla HTML/CSS/JS (single page app)
- **Hosting:** Render.com

## Deploy to Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Blueprint
3. Connect your GitHub repo
4. Render will auto-create the web service + PostgreSQL database
5. Done — your app is live!

## Environment Variables (auto-set by render.yaml)
- `DATABASE_URL` — PostgreSQL connection string (auto from Render DB)
- `JWT_SECRET` — Auto-generated secure secret
- `NODE_ENV` — Set to `production`

## API Endpoints
- `GET /api/states` — List all states
- `GET /api/lgas/:state` — LGAs for a state
- `GET /api/wards/:state/:lga` — Wards for an LGA
- `POST /api/register` — Register new member
- `POST /api/login` — Login
- `GET /api/dashboard` — Member dashboard (auth required)
- `GET /api/leaderboard` — Top members (optional ?state= filter)
- `GET /api/stats` — Total members & states count
 - `POST /api/profile-photo` — Upload profile image (auth required)
