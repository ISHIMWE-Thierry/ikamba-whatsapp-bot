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

// ============================================
// COST OPTIMIZATION: Response caching
// ============================================
const responseCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

// Simple pattern matching for instant responses (NO API call needed)
const INSTANT_RESPONSES = {
  // Greetings
  'hi': 'Hey! 👋 How can I help you today?',
  'hello': 'Hello! 👋 How can I help you?',
  'hey': 'Hey! 👋 What can I do for you?',
  'hola': '¡Hola! 👋 ¿En qué puedo ayudarte?',
  'bonjour': 'Bonjour! 👋 Comment puis-je vous aider?',
  'привет': 'Привет! 👋 Чем могу помочь?',
  'muraho': 'Muraho! 👋 Nakwigisha iki?',
  
  // Thanks
  'thanks': 'You\'re welcome! 😊',
  'thank you': 'You\'re welcome! Happy to help! 😊',
  'thx': 'You\'re welcome! 😊',
  'merci': 'De rien! 😊',
  'спасибо': 'Пожалуйста! 😊',
  'murakoze': 'Nta kibazo! 😊',
  
  // Bye
  'bye': 'Goodbye! Take care! 👋',
  'goodbye': 'Goodbye! Have a great day! 👋',
  'ciao': 'Ciao! 👋',
  
  // Common questions
  'who are you': 'I\'m Ikamba AI Assistant! 🤖 I help with money transfers to Africa (Rwanda, Uganda, Kenya, etc.), check rates, and track your transfers.',
  'what can you do': 'I can help you:\n💸 Send money to Africa\n📊 Check exchange rates\n📋 Track transfers\n🧾 Get transfer proofs\n\nJust tell me what you need!',
  'help': 'I\'m here to help! I can:\n💸 Send money to Africa\n📊 Check rates\n📋 Track transfers\n\nTry: "send 100 USD to Rwanda" or "what\'s the rate for RUB to RWF?"',
};

// Patterns that need FULL AI (expensive - use GPT-4o)
const COMPLEX_PATTERNS = [
  /send\s+\d+/i,                    // Money transfer
  /transfer\s+\d+/i,               // Money transfer
  /pay\s+\d+/i,                    // Payment
  /my\s+(order|transaction|transfer)/i,  // Order lookup
  /status\s+of/i,                  // Status check
  /proof|receipt|screenshot/i,     // Proof request
  /check.*transaction/i,           // Transaction check
  /[a-zA-Z0-9]{15,}/,             // Transaction ID (long alphanumeric)
  /отправить|перевести|перевод/i,  // Russian transfer words
  /kohereza/i,                     // Kinyarwanda transfer word
  // RATE CALCULATIONS - need smart understanding
  /i\s+(need|want|have)/i,         // "I need 95k rubles", "I have RWF"
  /\d+k?\s*(rub|rwf|usd|eur|ugx|kes|tzs)/i,  // Amount + currency
  /how\s+much.*to\s+(send|pay|get|receive)/i, // "how much to pay"
  /to\s+(get|receive)\s+\d+/i,     // "to get 95000 RUB"
];

// Patterns for SIMPLE AI queries (use GPT-4o-mini - cheaper)
const SIMPLE_PATTERNS = [
  /^rate$/i,                       // Just "rate" alone
  /what.*currency/i,               // Currency info
  /which.*country/i,               // Country info
  /support.*country/i,             // Supported countries
];

// Check if message matches instant response
function getInstantResponse(text) {
  if (!text) return null;
  const normalized = text.toLowerCase().trim();
  
  // Direct match
  if (INSTANT_RESPONSES[normalized]) {
    return INSTANT_RESPONSES[normalized];
  }
  
  // Partial match for greetings
  for (const [pattern, response] of Object.entries(INSTANT_RESPONSES)) {
    if (normalized === pattern || normalized.startsWith(pattern + ' ') || normalized.startsWith(pattern + '!')) {
      return response;
    }
  }
  
  return null;
}

// Determine query complexity for model selection
function getQueryComplexity(text) {
  if (!text) return 'simple';
  
  // Check for complex patterns first
  for (const pattern of COMPLEX_PATTERNS) {
    if (pattern.test(text)) {
      return 'complex';
    }
  }
  
  // Check for simple patterns
  for (const pattern of SIMPLE_PATTERNS) {
    if (pattern.test(text)) {
      return 'simple';
    }
  }
  
  // Default to simple for short messages
  return text.length < 50 ? 'simple' : 'complex';
}

// Cache key generator
function getCacheKey(text, userId) {
  // Only cache rate queries and general info
  const normalized = text.toLowerCase().trim();
  if (/rate|курс|exchange|how much.*to/i.test(normalized)) {
    return `rate:${normalized}`;
  }
  return null; // Don't cache personalized queries
}

// Get cached response
function getCachedResponse(cacheKey) {
  if (!cacheKey) return null;
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`💰 Cache HIT: ${cacheKey}`);
    return cached.response;
  }
  return null;
}

// Set cached response
function setCachedResponse(cacheKey, response) {
  if (!cacheKey) return;
  responseCache.set(cacheKey, { response, timestamp: Date.now() });
  console.log(`💾 Cached: ${cacheKey}`);
  
  // Clean old cache entries periodically
  if (responseCache.size > 100) {
    const now = Date.now();
    for (const [key, value] of responseCache.entries()) {
      if (now - value.timestamp > CACHE_TTL_MS) {
        responseCache.delete(key);
      }
    }
  }
}

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
      
      // ============================================
      // COST OPTIMIZATION: Check for instant response first
      // ============================================
      const instantResponse = getInstantResponse(messageText);
      if (instantResponse && !hasImage) {
        console.log(`⚡ INSTANT response (no API call): "${messageText}"`);
        await sock.sendMessage(sender, { text: instantResponse });
        
        // Still add to context for continuity
        context.push({ role: 'user', content: messageText });
        context.push({ role: 'assistant', content: instantResponse });
        conversationContexts.set(sender, context.slice(-10)); // Keep less context for simple exchanges
        continue;
      }
      
      // ============================================
      // COST OPTIMIZATION: Check cache for rate queries
      // ============================================
      const cacheKey = getCacheKey(messageText, sender);
      const cachedResponse = getCachedResponse(cacheKey);
      if (cachedResponse && !hasImage) {
        console.log(`💰 CACHED response (no API call): "${messageText}"`);
        await sock.sendMessage(sender, { text: formatForWhatsApp(cachedResponse) });
        
        context.push({ role: 'user', content: messageText });
        context.push({ role: 'assistant', content: cachedResponse });
        conversationContexts.set(sender, context.slice(-10));
        continue;
      }
      
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
      
      // ============================================
      // CONTEXT MANAGEMENT: MAXIMUM context for transfer flows
      // ============================================
      const complexity = getQueryComplexity(messageText);
      // Keep MAXIMUM context to remember ALL user info (amount, name, bank, account, etc.)
      const maxContext = complexity === 'complex' ? 40 : 20;
      if (context.length > maxContext) {
        context = context.slice(-maxContext);
      }
      
      try {
        // Show typing indicator
        await sock.sendPresenceUpdate('composing', sender);
        
        // Send welcome message for NEW conversations
        if (isNewConversation) {
          // First API call will include auth status, but send a quick welcome first
          const welcomeMessage = `👋 *Hello! I'm Ikamba AI Assistant*

I help with money transfers to/from Africa.

Let me check your account status...`;
          
          await sock.sendMessage(sender, { text: welcomeMessage });
          console.log(`👋 Sent welcome message to new user: ${sender}`);
          
          // Small delay before processing their actual message
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        // Call Ikamba AI with image data AND complexity hint
        console.log(`🤖 API call (${complexity}): "${messageText?.substring(0, 50)}..."`);
        const aiResponse = await callIkambaAI(context, sender, hasImage, imageDataUrl, complexity);
        
        // Cache the response if applicable
        if (cacheKey && !hasImage) {
          setCachedResponse(cacheKey, aiResponse);
        }
        
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
async function callIkambaAI(messages, userId, hasImage = false, currentImageUrl = null, complexity = 'complex') {
  try {
    // Clean up WhatsApp JID to get just the phone number
    // Format: 250788123456@s.whatsapp.net → 250788123456
    const cleanPhone = userId.replace('@s.whatsapp.net', '').replace('@g.us', '');
    const formattedPhone = cleanPhone.startsWith('+') ? cleanPhone : `+${cleanPhone}`;
    
    // ============================================
    // COST OPTIMIZATION: Use shorter prompts for simple queries
    // ============================================
    let styleHint;
    
    if (complexity === 'simple') {
      // MINIMAL prompt for simple queries (saves tokens!)
      styleHint = `Ikamba AI - helpful money transfer assistant. Be BRIEF (1-2 sentences). Default: English. User phone: ${formattedPhone}`;
    } else {
      // FULL prompt for complex queries - ALL FUNCTIONALITY RESTORED
      styleHint = `You are Ikamba AI - friendly money transfer assistant. Default language: ENGLISH (switch only if user writes in another language).

=== FIRST MESSAGE INTRODUCTION (CRITICAL!) ===
When this is the START of conversation OR user says hi/hello, ALWAYS:
1. Greet user briefly
2. Tell them their VERIFICATION STATUS:
   - If "WHATSAPP USER: ✅ VERIFIED" with name → "Hi [Name]! ✅ You're verified and ready to send money!"
   - If "WHATSAPP USER: ❌ NOT VERIFIED" → "To send money, I need to verify your account first. What's your email address?"
3. Then proceed based on what they asked

Example for VERIFIED user saying "hi":
"Hey! ✅ You're verified as [Name]. Ready to help you send money! What would you like to do?"

Example for UNVERIFIED user saying "hi":
"Hey! 👋 To use Ikamba transfers, I need to link your WhatsApp to your account. What's your email address?"

Example for UNVERIFIED user saying "send 100k rubles":
"I'd love to help you send money! But first, I need to verify your account. What's your email address?"

=== CURRENCY CLARIFICATION (ASK FIRST!) ===
When user says "send X rubles to RWF" or similar:
- ASK: "Just to confirm: You're paying X RUB and recipient gets RWF?"
- "send X to RWF" = User pays X, recipient gets RWF equivalent
- "send X RUB" alone = ASK which currency recipient gets
- Once clear, show calculation: "You pay 5,000 RUB, recipient gets ~87,550 RWF"

=== CORRECT ORDER FLOW (FOLLOW EXACTLY!) ===
1. CHECK AUTH: If not verified → ask for email first
2. CLARIFY CURRENCIES: Which currency you pay? Which recipient receives?
3. CALCULATE: Show the rate
4. COLLECT: Name → Bank/Mobile → Account number
5. PHONE IS OPTIONAL: If user says "I don't know" → SKIP IT, proceed without!
6. PAYMENT METHOD: How will you pay?
7. CREATE ORDER: Call create_transfer_order FIRST
8. SHOW PAYMENT: Only AFTER order created, show payment details

=== CONTEXT MEMORY (MAX PRIORITY!) ===
NEVER forget what user told you! Track:
- Amount: ___
- Pay currency: ___
- Receive currency: ___
- Recipient name: ___
- Delivery method: ___
- Bank/Provider: ___
- Account number: ___
- Payment method: ___

If user says "I don't know" for phone → SET recipientPhone="" and SKIP!
NEVER ask for the same info twice!

=== PAYMENT vs DELIVERY (DON'T CONFUSE!) ===
- PAYMENT METHOD = How USER pays YOU: MTN, Airtel, Sberbank, Cash
- DELIVERY METHOD = How RECIPIENT receives money: Bank (Zigama, BK), Mobile Money (MTN)

When user says "MTN" after "How will you pay?":
→ This is PAYMENT via MTN Mobile Money in Rwanda
→ First call create_transfer_order, THEN show payment details!

=== ORDER CREATION (CRITICAL!) ===
When user confirms or gives payment method:
1. Call create_transfer_order with ALL info collected
2. Order sends emails automatically to user and admin
3. THEN show: "✅ Order created! Pay X to MTN: 0796881028. Send screenshot!"

=== WHATSAPP VERIFICATION FLOW ===
For UNVERIFIED users:
1. Ask email → call request_whatsapp_verification
2. User sends code → call verify_whatsapp_code
3. Only AFTER verified → continue with transfer

=== DON'T ASK FOR ===
❌ Recipient phone if user said "I don't know" - SKIP IT!
❌ Amount again after user said it
❌ Bank name again after user said it
❌ Re-confirmation of obvious things

=== TRANSACTION STATUS & PROOFS ===
- "my orders" → call get_user_transactions_by_status
- Transaction ID → call check_transaction_status
- "send proof" → call get_transfer_proof → [[PROOF_IMAGE:URL]]

=== LANGUAGE ===
- DEFAULT: English
- Switch only if user writes in another language

User phone: ${formattedPhone}`;
    }

    // Add context about image if present
    const imageHint = hasImage 
      ? '\nNote: User sent an image. If it looks like a payment screenshot/receipt, call upload_payment_proof to process it. Otherwise describe briefly.'
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
