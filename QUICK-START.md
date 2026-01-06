# 🚀 Quick Start - Deploy in 5 Minutes

## Step 1: Upload to GitHub

```bash
# 1. Create a new repo on GitHub.com
#    Name it: clarity-mcp-server

# 2. Extract this ZIP to a folder

# 3. Open terminal in that folder and run:
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/clarity-mcp-server.git
git push -u origin main
```

## Step 2: Deploy to Railway

1. Go to https://railway.app/
2. Sign up / Log in (free!)
3. Click **"New Project"**
4. Select **"Deploy from GitHub repo"**
5. Choose your `clarity-mcp-server` repo
6. Railway will auto-detect and start building!

## Step 3: Add Environment Variables

In Railway dashboard:
1. Click on your project
2. Go to **"Variables"** tab
3. Click **"+ New Variable"**
4. Add these one by one:

```
TRANSPORT = http
PORT = 3001
DB_SERVER = 16.16.83.171
DB_NAME = niku
DB_USER = niku
DB_PASSWORD = [your-password]
OPENAI_API_KEY = sk-proj-[your-key]
AI_PROVIDER = openai
```

**⚠️ Important:**
- Replace `[your-password]` with actual DB password
- Replace `[your-key]` with your OpenAI API key from https://platform.openai.com/api-keys

## Step 4: Get Your Public URL

After deployment completes:
1. Click **"Settings"** tab
2. Under **"Domains"**
3. You'll see something like: `https://clarity-mcp-production.up.railway.app`
4. **Copy this URL!**

## Step 5: Test It

```bash
# Replace with your actual URL:
curl https://clarity-mcp-production.up.railway.app/health
```

Should return:
```json
{
  "status": "ready",
  "database": "connected",
  "ai": "enabled"
}
```

## Step 6: Update Chrome Extension

1. Extract the extension ZIP (if you have it)
2. Open `background.js`
3. Find the line:
   ```javascript
   fetch('http://localhost:3001/api/chat', {
   ```
4. Change to your Railway URL:
   ```javascript
   fetch('https://clarity-mcp-production.up.railway.app/api/chat', {
   ```
5. Save the file
6. Reload extension in Chrome:
   - Go to `chrome://extensions/`
   - Click reload button on your extension

## ✅ Done!

Your Clarity AI Assistant is now live and accessible from anywhere! 🌍

---

## 🔒 Database Access

**Important:** Your SQL Server at `16.16.83.171` must be accessible from the internet!

**Options:**

### Option A: Open Firewall (Permanent)
```bash
# On your server, open port 1433
# Windows Firewall:
New-NetFirewallRule -DisplayName "SQL Server" -Direction Inbound -LocalPort 1433 -Protocol TCP -Action Allow
```

### Option B: ngrok Tunnel (For Testing)
```bash
# On the machine with SQL Server:
ngrok tcp 1433

# Use the ngrok URL in Railway:
# DB_SERVER = 0.tcp.ngrok.io:12345
```

### Option C: VPN (Most Secure)
Use Tailscale or similar to create private network between Railway and your server.

---

## 💰 Cost

- **Railway:** $5 free credit/month, then ~$5-10/month
- **OpenAI API:** ~$0.10-1.00/day depending on usage
- **Total:** ~$10-15/month

---

## ❓ Troubleshooting

### "Database connection failed"
- Check that DB_SERVER is correct
- Verify port 1433 is open
- Test connection: `telnet 16.16.83.171 1433`

### "OpenAI error"
- Verify OPENAI_API_KEY is correct
- Check you have credits: https://platform.openai.com/usage

### Extension can't connect
- Check Railway logs for errors
- Verify URL in background.js matches Railway URL
- Test /health endpoint first

### Railway build fails
- Check the logs in Railway dashboard
- Make sure all files uploaded correctly
- Verify package.json is valid

---

## 📞 Need Help?

- **Railway Docs:** https://docs.railway.app/
- **OpenAI Docs:** https://platform.openai.com/docs
- **Check logs:** Railway Dashboard → Your Project → View Logs

---

## 🎉 Next Steps

Once deployed:
1. ✅ Share with your team
2. ✅ Install extension on all devices
3. ✅ Monitor usage in Railway dashboard
4. ✅ Add more features!

Happy deploying! 🚀
