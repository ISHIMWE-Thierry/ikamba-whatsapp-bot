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
const PAUSE_DURATION_MS = 60 * 60 * 1000; // 1 hour in milliseconds

// 24/7 Connection settings
const RECONNECT_INTERVAL_MS = 5000; // 5 seconds between reconnect attempts
const MAX_RECONNECT_ATTEMPTS = 50; // Max attempts before waiting longer
const LONG_RECONNECT_INTERVAL_MS = 60000; // 1 minute for long waits
let reconnectAttempts = 0;
let sock = null; // Global socket reference

// Secret admin command to pause/resume (only you should know this)
const PAUSE_COMMAND = process.env.PAUSE_COMMAND || '/ikambapause';

// Store conversation contexts
const conversationContexts = new Map();

// Store paused chats with expiry time
const pausedChats = new Map();

// Your WhatsApp number (will be detected automatically)
let myNumber = null;

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
  // Build paused chats info
  const pausedChatsList = [];
  for (const [chat, expiry] of pausedChats.entries()) {
    const remainingMins = Math.ceil((expiry - Date.now()) / 60000);
    if (remainingMins > 0) {
      pausedChatsList.push({ chat, remainingMins });
    }
  }
  
  res.json({ 
    connected: isConnected, 
    hasQR: !!currentQR,
    pausedChats: pausedChatsList
  });
});

// Paused chats endpoint
app.get('/paused', (req, res) => {
  let pausedHtml = '';
  let count = 0;
  
  for (const [chat, expiry] of pausedChats.entries()) {
    const remainingMins = Math.ceil((expiry - Date.now()) / 60000);
    if (remainingMins > 0) {
      count++;
      const phone = chat.replace('@s.whatsapp.net', '');
      pausedHtml += `<div class="chat-item">📱 ${phone} <span class="time">${remainingMins} min remaining</span></div>`;
    }
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Paused Chats - Ikamba Bot</title>
        <meta http-equiv="refresh" content="30">
        <style>
          body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #25D366, #128C7E); }
          .container { text-align: center; background: white; padding: 40px; border-radius: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); max-width: 500px; width: 90%; }
          h1 { color: #128C7E; }
          .chat-item { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 10px; text-align: left; }
          .time { float: right; color: #666; font-size: 12px; }
          .count { font-size: 48px; color: #128C7E; font-weight: bold; }
          .empty { color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>⏸️ Paused Chats</h1>
          <div class="count">${count}</div>
          ${count > 0 ? pausedHtml : '<p class="empty">No chats are currently paused</p>'}
          <p style="color: #999; font-size: 12px; margin-top: 20px;">Send "..." in any chat to pause/resume</p>
        </div>
      </body>
    </html>
  `);
});

// Reset endpoint - clears auth and restarts QR flow
app.get('/reset', async (req, res) => {
  try {
    // Clear auth folder
    const authPath = './auth_info';
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
    }
    currentQR = null;
    isConnected = false;
    
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Reset - Ikamba Bot</title>
          <meta http-equiv="refresh" content="3;url=/">
          <style>
            body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: linear-gradient(135deg, #25D366, #128C7E); }
            .container { text-align: center; background: white; padding: 40px; border-radius: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🔄 Resetting...</h1>
            <p>Auth cleared. Redirecting to QR code page...</p>
            <p>Please restart the bot on Railway to generate new QR.</p>
          </div>
        </body>
      </html>
    `);
    
    console.log('🔄 Auth reset requested - restart bot to generate new QR');
    
    // Exit to trigger Railway restart
    setTimeout(() => process.exit(0), 1000);
  } catch (error) {
    res.status(500).send('Error resetting: ' + error.message);
  }
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
  
  // Create socket connection with 24/7 settings
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: ['Ikamba AI', 'Chrome', '120.0.0'],
    syncFullHistory: false,
    getMessage: async () => undefined, // Required for some message types
    // 24/7 connection settings
    connectTimeoutMs: 60000, // 60 seconds timeout
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000, // Send keep-alive every 25 seconds
    retryRequestDelayMs: 500,
    markOnlineOnConnect: true,
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
      
      const statusCode = (lastDisconnect?.error instanceof Boom) 
        ? lastDisconnect.error.output?.statusCode 
        : null;
      
      const reason = lastDisconnect?.error?.message || 'unknown reason';
      console.log(`Connection closed: ${reason} (code: ${statusCode})`);
      
      // Check if we should reconnect
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      if (shouldReconnect) {
        reconnectAttempts++;
        
        // Calculate delay based on attempts
        let delay = RECONNECT_INTERVAL_MS;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          delay = LONG_RECONNECT_INTERVAL_MS;
          console.log(`⏳ Too many attempts (${reconnectAttempts}), waiting ${delay/1000}s before reconnecting...`);
        } else {
          console.log(`🔄 Reconnecting in ${delay/1000}s... (attempt ${reconnectAttempts})`);
        }
        
        // Wait and reconnect
        setTimeout(() => {
          console.log('🔌 Attempting to reconnect...');
          connectToWhatsApp();
        }, delay);
      } else {
        console.log('❌ Logged out. Delete auth_info folder and restart to re-login.');
        // Don't exit - wait for manual intervention
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      reconnectAttempts = 0; // Reset counter on successful connection
      
      // Get connected phone number
      myNumber = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0];
      console.log(`\n✅ Connected to WhatsApp as ${myNumber}!`);
      console.log('🤖 Ikamba AI Bot is now running 24/7...');
      console.log('📸 Image support: ENABLED');
      console.log('🎨 Rich formatting: ENABLED');
      console.log('⏸️  Send "..." to pause bot in any chat for 1 hour');
      console.log('🔄 Auto-reconnect: ENABLED\n');
    }
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

  // Handle ALL incoming messages (including from self)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Process both 'notify' and 'append' types to catch self messages
    console.log(`📬 Messages event type: ${type}, count: ${messages.length}`);
    
    for (const msg of messages) {
      // Skip if not a new message
      if (!msg.message) continue;
      
      // Get sender info
      const sender = msg.key.remoteJid;
      const isGroup = sender?.endsWith('@g.us');
      const isFromMe = msg.key.fromMe;
      
      // Extract message text for command checking
      const rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      
      // Debug log for all messages
      console.log(`📨 Message - From: ${sender?.substring(0, 15)}..., FromMe: ${isFromMe}, Type: ${type}, Text: "${rawText.substring(0, 30)}"`);
      
      // Handle pause command - works from self OR with secret command from anyone
      const isPauseCommand = rawText.trim() === '...' || rawText.trim().toLowerCase() === PAUSE_COMMAND.toLowerCase();
      
      if (isPauseCommand && (isFromMe || rawText.trim().toLowerCase() === PAUSE_COMMAND.toLowerCase())) {
        console.log(`🎯 PAUSE COMMAND DETECTED for chat: ${sender}`);
        // Toggle pause for this chat
        if (pausedChats.has(sender)) {
          // Resume the chat
          pausedChats.delete(sender);
          console.log(`▶️  Chat RESUMED: ${sender}`);
          await sock.sendMessage(sender, { 
            text: '▶️ *Bot resumed* - I\'ll respond to messages in this chat again.' 
          });
        } else {
          // Pause the chat for 1 hour
          const expiryTime = Date.now() + PAUSE_DURATION_MS;
          pausedChats.set(sender, expiryTime);
          console.log(`⏸️  Chat PAUSED for 1 hour: ${sender}`);
          await sock.sendMessage(sender, { 
            text: '⏸️ *Bot paused* - I won\'t respond in this chat for 1 hour.\nSend the command again to resume.' 
          });
        }
        continue;
      }
      
      // Skip other messages from self
      if (isFromMe) continue;
      
      // Skip non-notify messages for AI responses
      if (type !== 'notify') continue;
      
      // Check if chat is paused
      if (pausedChats.has(sender)) {
        const expiryTime = pausedChats.get(sender);
        if (Date.now() < expiryTime) {
          // Still paused, skip this message
          const remainingMins = Math.ceil((expiryTime - Date.now()) / 60000);
          console.log(`⏸️  Skipping message from paused chat ${sender} (${remainingMins} min remaining)`);
          continue;
        } else {
          // Pause expired, remove from paused chats
          pausedChats.delete(sender);
          console.log(`▶️  Pause expired for ${sender}, resuming...`);
        }
      }
      
      // Skip group messages (optional - remove this to enable groups)
      if (isGroup) continue;
      
      // Extract message content
      const { text: messageText, imageBase64, hasImage } = await extractMessageContent(msg, sock);
      if (!messageText && !hasImage) continue;
      
      console.log(`📩 Message from ${sender}: ${messageText || '[Image]'}`);
      if (hasImage) console.log('   📸 Contains image');
      
      // Get or create conversation context
      let context = conversationContexts.get(sender) || [];
      
      // Check if this is a NEW conversation (first message from this user)
      const isNewConversation = context.length === 0;
      
      // Build message content with image support
      let userContent = messageText || '';
      let imageDataUrl = null;
      
      if (hasImage && imageBase64) {
        // Create data URL for the image (for OpenAI Vision)
        imageDataUrl = `data:image/jpeg;base64,${imageBase64}`;
        
        // Add caption context if present
        if (!userContent) {
          userContent = 'Please analyze this image.';
        }
      }
      
      // Add user message to context (with image reference)
      context.push({
        role: 'user',
        content: userContent,
        hasImage: hasImage,
        imageUrl: imageDataUrl, // Store the actual image data URL
      });
      
      // Keep only last 20 messages
      if (context.length > 20) {
        context = context.slice(-20);
      }
      
      try {
        // Show typing indicator
        await sock.sendPresenceUpdate('composing', sender);
        
        // Send welcome message for NEW conversations
        if (isNewConversation) {
          const welcomeMessage = `👋 *Hello! I'm Ikamba AI Assistant*

I'm here to help you with:
💸 Send money to Africa (Rwanda, Uganda, Kenya, etc.)
📊 Check exchange rates
📋 Track your transfers
🧾 Get transfer receipts/proofs

How can I help you today?`;
          
          await sock.sendMessage(sender, { text: welcomeMessage });
          console.log(`👋 Sent welcome message to new user: ${sender}`);
          
          // Small delay before processing their actual message
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Call Ikamba AI with image data
        const aiResponse = await callIkambaAI(context, sender, hasImage, imageDataUrl);
        
        // Check if AI response contains a proof image to send
        const proofImageMatch = aiResponse.match(/\[\[PROOF_IMAGE:(https?:\/\/[^\]]+)\]\]/);
        
        if (proofImageMatch) {
          // Extract the image URL
          const imageUrl = proofImageMatch[1];
          console.log(`📸 Sending transfer proof image: ${imageUrl}`);
          
          // Remove the proof image tag from text response
          const textResponse = formatForWhatsApp(aiResponse.replace(/\[\[PROOF_IMAGE:[^\]]+\]\]/g, '').trim());
          
          // Send the text message first (if any)
          if (textResponse && textResponse.length > 0) {
            await sock.sendMessage(sender, { text: textResponse });
          }
          
          // Send the image
          try {
            await sock.sendMessage(sender, {
              image: { url: imageUrl },
              caption: '📋 Transfer Proof / Доказательство перевода'
            });
            console.log(`📤 Sent proof image to ${sender}`);
          } catch (imgError) {
            console.error('Failed to send image:', imgError);
            // Fallback: send URL as text
            await sock.sendMessage(sender, { 
              text: `📋 Transfer Proof: ${imageUrl}` 
            });
          }
        } else {
          // Format the response for WhatsApp (no image)
          const formattedResponse = formatForWhatsApp(aiResponse);
          
          // Send response
          await sock.sendMessage(sender, { text: formattedResponse });
          console.log(`📤 Replied to ${sender}`);
        }
        
        // Add AI response to context
        context.push({
          role: 'assistant',
          content: aiResponse,
        });
        
        // Save context
        conversationContexts.set(sender, context);
        
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

// Format response for WhatsApp with rich formatting (NO badge - just casual chat)
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
  
  // NO badge - just return casual response
  return formatted;
}

// Call Ikamba AI API
async function callIkambaAI(messages, userId, hasImage = false, currentImageUrl = null) {
  try {
    // Clean up WhatsApp JID to get just the phone number
    // Format: 250788123456@s.whatsapp.net → 250788123456
    const cleanPhone = userId.replace('@s.whatsapp.net', '').replace('@g.us', '');
    const formattedPhone = cleanPhone.startsWith('+') ? cleanPhone : `+${cleanPhone}`;
    
    // Style instructions - talk like Thierry (casual, mixed languages, friendly)
    const styleHint = `You are Ikamba AI - a friendly customer support assistant for Ikamba Remit money transfers.

LANGUAGE RULES (CRITICAL):
- DEFAULT LANGUAGE IS ENGLISH - always respond in English first
- ONLY switch to another language if the user CLEARLY writes in that language
- If user writes in Russian → respond in Russian
- If user writes in French → respond in French  
- If user writes in Kinyarwanda → respond in Kinyarwanda
- For technical terms (transaction ID, amounts, status), ALWAYS use English

RESPONSE STYLE:
- Be friendly, helpful and conversational
- Keep messages SHORT (1-3 sentences for simple questions)
- Use emojis naturally but not too many
- Sound human and approachable

GREETING RULES:
- "hi" or "hello" → "Hey! 👋 How can I help you?"
- "thanks" or "thank you" → "You're welcome! 😊"
- "bye" → "Goodbye! Take care! �"

TRANSFER PROOF:
- If user asks for proof/receipt/confirmation of a transfer → call get_transfer_proof
- When you have a transferProofUrl, output: [[PROOF_IMAGE:URL]] to send the image
- Example: "Here's your transfer proof! [[PROOF_IMAGE:https://storage.googleapis.com/...]]"

WHATSAPP VERIFICATION FLOW:
If the user is NOT verified (check WHATSAPP USER STATUS in context):
1. When they want to send money, first ask for their email
2. Call request_whatsapp_verification function with their email
3. Tell them a verification code was sent to their email
4. When they send the code, call verify_whatsapp_code function
5. If verified, proceed with the transfer

If user is VERIFIED:
- Proceed normally with transfer
- Use their linked account info

IMPORTANT:
- User's WhatsApp phone is ${formattedPhone} - use this for verification and orders
- DO NOT create orders for unverified users - verify first!`;

    // Add context about image if present
    const imageHint = hasImage 
      ? '\nNote: User sent an image. Analyze it carefully - if it\'s a payment screenshot, confirm the payment. If it\'s anything else, describe what you see briefly.'
      : '';
    
    // Build messages array with image support
    const apiMessages = messages.map(m => {
      // If this message has an image URL, format for OpenAI Vision
      if (m.imageUrl) {
        return {
          role: m.role,
          content: m.content,
          images: [m.imageUrl], // Pass image as array for the API
        };
      }
      return {
        role: m.role,
        content: m.content,
      };
    });
    
    const response = await fetch(IKAMBA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: apiMessages,
        mode: 'gpt',
        userInfo: {
          userId: `whatsapp_${cleanPhone}`,
          email: null,
          displayName: `WhatsApp User`,
          phone: formattedPhone,
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

// Health check - logs status every 5 minutes
function startHealthCheck() {
  setInterval(() => {
    const status = isConnected ? '✅ Connected' : '❌ Disconnected';
    const uptime = Math.floor(process.uptime() / 60);
    console.log(`[Health Check] ${status} | Uptime: ${uptime} minutes | Reconnect attempts: ${reconnectAttempts}`);
    
    // Clean up expired paused chats
    const now = Date.now();
    for (const [chat, expiry] of pausedChats.entries()) {
      if (expiry < now) {
        pausedChats.delete(chat);
        console.log(`[Pause] Removed expired pause for ${chat}`);
      }
    }
  }, 5 * 60 * 1000); // Every 5 minutes
}

// Handle process signals for graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  if (sock) {
    sock.end();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  if (sock) {
    sock.end();
  }
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  // Don't exit - try to keep running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
  // Don't exit - try to keep running
});

// Start the bot
console.log('🚀 Starting Ikamba AI WhatsApp Bot (24/7 Mode)...\n');
console.log('📋 Features:');
console.log('   • Auto-reconnect on disconnection');
console.log('   • Keep-alive heartbeat every 25 seconds');
console.log('   • Health check logging every 5 minutes');
console.log('   • Graceful error handling');
console.log('');

// Start health check
startHealthCheck();

// Connect to WhatsApp
connectToWhatsApp().catch((error) => {
  console.error('❌ Failed to start bot:', error);
  console.log('🔄 Retrying in 10 seconds...');
  setTimeout(() => {
    connectToWhatsApp().catch(console.error);
  }, 10000);
});
