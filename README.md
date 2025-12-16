# Ikamba AI WhatsApp Bot

This bot connects your WhatsApp number to Ikamba AI using Baileys.

## Features

- ✅ Replies to all incoming messages with Ikamba AI
- ✅ **Receives images** (payment screenshots, documents)
- ✅ **Rich formatting** (bold, italic, emojis, structured layouts)
- ✅ Maintains conversation context
- ✅ Shows typing indicator while processing
- ✅ Persists session (no need to re-scan QR)
- ✅ Handles voice messages, stickers, contacts, locations

## Setup

1. Install dependencies:
   ```bash
   cd whatsapp-bot
   npm install
   ```

2. Start the bot:
   ```bash
   npm start
   ```

3. Scan the QR code with your WhatsApp:
   - Open WhatsApp on your phone
   - Go to **Settings** → **Linked Devices**
   - Tap **Link a Device**
   - Scan the QR code shown in terminal

4. Done! The bot is now running and will reply to all messages.

## Keep Bot Running 24/7

### Option 1: PM2 (Recommended for Mac/Linux)

```bash
# Install PM2 globally
npm install -g pm2

# Start the bot with PM2
cd whatsapp-bot
pm2 start index.js --name ikamba-whatsapp

# Save the process list
pm2 save

# Auto-start on system boot
pm2 startup

# Useful commands:
pm2 logs ikamba-whatsapp    # View logs
pm2 restart ikamba-whatsapp # Restart bot
pm2 stop ikamba-whatsapp    # Stop bot
pm2 status                  # Check status
```

### Option 2: Deploy to Railway (Cloud - Free Tier)

1. Push code to GitHub
2. Go to [railway.app](https://railway.app)
3. Create new project → Deploy from GitHub
4. Bot runs 24/7 in the cloud

### Option 3: Deploy to Render (Cloud - Free Tier)

1. Push code to GitHub  
2. Go to [render.com](https://render.com)
3. Create new Background Worker
4. Connect your repo

## Image Handling

When users send images:
- Images are saved to `./media/` folder
- Bot acknowledges the image
- If it looks like a payment screenshot, AI will ask for confirmation

## WhatsApp Formatting

The bot automatically converts Markdown to WhatsApp format:
- `**bold**` → *bold*
- `__italic__` → _italic_
- `### Header` → *Header*
- `- item` → • item
- `---` → ━━━━━━━━━━━━━

## Troubleshooting

**QR code expired?**
- Restart the bot and scan again

**Session lost?**
- Delete `auth_info` folder and restart to re-login

**Not receiving messages?**
- Check if phone has internet
- Make sure WhatsApp is open on phone (at least once)

## Notes

- The bot uses your personal WhatsApp number
- Session is stored in `auth_info` folder
- Images are stored in `media` folder
- This is for personal/testing use only
- Keep your phone connected to internet
