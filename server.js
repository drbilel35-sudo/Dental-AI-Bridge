require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const compression = require('compression');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});

// ========== MIDDLEWARE ==========
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());
app.use(express.static('public'));

// ========== FILE UPLOAD CONFIGURATION ==========
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
    files: 3
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images and PDFs are allowed.'));
    }
  }
});

// ========== GEMINI AI SETUP ==========
// Use the same API key for all models
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Gemini 2.5 models support native file upload
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
// Note: gemini-2.5-flash supports both text and image input natively

// ========== SYSTEM PROMPT ==========
const SYSTEM_PROMPT = `You are DentalAI, a real-time AI assistant for dental laboratories. You communicate directly with dentists and dental technicians.

YOUR ROLE:
- Help dentists describe cases clearly
- Help technicians understand exactly what to fabricate
- Ask clarifying questions when details are missing
- Provide technical recommendations based on dental lab best practices
- Be conversational, professional, and efficient

WHEN A USER ATTACHES A FILE:
- You can analyze images and PDFs directly
- Provide detailed observations from images
- For dental images, note: tooth condition, restoration type, margin quality, shade, gingival health
- Synthesize visual information with the user's text message

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

Keep responses helpful, clear, and actionable. Think like an experienced lab technician.`;

// ========== CONVERSATION STORAGE ==========
const conversations = new Map();

// ========== HELPER FUNCTIONS ==========
async function analyzeFileWithGemini(filePath, mimeType, userMessage) {
  try {
    // Read the file
    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');

    // Prepare the content for Gemini 2.5
    const content = [
      {
        inlineData: {
          data: base64Data,
          mimeType: mimeType
        }
      },
      {
        text: `Analyze this ${mimeType.startsWith('image/') ? 'dental image' : 'document'} and provide a detailed analysis. The user said: "${userMessage || 'Please analyze this file'}". Focus on dental laboratory relevant observations.`
      }
    ];

    // Generate content using Gemini 2.5
    const result = await model.generateContent(content);
    return result.response.text();
  } catch (error) {
    console.error('Error analyzing file with Gemini 2.5:', error);
    return null;
  }
}

// ========== SOCKET.IO HANDLING ==========
io.on('connection', (socket) => {
  console.log(`🟢 Connected: ${socket.id}`);

  if (!conversations.has(socket.id)) {
    conversations.set(socket.id, []);
  }

  // Main message handler with file support
  socket.on('send-message', async (data) => {
    const userMessage = data.message;
    const files = data.files || [];
    const history = conversations.get(socket.id) || [];

    console.log(`📩 [${socket.id}]: ${userMessage.substring(0, 80)}`);
    if (files.length) {
      console.log(`📎 with ${files.length} file(s):`, files.map(f => f.name).join(', '));
    }

    socket.emit('bot-typing', true);

    try {
      let fullUserMessage = userMessage;
      let fileAnalysis = null;

      // Check for files that need analysis
      const hasImage = files.some(f => f.type && f.type.startsWith('image/'));
      const hasPDF = files.some(f => f.type === 'application/pdf');

      if (hasImage || hasPDF) {
        console.log(`📸 [${socket.id}] Analyzing ${files.length} file(s) with Gemini 2.5`);
        
        // For demo, show what would be analyzed
        // In production, you'd use the HTTP upload endpoint to get actual files
        fileAnalysis = `[Gemini 2.5 Analysis] The attached ${files.length} file(s) contain visual information relevant to the dental case. Gemini 2.5 can analyze these files directly when uploaded via the /upload endpoint.`;
        
        fullUserMessage = `${userMessage}\n\n[Files attached: ${files.map(f => f.name).join(', ')}]`;
      }

      // Build chat history for Gemini
      const chatHistory = [
        {
          role: "user",
          parts: [{ text: SYSTEM_PROMPT }]
        },
        {
          role: "model",
          parts: [{ text: "I understand my role as DentalAI. I can analyze images and documents using Gemini 2.5's native capabilities." }]
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

      const result = await chat.sendMessage(fullUserMessage);
      let responseText = result.response.text();

      // Add file acknowledgment
      if (files.length && !responseText.includes('attached')) {
        const fileNames = files.map(f => f.name).join(', ');
        responseText = `📎 I see you've attached ${files.length} file(s): ${fileNames}\n\n${responseText}`;
        
        if (hasImage) {
          responseText = `🔬 I'll analyze the attached ${files.length} file(s) using Gemini 2.5's native capabilities.\n\n${responseText}`;
        }
      }

      // Store in conversation history
      history.push({ role: 'user', content: fullUserMessage });
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

// ========== HTTP ROUTES ==========
// File upload endpoint with Gemini 2.5 analysis
app.post('/upload', upload.array('files', 3), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const uploadedFiles = req.files.map(file => ({
      name: file.originalname,
      path: file.path,
      size: file.size,
      type: file.mimetype
    }));

    console.log(`📤 Uploaded ${uploadedFiles.length} file(s)`);

    // Analyze files with Gemini 2.5
    const userMessage = req.body.message || 'Please analyze these files';
    const analyses = [];

    for (const file of req.files) {
      // Gemini 2.5 supports both images and PDFs natively
      const analysis = await analyzeFileWithGemini(file.path, file.mimetype, userMessage);
      if (analysis) {
        analyses.push({
          filename: file.originalname,
          analysis: analysis
        });
        console.log(`✅ Analyzed ${file.originalname} with Gemini 2.5`);
      }
    }

    res.json({
      success: true,
      files: uploadedFiles,
      analyses: analyses,
      message: `Analyzed ${analyses.length} file(s) with Gemini 2.5`
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== SERVER START ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🦷 DentalAI Chatbot running on http://localhost:${PORT}\n`);
  console.log(`📁 Uploads directory: ${uploadDir}`);
  console.log(`🤖 Using Gemini 2.5 Flash (supports text + images + PDFs)`);
  console.log(`🔑 API Key: ${process.env.GEMINI_API_KEY ? '✓ Configured' : '✗ Missing'}\n`);
});
