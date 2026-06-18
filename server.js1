require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const compression = require('compression');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});

app.use(compression());
app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const SYSTEM_PROMPT = `You are DentalAI, a real-time AI assistant for dental laboratories. You communicate directly with dentists and dental technicians.

YOUR ROLE:
- Help dentists describe cases clearly
- Help technicians understand exactly what to fabricate
- Ask clarifying questions when details are missing
- Provide technical recommendations based on dental lab best practices
- Be conversational, professional, and efficient

WHEN A DENTIST DESCRIBES A CASE:
1. Acknowledge what you understood
2. List the key specifications
3. Ask about any missing critical details
4. Give your technical recommendation

CRITICAL DETAILS TO ALWAYS VERIFY:
- Tooth number(s) with notation
- Restoration type
- Material choice
- Shade and shade guide
- Margin type and depth
- Opposing dentition
- Contacts and occlusion requirements
- Due date or priority

FOR IMPLANT CASES, ASK:
- Implant system, platform, connection type
- Abutment preference
- Screw-retained or cement-retained
- Gingival height

DEFAULT ASSUMPTIONS (state them):
- Shade guide: VITA Classical unless specified
- Material: Recommend based on tooth position and case type
- Margin: Ask to confirm

Keep responses helpful, clear, and actionable. Think like an experienced lab technician helping both the dentist and your fellow technicians.`;

const conversations = new Map();

io.on('connection', (socket) => {
  console.log(`🟢 Connected: ${socket.id}`);

  if (!conversations.has(socket.id)) {
    conversations.set(socket.id, []);
  }

  socket.on('send-message', async (data) => {
    const userMessage = data.message;
    const history = conversations.get(socket.id) || [];

    console.log(`📩 [${socket.id}]: ${userMessage.substring(0, 80)}`);

    socket.emit('bot-typing', true);

    try {
      const chatHistory = [
        {
          role: "user",
          parts: [{ text: SYSTEM_PROMPT }]
        },
        {
          role: "model",
          parts: [{ text: "I understand my role as DentalAI, a dental lab assistant. I'm ready to help with cases." }]
        }
      ];

      const recentHistory = history.slice(-20);
      recentHistory.forEach(msg => {
        chatHistory.push({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: msg.content }]
        });
      });

      const chat = model.startChat({
        history: chatHistory,
        generationConfig: {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 1000,
        }
      });

      const result = await chat.sendMessage(userMessage);
      const responseText = result.response.text();

      history.push({ role: 'user', content: userMessage });
      history.push({ role: 'assistant', content: responseText });
      conversations.set(socket.id, history);

      socket.emit('bot-typing', false);
      socket.emit('bot-message', {
        message: responseText,
        timestamp: new Date().toISOString()
      });

      console.log(`🤖 [${socket.id}]: ${responseText.substring(0, 80)}`);

    } catch (error) {
      console.error(`❌ Error:`, error.message);
      socket.emit('bot-typing', false);
      socket.emit('bot-message', {
        message: "I'm sorry, I encountered an error. Please try again or rephrase your message.",
        timestamp: new Date().toISOString()
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔴 Disconnected: ${socket.id}`);
    conversations.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🦷 DentalAI Chatbot running on http://localhost:${PORT}\n`);
});
