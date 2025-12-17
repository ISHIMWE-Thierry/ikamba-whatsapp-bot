import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import express from 'express';
import fs from 'fs';
import path from 'path';

// Configuration
const IKAMBA_API_URL = process.env.IKAMBA_API_URL || 'https://hpersona.vercel.app/api/chat';
const PORT = process.env.PORT || 3000;

// Store conversation contexts
const conversationContexts = new Map();

// Store current QR code
let currentQR = null;
let isConnected = false;

// Logger
const logger = pino({ level: 'silent' });

// Create media folder
const mediaDir = './media';
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

// Setup Express server for QR code display
const app = express();

app.get('/', (req, res) => {
  if (isConnected) {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Ikamba WhatsApp Bot</title>
          <style>
            body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: linear-gradient(135deg, #25D366, #128C7E); }
            .container { text-align: center; background: white; padding: 40px; border-radius: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
            h1 { color: #128C7E; }
            .status { font-size: 24px; color: #25D366; }
            .emoji { font-size: 60px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="emoji">✅</div>
            <h1>Ikamba AI WhatsApp Bot</h1>
            <p class="status">Connected & Running!</p>
            <p>The bot is actively responding to messages.</p>
          </div>
        </body>
      </html>
    `);
  } else if (currentQR) {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Scan QR Code - Ikamba Bot</title>
          <meta http-equiv="refresh" content="30">
          <style>
            body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: linear-gradient(135deg, #25D366, #128C7E); }
            .container { text-align: center; background: white; padding: 40px; border-radius: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
            h1 { color: #128C7E; }
            img { margin: 20px 0; border-radius: 10px; }
            .instructions { color: #666; margin-top: 20px; }
            .step { margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>📱 Scan QR Code</h1>
            <img src="${currentQR}" alt="QR Code" width="300" height="300">
            <div class="instructions">
              <p class="step">1. Open WhatsApp on your phone</p>
              <p class="step">2. Go to Settings → Linked Devices</p>
              <p class="step">3. Tap "Link a Device"</p>
              <p class="step">4. Scan this QR code</p>
            </div>
            <p style="color: #999; font-size: 12px;">Page auto-refreshes every 30 seconds</p>
          </div>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Ikamba WhatsApp Bot</title>
          <meta http-equiv="refresh" content="5">
          <style>
            body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: linear-gradient(135deg, #25D366, #128C7E); }
            .container { text-align: center; background: white; padding: 40px; border-radius: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
            h1 { color: #128C7E; }
            .loading { font-size: 40px; animation: spin 1s linear infinite; }
            @keyframes spin { 100% { transform: rotate(360deg); } }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="loading">⏳</div>
            <h1>Starting Bot...</h1>
            <p>Please wait, generating QR code...</p>
          </div>
        </body>
      </html>
    `);
  }
});

app.get('/status', (req, res) => {
  res.json({ connected: isConnected, hasQR: !!currentQR });
});

app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
  console.log(`📱 Open your browser to scan QR code`);
});

async function connectToWhatsApp() {
  // Get auth state from file (persists session)
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  
  // Get latest Baileys version
  const { version } = await fetchLatestBaileysVersion();
  
  // Create socket connection
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: ['Ikamba AI', 'Chrome', '120.0.0'],
  });

  // Handle connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('\n📱 Scan this QR code with WhatsApp:\n');
      qrcode.generate(qr, { small: true });
      console.log('\nOpen WhatsApp → Settings → Linked Devices → Link a Device\n');
      
      // Generate QR code as data URL for web display
      try {
        currentQR = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        isConnected = false;
        console.log('🌐 QR code available at web interface');
      } catch (err) {
        console.error('Error generating QR image:', err);
      }
    }
    
    if (connection === 'close') {
      isConnected = false;
      currentQR = null;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      
      console.log('Connection closed due to', lastDisconnect?.error?.message || 'unknown reason');
      
      if (shouldReconnect) {
        console.log('Reconnecting...');
        connectToWhatsApp();
      } else {
        console.log('Logged out. Delete auth_info folder and restart to re-login.');
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('\n✅ Connected to WhatsApp!');
      console.log('🤖 Ikamba AI Bot is now running...');
      console.log('📸 Image support: ENABLED');
      console.log('🎨 Rich formatting: ENABLED\n');
    }
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

  // Handle incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    
    for (const msg of messages) {
      // Skip if not a new message or is from self
      if (!msg.message || msg.key.fromMe) continue;
      
      // Get sender info
      const sender = msg.key.remoteJid;
      const isGroup = sender?.endsWith('@g.us');
      
      // Skip group messages (optional - remove this to enable groups)
      if (isGroup) continue;
      
      // Extract message content
      const { text: messageText, imageBase64, hasImage } = await extractMessageContent(msg, sock);
      if (!messageText && !hasImage) continue;
      
      console.log(`📩 Message from ${sender}: ${messageText || '[Image]'}`);
      if (hasImage) console.log('   📸 Contains image');
      
      // Get or create conversation context
      let context = conversationContexts.get(sender) || [];
      
      // Build message content
      let userContent = messageText || '';
      if (hasImage && imageBase64) {
        // For image messages, we'll describe it to the AI
        userContent = messageText 
          ? `[User sent an image with caption: "${messageText}"]` 
          : '[User sent an image - likely a payment screenshot or document]';
      }
      
      // Add user message to context
      context.push({
        role: 'user',
        content: userContent,
        hasImage: hasImage,
      });
      
      // Keep only last 20 messages
      if (context.length > 20) {
        context = context.slice(-20);
      }
      
      try {
        // Show typing indicator
        await sock.sendPresenceUpdate('composing', sender);
        
        // Call Ikamba AI
        const aiResponse = await callIkambaAI(context, sender, hasImage);
        
        // Format the response for WhatsApp
        const formattedResponse = formatForWhatsApp(aiResponse);
        
        // Add AI response to context
        context.push({
          role: 'assistant',
          content: aiResponse,
        });
        
        // Save context
        conversationContexts.set(sender, context);
        
        // Send response
        await sock.sendMessage(sender, { text: formattedResponse });
        console.log(`📤 Replied to ${sender}`);
        
      } catch (error) {
        console.error('Error processing message:', error);
        await sock.sendMessage(sender, { 
          text: '❌ Sorry, I encountered an error. Please try again.' 
        });
      }
      
      // Clear typing indicator
      await sock.sendPresenceUpdate('paused', sender);
    }
  });

  return sock;
}

// Extract content from different message types (including images)
async function extractMessageContent(msg, sock) {
  const message = msg.message;
  let text = null;
  let imageBase64 = null;
  let hasImage = false;
  
  // Text messages
  if (message?.conversation) {
    text = message.conversation;
  } else if (message?.extendedTextMessage?.text) {
    text = message.extendedTextMessage.text;
  }
  
  // Image messages
  if (message?.imageMessage) {
    hasImage = true;
    text = message.imageMessage.caption || null;
    
    try {
      // Download the image
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      imageBase64 = buffer.toString('base64');
      
      // Optionally save to file
      const filename = `${Date.now()}.jpg`;
      fs.writeFileSync(path.join(mediaDir, filename), buffer);
      console.log(`   💾 Image saved: ${filename}`);
    } catch (err) {
      console.error('Error downloading image:', err);
    }
  }
  
  // Document/file messages
  if (message?.documentMessage) {
    text = `[User sent a document: ${message.documentMessage.fileName || 'file'}]`;
  }
  
  // Video messages
  if (message?.videoMessage) {
    hasImage = true;
    text = message.videoMessage.caption || '[User sent a video]';
  }
  
  // Voice messages
  if (message?.audioMessage) {
    text = '[User sent a voice message - please type your message instead]';
  }
  
  // Button responses
  if (message?.buttonsResponseMessage?.selectedButtonId) {
    text = message.buttonsResponseMessage.selectedButtonId;
  }
  
  // List responses
  if (message?.listResponseMessage?.singleSelectReply?.selectedRowId) {
    text = message.listResponseMessage.singleSelectReply.selectedRowId;
  }
  
  // Sticker
  if (message?.stickerMessage) {
    text = '[User sent a sticker 😊]';
  }
  
  // Location
  if (message?.locationMessage) {
    const loc = message.locationMessage;
    text = `[User shared location: ${loc.degreesLatitude}, ${loc.degreesLongitude}]`;
  }
  
  // Contact
  if (message?.contactMessage) {
    text = `[User shared a contact: ${message.contactMessage.displayName}]`;
  }
  
  return { text, imageBase64, hasImage };
}

// Ikamba AI Badge
const IKAMBA_BADGE = `\n\n━━━━━━━━━━━━━━━━━━\n🤖 *Ikamba AI* by ikambaremit.com`;

// Format response for WhatsApp with rich formatting
function formatForWhatsApp(text) {
  let formatted = text;
  
  // Clean up AI tags
  formatted = formatted
    .replace(/\[\[TRANSFER:[^\]]+\]\]/g, '')
    .replace(/\[\[PAYMENT:[^\]]+\]\]/g, '')
    .replace(/\[\[RECIPIENT:[^\]]+\]\]/g, '')
    .replace(/\[\[[A-Z_]+:[^\]]*\]\]/gi, '')
    .trim();
  
  // Convert markdown to WhatsApp formatting
  // **bold** → *bold*
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  
  // __italic__ → _italic_
  formatted = formatted.replace(/__([^_]+)__/g, '_$1_');
  
  // `code` stays the same
  
  // ### Headers → *HEADER*
  formatted = formatted.replace(/^###\s*(.+)$/gm, '*$1*');
  formatted = formatted.replace(/^##\s*(.+)$/gm, '*$1*');
  formatted = formatted.replace(/^#\s*(.+)$/gm, '*$1*');
  
  // Add decorative elements for sections
  formatted = formatted.replace(/^---$/gm, '━━━━━━━━━━━━━━━━━━');
  
  // Bullet points
  formatted = formatted.replace(/^- /gm, '• ');
  formatted = formatted.replace(/^\* /gm, '• ');
  
  // Numbered lists (keep as is)
  
  // Add spacing after sections
  formatted = formatted.replace(/\n{3,}/g, '\n\n');
  
  // Add Ikamba AI badge at the end
  formatted = formatted + IKAMBA_BADGE;
  
  return formatted;
}

// Call Ikamba AI API
async function callIkambaAI(messages, userId, hasImage = false) {
  try {
    // Style instructions for casual Kinyarwanda-English mix
    const styleHint = `IMPORTANT STYLE RULES FOR WHATSAPP:
- Reply like a cool Rwandan friend, mix Kinyarwanda & English naturally
- Keep it SUPER SHORT - max 10 words if possible!
- Use casual greetings like "Yooo", "Eh boss", "Mwaramutse", "Oya", "Yego"
- Common phrases: "ushaka iki?", "ni byiza", "komeza", "murakoze", "ese?", "nta kibazo"
- Be friendly & direct, no formal stuff
- For transfers: give quick numbers, skip long explanations
- Example: "Yooo! 10k RUB = 145,000 RWF 🔥 Ushaka kohereza?"`;

    // Add context about image if present
    const imageHint = hasImage 
      ? '\nNote: User sent an image. If payment screenshot, just say "Nabonye screenshot! ✅" and confirm.'
      : '';
    
    const response = await fetch(IKAMBA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: messages.map(m => ({
          role: m.role,
          content: m.content + (m.role === 'user' && m.hasImage ? ' [contains image]' : ''),
        })),
        mode: 'gpt',
        userInfo: {
          userId: `whatsapp_${userId}`,
          email: null,
          displayName: `WhatsApp User`,
        },
        systemHint: styleHint + imageHint,
      }),
    });

    if (!response.ok) {
      throw new Error('AI API error');
    }

    // Handle streaming response
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.trim() !== '');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.content) {
              fullText += parsed.content;
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return fullText || 'I apologize, I could not generate a response.';
    
  } catch (error) {
    console.error('Error calling Ikamba AI:', error);
    return '❌ Sorry, I encountered an error processing your request. Please try again.';
  }
}

// Start the bot
console.log('🚀 Starting Ikamba AI WhatsApp Bot...\n');
connectToWhatsApp().catch(console.error);
