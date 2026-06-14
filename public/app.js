class DentalAIBridge {
  constructor() {
    this.socket = null;
    this.user = null;
    this.currentCaseId = null;
    this.isConnected = false;
    this.init();
  }

  init() {
    document.querySelectorAll('.role-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.role-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    document.getElementById('connectBtn').addEventListener('click', () => this.connect());
  }

  connect() {
    const role = document.querySelector('.role-btn.active')?.dataset.role;
    const name = document.getElementById('userName').value.trim();
    const labName = document.getElementById('labName').value.trim();
    const caseId = document.getElementById('caseId').value.trim();

    if (!name) { this.showToast('error', 'Please enter your name'); return; }

    this.user = { role, name, labName };
    this.currentCaseId = caseId || `CASE-${Date.now()}`;

    this.socket = io();

    this.socket.on('connect', () => {
      this.socket.emit('register', { name, role, labId: 'main-lab', labName });
      this.isConnected = true;
      this.showChatScreen();
      this.bindSocketEvents();
      this.bindChatEvents();
      this.showToast('success', `Connected as ${role}`);
    });

    this.socket.on('connect_error', () => {
      this.showToast('error', 'Connection failed. Please try again.');
    });
  }

  showChatScreen() {
    document.getElementById('connection-screen').classList.add('hidden');
    document.getElementById('chat-screen').classList.remove('hidden');

    document.getElementById('sidebarCaseId').textContent = this.currentCaseId;
    
    const input = document.getElementById('messageInput');
    if (this.user.role === 'dentist') {
      input.placeholder = 'Type your instructions naturally...';
      document.getElementById('chatTitle').textContent = 'Sending Instructions';
    } else {
      input.placeholder = 'Type notes, questions, or updates...';
      document.getElementById('chatTitle').textContent = 'Lab Communication';
      document.getElementById('technicianActions').classList.remove('hidden');
      document.getElementById('aiPanel').style.display = 'flex';
    }
    
    document.getElementById('chatSubtitle').textContent = `Connected to ${this.user.labName}`;
  }

  bindSocketEvents() {
    if (!this.socket) return;

    this.socket.on('new-message', (message) => this.displayMessage(message));
    
    this.socket.on('ai-response', (aiMessage) => {
      this.displayAIMessage(aiMessage);
      this.updateAIPanel(aiMessage);
      document.getElementById('aiProcessingIndicator').classList.add('hidden');
    });

    this.socket.on('ai-processing', (data) => {
      if (data.status === 'analyzing' || data.status === 'translating') {
        document.getElementById('aiProcessingIndicator').classList.remove('hidden');
      } else {
        document.getElementById('aiProcessingIndicator').classList.add('hidden');
      }
    });

    this.socket.on('ai-confirmation', (data) => {
      document.getElementById('aiProcessingIndicator').classList.add('hidden');
      this.showToast('success', data.message);
    });

    this.socket.on('notification', (notification) => {
      this.showToast(notification.type || 'info', notification.message, notification.title);
    });

    this.socket.on('urgent-notification', (notification) => {
      this.showToast('warning', notification.message, notification.title);
    });

    this.socket.on('case-status-changed', (data) => {
      this.showToast('info', `Status: ${data.oldStatus} → ${data.newStatus}`, 'Case Updated');
      this.displayStatusChange(data);
    });

    this.socket.on('online-users', (users) => this.updateOnlineUsers(users));

    this.socket.on('user-typing', (data) => {
      const indicator = document.getElementById('typingIndicator');
      if (data.isTyping && data.userId !== this.socket?.id) {
        document.getElementById('typingUserName').textContent = data.name;
        indicator.classList.remove('hidden');
      } else {
        indicator.classList.add('hidden');
      }
    });

    this.socket.on('error', (data) => this.showToast('error', data.message));
  }

  bindChatEvents() {
    const sendBtn = document.getElementById('sendBtn');
    const messageInput = document.getElementById('messageInput');
    const charCount = document.getElementById('charCount');

    sendBtn.addEventListener('click', () => this.sendMessage());
    
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    messageInput.addEventListener('input', () => {
      charCount.textContent = messageInput.value.length;
    });

    let typingTimeout;
    messageInput.addEventListener('input', () => {
      if (!this.socket) return;
      this.socket.emit('typing', { caseId: this.currentCaseId, isTyping: true });
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        this.socket.emit('typing', { caseId: this.currentCaseId, isTyping: false });
      }, 1000);
    });

    document.getElementById('copyCaseId')?.addEventListener('click', () => {
      navigator.clipboard.writeText(this.currentCaseId).then(() => {
        this.showToast('success', 'Case ID copied!');
      });
    });

    document.getElementById('clearChatBtn')?.addEventListener('click', () => {
      if (confirm('Clear current chat?')) {
        document.getElementById('messagesContainer').innerHTML = '';
      }
    });

    document.getElementById('exportChatBtn')?.addEventListener('click', () => this.exportChat());

    // Technician actions
    document.querySelectorAll('.quick-action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        const input = document.getElementById('messageInput');
        switch(action) {
          case 'question': input.value = 'Question: '; break;
          case 'issue': input.value = '⚠️ Issue: '; break;
          case 'update': input.value = 'Update: '; break;
          case 'complete': this.updateCaseStatus('ready'); break;
        }
        input.focus();
      });
    });

    document.getElementById('caseStatusSelect')?.addEventListener('change', (e) => {
      if (e.target.value) this.updateCaseStatus(e.target.value);
    });
  }

  sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    if (!message || !this.socket || !this.isConnected) return;

    if (this.user.role === 'dentist') {
      this.socket.emit('dentist-instruction', { caseId: this.currentCaseId, message });
    } else {
      this.socket.emit('technician-note', { caseId: this.currentCaseId, message });
    }

    document.getElementById('aiProcessingIndicator').classList.remove('hidden');
    input.value = '';
    document.getElementById('charCount').textContent = '0';
  }

  updateCaseStatus(status) {
    if (!this.socket) return;
    this.socket.emit('case-status-update', { caseId: this.currentCaseId, status });
    this.showToast('info', `Status updated to: ${status}`);
  }

  displayMessage(message) {
    const container = document.getElementById('messagesContainer');
    const div = document.createElement('div');
    
    let messageClass = '';
    if (message.type?.includes('dentist')) messageClass = 'dentist-message';
    else if (message.type?.includes('technician')) messageClass = 'technician-message';
    
    div.className = `message ${messageClass}`;
    div.innerHTML = `
      <div class="message-content">
        <div class="message-sender">${message.sender} · ${message.senderRole || ''}</div>
        <div class="message-text">${this.escapeHtml(message.content)}</div>
        <div class="message-time">${this.formatTime(message.timestamp)}</div>
      </div>
    `;
    container.appendChild(div);
    this.scrollToBottom();
  }

  displayAIMessage(aiMessage) {
    const container = document.getElementById('messagesContainer');
    const div = document.createElement('div');
    
    const isForDentist = aiMessage.direction === 'tech-to-dentist';
    const isUrgent = aiMessage.urgency === 'urgent' || aiMessage.urgency === 'critical';
    
    div.className = `message ai-message ${isUrgent ? 'urgent' : ''}`;
    div.innerHTML = `
      <div class="message-content">
        <div class="ai-header">
          <i class="fas fa-robot"></i> ${aiMessage.sender}
          ${isForDentist ? '<span class="badge badge-blue">For Dentist</span>' : ''}
          ${isUrgent ? '<span class="badge badge-red">Urgent</span>' : ''}
        </div>
        <div class="ai-content">${this.formatAIResponse(aiMessage.content)}</div>
        ${aiMessage.quickSummary ? `<div class="quick-summary">📌 ${aiMessage.quickSummary}</div>` : ''}
        <div class="message-time">${this.formatTime(aiMessage.timestamp)}</div>
      </div>
    `;
    container.appendChild(div);

    if (aiMessage.suggestedResponses && this.user?.role === 'dentist') {
      this.showSuggestions(aiMessage.suggestedResponses);
    }

    this.scrollToBottom();
  }

  showSuggestions(suggestionsText) {
    const container = document.getElementById('messagesContainer');
    const suggestions = suggestionsText
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => line.replace(/^\d+\.\s*|•\s*|-\s*/, '').trim())
      .filter(s => s.length > 5);

    if (suggestions.length === 0) return;

    const div = document.createElement('div');
    div.className = 'suggested-responses';
    div.innerHTML = `
      <div class="suggestions-header"><i class="fas fa-lightbulb"></i> Quick Replies</div>
      <div class="suggestions-list">
        ${suggestions.map(s => `
          <button class="suggestion-btn" onclick="app.useSuggestion('${this.escapeHtml(s)}')">${s}</button>
        `).join('')}
      </div>
    `;
    container.appendChild(div);
    this.scrollToBottom();
  }

  useSuggestion(text) {
    document.getElementById('messageInput').value = text;
    document.getElementById('messageInput').focus();
    document.querySelectorAll('.suggested-responses').forEach(el => el.remove());
  }

  displayStatusChange(data) {
    const container = document.getElementById('messagesContainer');
    const div = document.createElement('div');
    div.className = 'message system-message';
    div.innerHTML = `
      <div class="message-content status-change">
        <div class="status-icon"><i class="fas fa-sync-alt"></i></div>
        <div class="status-text">
          <strong>Status Updated</strong>
          <p>${data.oldStatus} → ${data.newStatus}</p>
          <small>by ${data.updatedBy}</small>
        </div>
      </div>
    `;
    container.appendChild(div);
    this.scrollToBottom();
  }

  updateAIPanel(aiMessage) {
    const panel = document.getElementById('aiPanelContent');
    if (!panel) return;
    panel.innerHTML = `
      <div class="ai-analysis-card">
        <div class="card-header"><i class="fas fa-brain"></i> AI Technical Analysis</div>
        <div class="ai-analysis-content">${this.formatAIResponse(aiMessage.content)}</div>
        <div style="margin-top: 12px; font-size: 0.8em; color: var(--gray-500);">
          <i class="fas fa-clock"></i> ${this.formatTime(aiMessage.timestamp)}
        </div>
      </div>
    `;
  }

  updateOnlineUsers(users) {
    const container = document.getElementById('onlineUsersList');
    if (!users || users.length === 0) {
      container.innerHTML = '<div class="user-item"><div class="user-dot"></div><span>No users online</span></div>';
      return;
    }
    container.innerHTML = users.map(u => `
      <div class="user-item">
        <div class="user-dot online"></div>
        <span><strong>${u.name}</strong> <small>(${u.role})</small></span>
      </div>
    `).join('');
  }

  exportChat() {
    const messages = document.getElementById('messagesContainer').innerText;
    const blob = new Blob([messages], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dental-case-${this.currentCaseId}.txt`;
    a.click();
  }

  showToast(type, message, title = '') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
    toast.innerHTML = `
      <i class="fas ${icons[type] || icons.info} toast-icon"></i>
      <div class="toast-content">
        ${title ? `<div class="toast-title">${title}</div>` : ''}
        <div class="toast-message">${message}</div>
      </div>
      <button class="toast-close" onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>
    `;
    container.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 5000);
  }

  formatAIResponse(text) {
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>')
      .replace(/•/g, '<span style="color: #0d9488;">•</span>');
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  scrollToBottom() {
    const container = document.getElementById('messagesContainer');
    setTimeout(() => { container.scrollTop = container.scrollHeight; }, 100);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new DentalAIBridge();
});
