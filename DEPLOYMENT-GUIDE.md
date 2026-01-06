# 🚀 Deploy Clarity MCP Server to Cloud

## Option 1: Railway (Recommended - Easiest!)

### Prerequisites
- GitHub account
- Railway account (free tier available)
- Your OpenAI API Key

### Step-by-Step Deployment

#### 1. Prepare Your Code

Create a GitHub repository with these files:
```
clarity-mcp/
├── src/
│   └── index.ts (your MCP server)
├── package.json
├── tsconfig.json
├── .env.example
├── railway.json
└── nixpacks.toml
```

#### 2. Create .env.example

```env
# Transport (always http for cloud)
TRANSPORT=http
PORT=3001

# Database (UPDATE THESE!)
DB_SERVER=YOUR_DATABASE_IP_OR_DOMAIN
DB_NAME=niku
DB_USER=niku
DB_PASSWORD=YOUR_DB_PASSWORD

# AI Configuration
OPENAI_API_KEY=sk-proj-YOUR_KEY_HERE
AI_PROVIDER=openai
```

**IMPORTANT:** Your database must be accessible from the internet!
- If it's behind a firewall, you need to open port 1433
- Or use a VPN/tunnel service like ngrok for the database

#### 3. Deploy to Railway

1. Go to https://railway.app/
2. Sign up / Log in
3. Click "New Project"
4. Choose "Deploy from GitHub repo"
5. Select your repository
6. Railway will auto-detect Node.js and deploy

#### 4. Add Environment Variables

In Railway dashboard:
- Go to your project
- Click "Variables" tab
- Add each variable from .env:
  - `TRANSPORT` = `http`
  - `PORT` = `3001`
  - `DB_SERVER` = `your-database-ip`
  - `DB_NAME` = `niku`
  - `DB_USER` = `niku`
  - `DB_PASSWORD` = `your-password`
  - `OPENAI_API_KEY` = `sk-proj-...`
  - `AI_PROVIDER` = `openai`

#### 5. Get Your Public URL

Railway will give you a URL like:
```
https://clarity-mcp-production.up.railway.app
```

#### 6. Update Your Extension

In your Chrome extension's `background.js`:
```javascript
// Change from:
const response = await fetch('http://localhost:3001/api/chat', {

// To:
const response = await fetch('https://your-app.up.railway.app/api/chat', {
```

### Database Connectivity Options

**Option A: Public Database (Simple)**
- Make your SQL Server accessible from internet
- Open port 1433 in firewall
- Use strong password!
- Consider IP whitelist

**Option B: ngrok Tunnel (For Testing)**
```bash
# On your local machine where SQL Server runs:
ngrok tcp 1433

# Use the ngrok URL in Railway:
DB_SERVER=0.tcp.ngrok.io
```

**Option C: Railway Private Network (Advanced)**
- Deploy SQL Server to Railway
- Use private networking
- More secure but complex

---

## Option 2: Render.com (Free Tier)

### Steps:

1. Push code to GitHub
2. Go to https://render.com
3. New → Web Service
4. Connect GitHub repo
5. Build Command: `npm run build`
6. Start Command: `npm start`
7. Add environment variables
8. Deploy!

**Free Tier Limitations:**
- Spins down after 15 minutes of inactivity
- Slow cold starts
- But completely free!

---

## Option 3: Fly.io (More Control)

### Setup:

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login
flyctl auth login

# Launch app
flyctl launch

# Set secrets
flyctl secrets set OPENAI_API_KEY=sk-proj-...
flyctl secrets set DB_SERVER=your-db-ip
flyctl secrets set DB_PASSWORD=your-password

# Deploy
flyctl deploy
```

---

## Option 4: DigitalOcean App Platform

1. Connect GitHub repo
2. Select Node.js
3. Add environment variables
4. Deploy
5. Get public URL

**Cost:** ~$5/month

---

## Testing Your Deployment

### 1. Test Health Endpoint
```bash
curl https://your-app-url.com/health
```

Should return:
```json
{
  "status": "ready",
  "database": "connected",
  "ai": "enabled"
}
```

### 2. Test MCP Endpoint
```bash
curl -X POST https://your-app-url.com/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'
```

### 3. Test from Extension

Update extension, reload it, and try a query!

---

## Security Considerations

⚠️ **IMPORTANT SECURITY STEPS:**

1. **Database Access:**
   - Use strong passwords
   - Enable SSL/TLS for database connections
   - Whitelist only Railway IPs if possible

2. **API Keys:**
   - Never commit API keys to GitHub
   - Use environment variables only
   - Rotate keys regularly

3. **CORS:**
   - Currently set to `*` (allow all)
   - Consider restricting to specific origins:
   ```typescript
   res.header('Access-Control-Allow-Origin', 'chrome-extension://YOUR_EXTENSION_ID');
   ```

4. **Rate Limiting:**
   - Add rate limiting to prevent abuse
   - Use express-rate-limit package

5. **Authentication:**
   - Consider adding API key authentication
   - Only allow requests from your extension

---

## Cost Comparison

| Service | Free Tier | Paid | Best For |
|---------|-----------|------|----------|
| **Railway** | $5 credit/month | $5-20/month | Easy deployment |
| **Render** | Yes (with limits) | $7+/month | Free option |
| **Fly.io** | Limited free | $0-10/month | Full control |
| **DigitalOcean** | No | $5+/month | Reliability |

---

## Recommended Setup (Best Practice)

1. **Railway for MCP Server** → Fast, reliable, easy
2. **Database Options:**
   - Keep on-premise with VPN/tunnel
   - Or migrate to cloud database (Azure SQL, AWS RDS)
3. **Extension:** Install on all your devices

---

## Quick Start (Railway)

```bash
# 1. Create GitHub repo
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourusername/clarity-mcp.git
git push -u origin main

# 2. Go to railway.app
# 3. Click "Deploy from GitHub"
# 4. Add environment variables
# 5. Done! 🎉
```

Your MCP server will be live at:
`https://your-project.up.railway.app`

---

## Troubleshooting

**Database Connection Failed:**
- Check firewall rules
- Verify DB_SERVER is correct
- Test connection from Railway: `telnet DB_SERVER 1433`

**CORS Errors:**
- Check CORS headers in index.ts
- Make sure origin is allowed

**OpenAI Errors:**
- Verify API key is set correctly
- Check OpenAI account has credits

**Extension Can't Connect:**
- Update URL in background.js
- Check network tab for errors
- Verify server is running (check /health)

---

## Next Steps

Once deployed:
1. ✅ Update extension with public URL
2. ✅ Test from different devices
3. ✅ Share with team members
4. ✅ Monitor logs in Railway dashboard
5. ✅ Set up alerts for errors

Need help? Check Railway docs: https://docs.railway.app/
