# Clarity MCP Server - Cloud Deployment 🚀

AI-powered Clarity PPM assistant with MCP protocol and agent loop.

## 🎯 Quick Deploy to Railway (5 minutes!)

### 1. Prepare Database Access

Your SQL Server must be accessible from the internet:
- **Option A:** Open firewall port 1433
- **Option B:** Use ngrok tunnel: `ngrok tcp 1433`
- **Option C:** Use VPN/Tailscale

### 2. Deploy to Railway

1. Go to [railway.app](https://railway.app)
2. "New Project" → "Deploy from GitHub"
3. Select your repo
4. Wait for auto-deploy

### 3. Set Environment Variables

In Railway dashboard, add:
```
TRANSPORT=http
PORT=3001
DB_SERVER=your-db-ip
DB_NAME=niku
DB_USER=niku
DB_PASSWORD=your-password
OPENAI_API_KEY=sk-proj-your-key
AI_PROVIDER=openai
```

### 4. Get Your URL

Railway gives you: `https://your-app.up.railway.app`

### 5. Update Chrome Extension

In `background.js`:
```javascript
fetch('https://your-app.up.railway.app/api/chat', {
```

### 6. Test It!

```bash
curl https://your-app.up.railway.app/health
```

## ✅ Done!

Your Clarity AI assistant is now accessible from anywhere! 🌍

See DEPLOYMENT-GUIDE.md for more details.
