# watchparty ❤️

Synchronized movie watching for long-distance couples. No subscriptions, no extensions — just open a video file and watch together.

## How it works

1. Both of you open the site
2. One person creates a room and shares the 6-letter code
3. Both load their own local copy of the movie file
4. Play, pause, and seek stay in sync automatically
5. Chat sidebar for reactions

## Run locally

```bash
cd watchparty
npm install
npm start
# open http://localhost:3000
```

## Deploy free on Railway

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo — Railway auto-detects Node.js and deploys
4. Your site gets a free `.railway.app` URL, share it with your partner

## Deploy free on Render

1. Push to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your repo
4. Build command: `npm install` · Start command: `node server.js`
5. Free tier — note it spins down after 15min inactivity (first load may be slow)
