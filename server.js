require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const compression = require('compression');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // Allow WebSocket on Render
  transports: ['websocket', 'polling']
});

// Middleware
app.use(compression());
app.use(express.static('public'));

// Health check for Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Store sessions and users
const sessions = new Map();
const users = new Map();

// AI Prompts
const DENTIST_TO_TECH_PROMPT = `You are DentalBridge AI, an expert dental laboratory technician with 20 years of experience. 

Translate the dentist's instructions into precise, actionable technical specifications for dental technicians.

STRUCTURE YOUR RESPONSE EXACTLY AS FOLLOWS:

📋 **RESTORATION SPECIFICATION**
• Type: [exact restoration type]
• Tooth/Teeth: [FDI and US notation]
• Material: [specific material]

🔬 **TECHNICAL PARAMETERS**
• Margin: [type, depth recommendation]
• Reduction: [occlusal/axial requirements in mm]
• Contacts: [proximal and occlusal specifications]
• Occlusion: [scheme and clearance]

🎨 **AESTHETIC SPECS**
• Shade: [with guide type]
• Translucency: [recommendation]
• Surface: [texture and finish]

⚙️ **FABRICATION STEPS**
[Numbered workflow steps]

⚠️ **QC CHECKLIST**
[Critical checks to perform]

❓ **QUESTIONS FOR DENTIST** (if any critical info is missing)
[Specific, actionable questions]

Keep it professional but easy to understand.`;

const TECH_TO_DENTIST_PROMPT = `You are DentalBridge AI, a skilled dental communicator.

Translate this technician's note into a clear, professional update for the dentist.

FORMAT YOUR RESPONSE EXACTLY AS:

📝 **LAB UPDATE**
[One-line summary of the technician's note]

🔧 **TECHNICAL DETAILS**
[Key specifications or findings the dentist needs to know]

⚠️ **ACTION NEEDED** (if applicable)
[What the dentist needs to do, if anything]

💡 **LAB RECOMMENDATION**
[Professional suggestion from the lab]

Always maintain a collaborative, professional tone. Be concise.`;

const RESPONSE_SUGGESTION_PROMPT = `Based on this lab technician's update, suggest exactly 3 brief response options a dentist can send. Keep each response under 15 words. Make them practical and actionable.

Format as a simple numbered list:
1. [first response option]
2. [second response option]
3. [third response option]`;

// Socket.IO Events
io.on('connection', (socket) => {
  console.log(`🦷 New connection: ${socket.id}`);

  socket.on('register', (data) => {
    const user = {
      id: socket.id,
      name: data.name || 'Unnamed',
      role: data.role || 'dentist',
      labId: data.labId || 'default-lab',
      labName: data.labName || 'Dental Lab',
      joinedAt: new Date().toISOString(),
      isOnline: true
    };

    users.set(socket.id, user);
    socket.join(`lab:${user.labId}`);
    socket.join(`role:${user.role}`);

    socket.emit('registered', {
      userId: socket.id,
      message: `Connected to ${user.labName} as ${user.role}`
    });

    const notifyRole = user.role === 'dentist' ? 'technician' : 'dentist';
    io.to(`role:${notifyRole}`).emit('notification', {
      type: 'info',
      title: `${user.role === 'dentist' ? 'Dentist' : 'Technician'} Online`,
      message: `${user.name} is now connected`,
      timestamp: new Date().toISOString()
    });

    updateOnlineUsers(user.labId);
  });

  socket.on('dentist-instruction', async (data) => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'dentist') return;

    const caseId = data.caseId || `CASE-${Date.now()}`;
    const timestamp = new Date().toISOString();

    if (!sessions.has(caseId)) {
      sessions.set(caseId, {
        caseId,
        messages: [],
        dentist: user,
        createdAt: timestamp,
        status: 'instructions_received'
      });
    }

    const session = sessions.get(caseId);
    const originalMessage = {
      id: `msg-${Date.now()}`,
      type: 'dentist-instruction',
      sender: user.name,
      senderId: socket.id,
      senderRole: 'dentist',
      content: data.message,
      timestamp,
      caseId
    };
    session.messages.push(originalMessage);

    io.to('role:technician').emit('new-message', { ...originalMessage, aiStatus: 'processing' });
    io.to('role:technician').emit('ai-processing', { caseId, status: 'analyzing', preview: data.message.substring(0, 80) });

    try {
      const prompt = `${DENTIST_TO_TECH_PROMPT}\n\nDentist's Instructions: ${data.message}\n\nProvide the technical specification:`;
      const result = await model.generateContent(prompt);
      const aiResponse = result.response.text();

      const summaryPrompt = `Summarize this dental instruction in 10 words or less:\n\n${data.message}`;
      const summaryResult = await model.generateContent(summaryPrompt);
      const quickSummary = summaryResult.response.text().trim();

      const aiMessage = {
        id: `ai-tech-${Date.now()}`,
        type: 'ai-analysis-for-tech',
        sender: 'DentalAI Bridge',
        senderId: 'ai',
        content: aiResponse,
        quickSummary,
        timestamp: new Date().toISOString(),
        caseId,
        originalMessageId: originalMessage.id,
        direction: 'dentist-to-tech'
      };

      session.messages.push(aiMessage);
      io.to('role:technician').emit('ai-response', aiMessage);
      socket.emit('ai-confirmation', { message: 'Instructions processed and sent to the lab.', aiSummary: quickSummary, caseId });
      io.to('role:technician').emit('notification', {
        type: 'success',
        title: '📋 New Case Instructions',
        message: `${user.name}: ${quickSummary}`,
        caseId,
        timestamp: new Date().toISOString()
      });
      io.to('role:technician').emit('ai-processing', { caseId, status: 'complete' });

    } catch (error) {
      console.error('AI Processing failed:', error);
      io.to(`lab:${user.labId}`).emit('ai-error', { caseId, message: 'Failed to process instructions.' });
      io.to('role:technician').emit('ai-processing', { caseId, status: 'error' });
    }
  });

  socket.on('technician-note', async (data) => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'technician') return;

    const timestamp = new Date().toISOString();
    const session = sessions.get(data.caseId);
    if (!session) return;

    session.technician = user;
    const urgency = analyzeUrgency(data.message);

    const techMessage = {
      id: `tech-${Date.now()}`,
      type: 'technician-note',
      sender: user.name,
      senderId: socket.id,
      senderRole: 'technician',
      content: data.message,
      timestamp,
      caseId: data.caseId
    };
    session.messages.push(techMessage);

    io.to('role:dentist').emit('new-message', techMessage);
    io.to('role:dentist').emit('ai-processing', { caseId: data.caseId, status: 'translating' });

    try {
      const prompt = `${TECH_TO_DENTIST_PROMPT}\n\nTechnician's Note: ${data.message}\n\nProvide the dentist update:`;
      const result = await model.generateContent(prompt);
      const aiForDentist = result.response.text();

      const suggestPrompt = `${RESPONSE_SUGGESTION_PROMPT}\n\nLab update: ${data.message}`;
      const suggestResult = await model.generateContent(suggestPrompt);
      const suggestedResponses = suggestResult.response.text();

      const summaryPrompt = `Summarize this in 10 words or less:\n\n${data.message}`;
      const summaryResult = await model.generateContent(summaryPrompt);
      const quickSummary = summaryResult.response.text().trim();

      const aiMessage = {
        id: `ai-dentist-${Date.now()}`,
        type: 'ai-translation-for-dentist',
        sender: 'DentalAI Bridge',
        senderId: 'ai',
        content: aiForDentist,
        suggestedResponses,
        quickSummary,
        timestamp: new Date().toISOString(),
        caseId: data.caseId,
        originalMessageId: techMessage.id,
        direction: 'tech-to-dentist',
        urgency
      };

      session.messages.push(aiMessage);
      io.to('role:dentist').emit('ai-response', aiMessage);
      socket.emit('ai-confirmation', { message: 'Note sent to dentist.', aiSummary: quickSummary, caseId: data.caseId });

      if (urgency === 'urgent' || urgency === 'critical') {
        io.to('role:dentist').emit('urgent-notification', {
          type: 'warning',
          title: '⚠️ Urgent Lab Update',
          message: `${user.name}: ${quickSummary}`,
          caseId: data.caseId,
          timestamp: new Date().toISOString()
        });
      } else {
        io.to('role:dentist').emit('notification', {
          type: 'info',
          title: '📝 Lab Update',
          message: `${user.name}: ${quickSummary}`,
          caseId: data.caseId,
          timestamp: new Date().toISOString()
        });
      }

      io.to('role:dentist').emit('ai-processing', { caseId: data.caseId, status: 'complete' });

    } catch (error) {
      console.error('AI Error:', error);
      socket.emit('ai-error', { caseId: data.caseId, message: 'Failed to process note.' });
      io.to('role:dentist').emit('ai-processing', { caseId: data.caseId, status: 'complete' });
    }
  });

  socket.on('case-status-update', (data) => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'technician') return;

    const session = sessions.get(data.caseId);
    if (!session) return;

    const oldStatus = session.status;
    session.status = data.status;

    io.to('role:dentist').emit('case-status-changed', {
      caseId: data.caseId,
      oldStatus,
      newStatus: data.status,
      updatedBy: user.name
    });
  });

  socket.on('dentist-reply', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const replyMessage = {
      id: `reply-${Date.now()}`,
      type: 'dentist-reply',
      sender: user.name,
      senderId: socket.id,
      senderRole: 'dentist',
      content: data.message,
      timestamp: new Date().toISOString(),
      caseId: data.caseId
    };

    const session = sessions.get(data.caseId);
    if (session) session.messages.push(replyMessage);

    io.to('role:technician').emit('new-message', replyMessage);
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      user.isOnline = false;
      users.delete(socket.id);
      updateOnlineUsers(user.labId);
    }
  });
});

// Helper functions
function analyzeUrgency(text) {
  const urgentKeywords = ['urgent', 'asap', 'immediately', 'problem', 'issue', 'wrong', 'doesn\'t fit', 'crack', 'break', 'broken', 'remake', 'redo', 'critical', 'failed'];
  const lowerText = text.toLowerCase();
  let score = 0;
  urgentKeywords.forEach(kw => { if (lowerText.includes(kw)) score++; });
  if (score >= 3) return 'critical';
  if (score >= 1) return 'urgent';
  return 'normal';
}

function updateOnlineUsers(labId) {
  const labUsers = Array.from(users.values())
    .filter(u => u.labId === labId && u.isOnline)
    .map(u => ({ id: u.id, name: u.name, role: u.role }));
  io.to(`lab:${labId}`).emit('online-users', labUsers);
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🦷 DentalAI Bridge running on port ${PORT}`);
});
