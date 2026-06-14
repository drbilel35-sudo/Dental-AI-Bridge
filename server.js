require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7,
  cors: { origin: "*" }
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(express.static('public'));

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Store active sessions
const sessions = new Map();
const users = new Map();

// ============================================
// AI PROMPTS
// ============================================

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

Keep it professional but easy to understand. If the dentist didn't specify something important, note it in the questions section.`;

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

// ============================================
// AI ENGINE
// ============================================
class AIEngine {
  
  async processDentistInstructions(text) {
    try {
      const prompt = `${DENTIST_TO_TECH_PROMPT}\n\nDentist's Instructions: ${text}\n\nProvide the technical specification:`;
      
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      console.error('Gemini Processing Error:', error);
      throw error;
    }
  }

  async processTechnicianNotes(text) {
    try {
      const prompt = `${TECH_TO_DENTIST_PROMPT}\n\nTechnician's Note: ${text}\n\nProvide the dentist update:`;
      
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      console.error('Gemini Processing Error:', error);
      throw error;
    }
  }

  async suggestResponses(technicianNote) {
    try {
      const prompt = `${RESPONSE_SUGGESTION_PROMPT}\n\nLab update: ${technicianNote}`;
      
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      console.error('Gemini Suggestions Error:', error);
      return null;
    }
  }

  analyzeUrgency(text) {
    const urgentKeywords = ['urgent', 'asap', 'immediately', 'problem', 'issue', 
                           'wrong', 'doesn\'t fit', 'crack', 'break', 'broken',
                           'remake', 'redo', 'critical', 'failed'];
    const lowerText = text.toLowerCase();
    
    let urgencyScore = 0;
    urgentKeywords.forEach(keyword => {
      if (lowerText.includes(keyword)) urgencyScore += 1;
    });

    if (urgencyScore >= 3) return 'critical';
    if (urgencyScore >= 1) return 'urgent';
    return 'normal';
  }
}

const aiEngine = new AIEngine();

// ============================================
// SOCKET.IO - Communication
// ============================================
io.on('connection', (socket) => {
  console.log(`🦷 New connection: ${socket.id}`);

  // User Registration
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

    // Notify opposite role
    const notifyRole = user.role === 'dentist' ? 'technician' : 'dentist';
    io.to(`role:${notifyRole}`).emit('notification', {
      type: 'info',
      title: `${user.role === 'dentist' ? 'Dentist' : 'Technician'} Online`,
      message: `${user.name} is now connected`,
      timestamp: new Date().toISOString()
    });

    updateOnlineUsers(user.labId);
  });

  // Dentist sends instructions
  socket.on('dentist-instruction', async (data) => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'dentist') {
      socket.emit('error', { message: 'Only dentists can send instructions' });
      return;
    }

    const caseId = data.caseId || `CASE-${Date.now()}`;
    const timestamp = new Date().toISOString();

    // Initialize session if new
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

    // Store original message
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

    // Broadcast raw message to technicians
    io.to('role:technician').emit('new-message', {
      ...originalMessage,
      aiStatus: 'processing'
    });

    // AI Processing indicator
    io.to('role:technician').emit('ai-processing', {
      caseId,
      status: 'analyzing',
      preview: data.message.substring(0, 80)
    });

    try {
      // AI translates for technician
      const aiResponse = await aiEngine.processDentistInstructions(data.message);
      const quickSummary = await generateQuickSummary(data.message);

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

      // Send AI analysis to technicians
      io.to('role:technician').emit('ai-response', aiMessage);
      
      // Confirm to dentist
      socket.emit('ai-confirmation', {
        message: 'Your instructions have been processed and sent to the lab.',
        aiSummary: quickSummary,
        caseId
      });

      // Notify technicians
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
      io.to(`lab:${user.labId}`).emit('ai-error', {
        caseId,
        message: 'Failed to process instructions. Please try again.'
      });
      io.to('role:technician').emit('ai-processing', { caseId, status: 'error' });
    }
  });

  // Technician sends notes/questions
  socket.on('technician-note', async (data) => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'technician') {
      socket.emit('error', { message: 'Only technicians can send notes' });
      return;
    }

    const timestamp = new Date().toISOString();
    const session = sessions.get(data.caseId);
    
    if (!session) {
      socket.emit('error', { message: 'Case not found. Please use a valid case ID.' });
      return;
    }

    session.technician = user;
    const urgency = aiEngine.analyzeUrgency(data.message);

    // Store technician's original note
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

    // Send raw note to dentist immediately
    io.to('role:dentist').emit('new-message', techMessage);

    // AI translates for dentist
    io.to('role:dentist').emit('ai-processing', {
      caseId: data.caseId,
      status: 'translating',
      preview: 'Lab is updating you...'
    });

    try {
      const aiForDentist = await aiEngine.processTechnicianNotes(data.message);
      const suggestedResponses = await aiEngine.suggestResponses(data.message);
      const quickSummary = await generateQuickSummary(data.message);

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

      // Send AI translation to dentist
      io.to('role:dentist').emit('ai-response', aiMessage);

      // Confirm to technician
      socket.emit('ai-confirmation', {
        message: 'Your note has been sent to the dentist.',
        aiSummary: quickSummary,
        caseId: data.caseId
      });

      // Notification based on urgency
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
      console.error('AI Tech-to-Dentist Error:', error);
      socket.emit('ai-error', {
        caseId: data.caseId,
        message: 'Failed to process your note. The dentist can still see your original message.'
      });
      io.to('role:dentist').emit('ai-processing', { caseId: data.caseId, status: 'complete' });
    }
  });

  // Case status update
  socket.on('case-status-update', (data) => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'technician') return;

    const session = sessions.get(data.caseId);
    if (!session) return;

    const oldStatus = session.status;
    session.status = data.status;
    
    session.messages.push({
      id: `status-${Date.now()}`,
      type: 'status-update',
      sender: user.name,
      senderRole: 'technician',
      content: `Case status updated: ${oldStatus} → ${data.status}`,
      caseId: data.caseId,
      status: data.status,
      timestamp: new Date().toISOString()
    });

    io.to('role:dentist').emit('case-status-changed', {
      caseId: data.caseId,
      oldStatus,
      newStatus: data.status,
      updatedBy: user.name
    });

    io.to('role:dentist').emit('notification', {
      type: 'info',
      title: '📊 Status Update',
      message: `Case ${data.caseId}: ${data.status}`,
      caseId: data.caseId
    });
  });

  // Dentist replies to technician
  socket.on('dentist-reply', (data) => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'dentist') return;

    const session = sessions.get(data.caseId);
    if (!session) return;

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

    session.messages.push(replyMessage);

    io.to('role:technician').emit('new-message', replyMessage);
    io.to('role:technician').emit('notification', {
      type: 'success',
      title: '💬 Dentist Reply',
      message: `${user.name} responded to case ${data.caseId}`,
      caseId: data.caseId
    });
  });

  // General chat message
  socket.on('chat-message', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const message = {
      id: `chat-${Date.now()}`,
      type: 'chat',
      sender: user.name,
      senderId: socket.id,
      senderRole: user.role,
      content: data.message,
      timestamp: new Date().toISOString(),
      caseId: data.caseId
    };

    const session = sessions.get(data.caseId);
    if (session) session.messages.push(message);

    io.to(`lab:${user.labId}`).emit('new-message', message);
  });

  // Typing indicator
  socket.on('typing', (data) => {
    const user = users.get(socket.id);
    socket.to(`lab:${user?.labId || 'default-lab'}`).emit('user-typing', {
      userId: socket.id,
      name: user?.name,
      role: user?.role,
      caseId: data.caseId,
      isTyping: data.isTyping
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      user.isOnline = false;
      const otherRole = user.role === 'dentist' ? 'technician' : 'dentist';
      io.to(`role:${otherRole}`).emit('notification', {
        type: 'info',
        title: `${user.role === 'dentist' ? 'Dentist' : 'Technician'} Offline`,
        message: `${user.name} went offline`,
        timestamp: new Date().toISOString()
      });
      users.delete(socket.id);
      updateOnlineUsers(user.labId);
    }
  });
});

// ============================================
// HELPER FUNCTIONS
// ============================================
async function generateQuickSummary(text) {
  try {
    const prompt = `Summarize this dental instruction in 10 words or less. Be specific about the dental work:\n\n${text}`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text().trim();
  } catch (error) {
    return 'Lab update';
  }
}

function updateOnlineUsers(labId) {
  const labUsers = Array.from(users.values())
    .filter(u => u.labId === labId && u.isOnline)
    .map(u => ({
      id: u.id,
      name: u.name,
      role: u.role
    }));

  io.to(`lab:${labId}`).emit('online-users', labUsers);
}

// ============================================
// API ROUTES
// ============================================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    activeUsers: users.size,
    activeSessions: sessions.size,
    uptime: process.uptime()
  });
});

app.get('/api/session/:caseId', (req, res) => {
  const session = sessions.get(req.params.caseId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    caseId: session.caseId,
    status: session.status,
    messages: session.messages,
    createdAt: session.createdAt
  });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   🦷 DentalAI Bridge - Operational   ║
  ║   Port: ${PORT}                        ║
  ║   AI: Google Gemini                  ║
  ║   Status: Ready for communication    ║
  ╚═══════════════════════════════════════╝
  `);
});
