import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';

// Configuration
const IKAMBA_API_URL = process.env.IKAMBA_API_URL || 'https://hpersona.vercel.app/api/chat';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Store conversation contexts
const conversationContexts = new Map();

// Logger
const logger = pino({ level: 'silent' });

// Create media folder
const mediaDir = './media';
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

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
    }
    
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      
      console.log('Connection closed due to', lastDisconnect?.error?.message || 'unknown reason');
      
      if (shouldReconnect) {
        console.log('Reconnecting...');
        connectToWhatsApp();
      } else {
        console.log('Logged out. Delete auth_info folder and restart to re-login.');
      }
    } else if (connection === 'open') {
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
  
  return formatted;
}

// Call Ikamba AI API
async function callIkambaAI(messages, userId, hasImage = false) {
  try {
    // Add context about image if present
    const systemHint = hasImage 
      ? 'The user has sent an image. If it appears to be a payment screenshot, acknowledge it and ask them to confirm the payment details.'
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
        systemHint,
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
