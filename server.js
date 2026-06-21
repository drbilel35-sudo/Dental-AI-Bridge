// server.js - AURA Lab Dental AI Backend
// Serves the frontend and provides API endpoints for the dental lab assistant.

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Support large image payloads
app.use(express.static(path.join(__dirname))); // Serve static frontend files

// -------------------- In-Memory Data Stores (demo) --------------------
const casesDB = [
  { id: 'D2421', dentist: 'Dr. Fatima', patient: 'Ahmed S.', type: 'Crown 11', status: 'received', scan: true, rx: true, notes: 'Full contour Zr A2' },
  { id: 'D2425', dentist: 'Dr. Omar', patient: 'Laila K.', type: 'Bridge 24-26', status: 'received', scan: true, rx: false, notes: 'Missing shade info' },
  { id: 'D2418', dentist: 'Dr. Sara', patient: 'Khaled M.', type: 'Crown', status: 'design', scan: true, rx: true, assignedTo: 'CAD Sara' },
  { id: 'D2401', dentist: 'Dr. Hassan', patient: 'Noora A.', type: 'Implant', status: 'manufacturing', scan: true, rx: true },
  { id: 'D2392', dentist: 'Dr. Alia', patient: 'Rashid B.', type: 'Crown', status: 'dispatched', scan: true, rx: true, courier: 'Aramex' },
];

const messagesDB = [
  { from: 'Dr. Alia', channel: 'whatsapp', message: 'Need full contour zirconia, shade A2, copy margin design from case #D2210.', translatedNote: 'Zr full contour A2, copy margin #D2210', timestamp: new Date().toISOString() },
  { from: 'Dr. Rashid', channel: 'email', message: 'Please rush case #D2421, patient traveling.', translatedNote: 'Priority flag · notified production', timestamp: new Date().toISOString() },
];

// -------------------- Helper: Simulate AI translation (demo) --------------------
function generateTechnicianNote(dentistMessage) {
  // In production, this calls an NLP model. Demo uses keyword extraction.
  const lower = dentistMessage.toLowerCase();
  if (lower.includes('zirconia') || lower.includes('zr')) return 'Zr restoration, follow prescription.';
  if (lower.includes('pfm')) return 'PFM bridge, subtractive design.';
  if (lower.includes('rush') || lower.includes('urgent')) return 'PRIORITY: expedite case.';
  return 'Standard case, process as per RX.';
}

// -------------------- API Routes --------------------

// Health check endpoint
app.get('/api/health', (req, res) => {
  const hasApiKey = !!process.env.OPENAI_API_KEY || !!process.env.GEMINI_API_KEY;
  res.json({
    status: 'online',
    hasApiKey: hasApiKey,
    workingModel: hasApiKey ? 'AURA Lab AI v2.4' : 'Demo mode (no key)',
    timestamp: new Date().toISOString(),
  });
});

// Chat endpoint: receives dentist message and returns AI response
app.post('/api/chat', (req, res) => {
  try {
    const { message, imageData, isCommand } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required.' });
    }

    // Simulate AI processing delay
    const delay = 400;
    setTimeout(() => {
      // Determine emotion based on content (demo)
      let emotion = 'NEUTRAL';
      const msg = message.toLowerCase();
      if (msg.includes('urgent') || msg.includes('rush')) emotion = 'INTEREST';
      else if (msg.includes('thank') || msg.includes('great')) emotion = 'JOY';
      else if (msg.includes('missing') || msg.includes('error')) emotion = 'CONFUSION';

      // Generate technician-friendly note
      const technicianNote = generateTechnicianNote(message);
      
      // Store message in history (demo)
      messagesDB.push({
        from: 'Dentist',
        channel: 'chat',
        message: message,
        translatedNote: technicianNote,
        timestamp: new Date().toISOString(),
      });

      // Build response text
      let responseText = '';
      if (isCommand) {
        responseText = `AURA Lab: Command executed. ${technicianNote}`;
      } else {
        responseText = `AURA: I've translated the instructions for the lab team. ${technicianNote} I'm tracking the case and will notify you of any updates.`;
      }

      // If image data was sent, acknowledge vision capability
      if (imageData) {
        responseText += ' I also received the attached image/scan for analysis.';
      }

      res.json({
        success: true,
        text: responseText,
        emotion: emotion,
        sources: [
          { title: 'Dental Lab Protocol v2.4', uri: '#' },
          { title: 'Case Translation Engine', uri: '#' },
        ],
        technicianNote: technicianNote,
      });
    }, delay);

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// TTS (Text-to-Speech) endpoint (demo - returns placeholder)
app.post('/api/tts', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ success: false, error: 'Text required.' });
  
  // In production, integrate with Google TTS / ElevenLabs.
  res.json({ 
    success: true, 
    message: 'TTS audio generated (demo).',
    audioUrl: null // Real implementation returns base64 or URL
  });
});

// Get all cases with status
app.get('/api/cases', (req, res) => {
  res.json({ success: true, cases: casesDB });
});

// Update case status
app.put('/api/cases/:id', (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;
  const caseItem = casesDB.find(c => c.id === id);
  if (!caseItem) return res.status(404).json({ success: false, error: 'Case not found.' });
  
  if (status) caseItem.status = status;
  if (notes) caseItem.notes = notes;
  res.json({ success: true, case: caseItem });
});

// Get messages/conversations
app.get('/api/messages', (req, res) => {
  res.json({ success: true, messages: messagesDB });
});

// Simulate scan detection webhook (for 3Shape / intraoral scanners)
app.post('/api/scan-webhook', (req, res) => {
  const { scanId, dentist, patient, type } = req.body;
  if (!scanId || !dentist) return res.status(400).json({ success: false, error: 'Missing scan data.' });
  
  const newCaseId = `D${Date.now().toString().slice(-5)}`;
  casesDB.push({
    id: newCaseId,
    dentist: dentist,
    patient: patient || 'Unknown',
    type: type || 'Crown',
    status: 'received',
    scan: true,
    rx: false,
    notes: 'New scan detected – awaiting prescription.',
  });
  
  console.log(`🦷 New scan received: ${newCaseId} from ${dentist}`);
  res.json({ 
    success: true, 
    message: `Scan processed. Case ${newCaseId} created. Technician notified.`,
    caseId: newCaseId 
  });
});

// Simulate WhatsApp incoming message webhook
app.post('/api/whatsapp-webhook', (req, res) => {
  const { from, message } = req.body;
  if (!from || !message) return res.status(400).json({ success: false, error: 'Missing data.' });
  
  const note = generateTechnicianNote(message);
  messagesDB.push({
    from: from,
    channel: 'whatsapp',
    message: message,
    translatedNote: note,
    timestamp: new Date().toISOString(),
  });
  
  console.log(`📱 WhatsApp from ${from}: translated → ${note}`);
  res.json({ success: true, translatedNote: note });
});

// -------------------- Serve Frontend (SPA fallback) --------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// -------------------- Start Server --------------------
app.listen(PORT, () => {
  console.log(`
  🦷 AURA Lab Dental AI Server running on http://localhost:${PORT}
  📡 API endpoints:
     - POST /api/chat          (AI communication)
     - GET  /api/health        (status check)
     - GET  /api/cases         (all cases)
     - POST /api/scan-webhook  (intraoral scan detection)
     - POST /api/whatsapp-webhook (WhatsApp integration)
  🌐 Serving static frontend from ${__dirname}
  `);
});
