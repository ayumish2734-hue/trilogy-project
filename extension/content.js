// content.js

class VoiceTranslator {
  constructor() {
    this.isActive = false;
    this.audioContext = null;
    this.mediaStream = null;
    this.eventSource = null;
    this.floatingBox = null;
    this.PROXY_SERVER_URL = "http://localhost:3000";
    this.connectionId = null;
    this.GROQ_API_KEY = "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";
    this.FRAMES_PER_BUFFER = 1024;
    this.SAMPLE_RATE = 16000;
    this.CHANNELS = 1;
    this.recordedFrames = [];
    this.recordingLock = false;
    this.currentSpeaker = null;
    this.speakerColors = ['A', 'B', 'C'];
    this.detectedLanguage = null;
    this.settings = {
      sourceLanguage: 'en-US',
      targetLanguage: 'es',
      showFloatingBox: true,
      autoTranslate: true,
      speakerDiarization: true, // New setting for speaker detection
      groqApiKey: this.GROQ_API_KEY
    };
    this.currentTranscript = '';
    this.translations = [];
    this.conversationLines = [];
    this.isUserSpeaking = false;
    this.silenceTimer = null;
    this.speakerMap = new Map(); // Track speaker identities
    this.init();
  }

  async init() {
    console.log('Initializing Voice Translator...');
    await this.loadSettings();
    this.setupMessageListener();
    console.log('Voice Translator initialized successfully');
  }

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      switch (message.action) {
        case 'toggleTranslator':
          if (this.isActive) {
            this.stop();
            sendResponse({ success: true, action: 'stopped' });
          } else {
            this.start().then(success => {
              sendResponse({ success, action: success ? 'started' : 'failed' });
            });
            return true;
          }
          break;
        case 'startTranslation':
          this.settings = { ...this.settings, ...message.settings };
          this.start().then(success => {
            sendResponse({ success });
          }).catch(error => {
            sendResponse({ success: false, error: error.message });
          });
          return true;
        case 'stopTranslation':
          this.stop();
          sendResponse({ success: true });
          break;
        case 'updateSettings':
          this.settings = { ...this.settings, ...message.settings };
          this.updateBoxSettings();
          break;
        case 'getStatus':
          sendResponse({ isActive: this.isActive });
          break;
        case 'ping':
          sendResponse({ status: 'alive' });
          break;
      }
    });
  }

  async loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['sourceLanguage', 'targetLanguage', 'showFloatingBox', 'autoTranslate', 'speakerDiarization'], (result) => {
        this.settings = { ...this.settings, ...result };
        this.settings.groqApiKey = this.GROQ_API_KEY;
        resolve();
      });
    });
  }

  async start() {
    try {
      this.settings.groqApiKey = this.GROQ_API_KEY;
      try {
        this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
          audio: { sampleRate: 16000, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          video: false
        });
      } catch (error) {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
      }

      // Always create the floating box for now
      console.log('Creating floating box...');
      this.createFloatingBox();
      console.log('Floating box created');

      this.setupAudioProcessing();
      await this.connectToAssemblyAI();
      this.isActive = true;
      this.updateBoxStatus('Listening...');
      return true;
    } catch (error) {
      this.cleanup();
      this.showError(`Failed to start: ${error.message}`);
      return false;
    }
  }

  cleanup() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.connectionId) {
      fetch(`${this.PROXY_SERVER_URL}/close-connection/${this.connectionId}`, { method: 'DELETE' })
        .catch(error => console.error('Error closing connection:', error));
      this.connectionId = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  async stop() {
    this.isActive = false;
    this.cleanup();
    this.updateBoxStatus('Stopped');
  }

  createFloatingBox() {
    if (this.floatingBox) {
      this.floatingBox.remove();
    }

    this.floatingBox = document.createElement('div');
    this.floatingBox.id = 'voice-translator-box';
    this.floatingBox.innerHTML = `
      <div class="vt-box-header" id="vt-header">
        <div class="vt-title">🌐 Live Translation</div>
        <div class="vt-controls">
          <button class="vt-btn vt-opacity-btn" id="vt-opacity" title="Toggle Transparency">◐</button>
          <button class="vt-btn vt-close-btn" id="vt-close">×</button>
        </div>
      </div>
      <div class="vt-box-content">
        <div class="vt-status" id="vt-status">Ready to translate</div>
        <div class="vt-conversation" id="vt-conversation">
          <div class="vt-conv-line">Listening for speech...</div>
        </div>
      </div>
      <div class="vt-resize-handle" id="vt-resize"></div>
    `;

    this.addBoxStyles();
    document.body.appendChild(this.floatingBox);
    console.log('Floating box created and appended to body');
    this.setupBoxEvents();
    this.makeDraggable();
    this.makeResizable();
  }

  addBoxStyles() {
    // Remove existing styles if they exist
    const existingStyles = document.getElementById('vt-box-styles');
    if (existingStyles) {
      existingStyles.remove();
    }

    const style = document.createElement('style');
    style.id = 'vt-box-styles';
    style.textContent = `
      #voice-translator-box {
        position: fixed !important;
        top: 100px !important;
        right: 20px !important;
        width: 400px !important;
        height: 300px !important;
        background: rgba(0, 0, 0, 0.85) !important;
        backdrop-filter: blur(20px);
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transition: background 0.3s ease, backdrop-filter 0.3s ease;
        min-width: 300px;
        min-height: 200px;
        resize: both;
      }

      #voice-translator-box.transparent {
        background: rgba(0, 0, 0, 0.3);
        backdrop-filter: blur(5px);
      }

      /* Explicitly set opacity for text content */
      .vt-conv-line, 
      .vt-status, 
      .vt-title,
      .vt-controls,
      .vt-btn {
        opacity: 1 !important;
      }

      .vt-conv-line.translation {
        color: rgb(16, 185, 129) !important;
        opacity: 1 !important;
      }

      .vt-conv-line.current {
        color: white !important;
        opacity: 1 !important;
      }

      /* Ensure background elements maintain opacity */
      .vt-box-header {
        background: rgba(16, 16, 16, 0.9);
        transition: background 0.3s ease;
      }

      #voice-translator-box.transparent .vt-box-header {
        background: rgba(16, 16, 16, 0.7);
      }

      /* Keep content opaque even when box is transparent */
      #voice-translator-box.transparent .vt-box-content,
      #voice-translator-box.transparent .vt-box-header,
      #voice-translator-box.transparent .vt-conv-line {
        opacity: 1 !important;
      }

      #voice-translator-box:hover {
        background: rgba(0, 0, 0, 0.85);
        backdrop-filter: blur(20px);
      }

      .vt-box-header {
        background: linear-gradient(135deg, rgba(16, 16, 16, 0.9), rgba(32, 32, 32, 0.9));
        color: white;
        padding: 12px 16px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: move;
        user-select: none;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }

      .vt-title {
        font-weight: 600;
        font-size: 14px;
      }

      .vt-controls {
        display: flex;
        gap: 8px;
      }

      .vt-btn {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        width: 24px;
        height: 24px;
        border-radius: 4px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        transition: all 0.2s ease;
      }

      .vt-btn:hover {
        background: rgba(255, 255, 255, 0.2);
      }

      .vt-box-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .vt-status {
        padding: 8px 16px;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.6);
        text-align: center;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }

      .vt-conversation {
        flex: 1;
        padding: 16px;
        overflow-y: auto;
        font-size: 13px;
        line-height: 1.5;
      }

      .vt-conv-line {
        margin-bottom: 8px;
        word-wrap: break-word;
        color: white;
        transition: color 0.3s ease;
        padding: 4px 0;
        position: relative;
      }

      .vt-conv-line.translation {
        color: rgb(16, 185, 129) !important;
        margin-left: 16px;
        font-weight: 500;
      }

      .vt-speaker-badge {
        display: inline-block;
        padding: 4px 8px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        margin-right: 12px;
        background: rgba(59, 130, 246, 0.3);
        color: rgb(59, 130, 246);
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        text-shadow: 0 1px 2px rgba(0,0,0,0.1);
      }

      .vt-speaker-A {
        background: rgba(59, 130, 246, 0.3);
        color: rgb(59, 130, 246);
        border: 1px solid rgba(59, 130, 246, 0.5);
      }

      .vt-speaker-B {
        background: rgba(236, 72, 153, 0.3);
        color: rgb(236, 72, 153);
        border: 1px solid rgba(236, 72, 153, 0.5);
      }

      .vt-speaker-C {
        background: rgba(16, 185, 129, 0.3);
        color: rgb(16, 185, 129);
        border: 1px solid rgba(16, 185, 129, 0.5);
      }

      .vt-text-content {
        display: inline-block;
        vertical-align: middle;
      }

      .vt-conv-line.current {
        color: white !important;
        font-weight: 600;
      }

      .vt-conv-line.recent {
        opacity: 0.7;
        color: rgba(255, 255, 255, 0.8);
      }

      .vt-conv-line.silence {
        color: rgba(255, 255, 255, 0.4);
        font-style: italic;
      }

      .vt-speaker-label {
        color: #fbbf24;
        font-weight: 600;
        font-size: 11px;
        margin-right: 8px;
      }

      .vt-resize-handle {
        position: absolute;
        bottom: 0;
        right: 0;
        width: 20px;
        height: 20px;
        cursor: nw-resize;
        background: linear-gradient(-45deg, transparent 30%, rgba(255,255,255,0.1) 30%, rgba(255,255,255,0.1) 70%, transparent 70%);
      }

      ::-webkit-scrollbar {
        width: 6px;
      }

      ::-webkit-scrollbar-track {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
      }

      ::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.3);
        border-radius: 3px;
      }

      ::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.5);
      }
    `;

    document.head.appendChild(style);
  }

  setupBoxEvents() {
    const opacityBtn = document.getElementById('vt-opacity');
    const closeBtn = document.getElementById('vt-close');

    opacityBtn?.addEventListener('click', () => {
      this.floatingBox.classList.toggle('transparent');
    });

    closeBtn?.addEventListener('click', () => {
      this.stop();
      this.floatingBox.remove();
    });
  }

  makeDraggable() {
    const header = document.getElementById('vt-header');
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(window.getComputedStyle(this.floatingBox).left, 10);
      startTop = parseInt(window.getComputedStyle(this.floatingBox).top, 10);
      document.addEventListener('mousemove', drag);
      document.addEventListener('mouseup', stopDrag);
    });

    const drag = (e) => {
      if (!isDragging) return;
      const newLeft = startLeft + e.clientX - startX;
      const newTop = startTop + e.clientY - startY;
      this.floatingBox.style.left = `${Math.max(0, Math.min(window.innerWidth - this.floatingBox.offsetWidth, newLeft))}px`;
      this.floatingBox.style.top = `${Math.max(0, Math.min(window.innerHeight - this.floatingBox.offsetHeight, newTop))}px`;
    };

    const stopDrag = () => {
      isDragging = false;
      document.removeEventListener('mousemove', drag);
      document.removeEventListener('mouseup', stopDrag);
    };
  }

  makeResizable() {
    const resizeHandle = document.getElementById('vt-resize');
    let isResizing = false;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      const startX = e.clientX;
      const startY = e.clientY;
      const startWidth = parseInt(document.defaultView.getComputedStyle(this.floatingBox).width, 10);
      const startHeight = parseInt(document.defaultView.getComputedStyle(this.floatingBox).height, 10);

      const doResize = (e) => {
        if (!isResizing) return;
        const newWidth = Math.max(300, startWidth + e.clientX - startX);
        const newHeight = Math.max(200, startHeight + e.clientY - startY);
        this.floatingBox.style.width = newWidth + 'px';
        this.floatingBox.style.height = newHeight + 'px';
      };

      const stopResize = () => {
        isResizing = false;
        document.removeEventListener('mousemove', doResize);
        document.removeEventListener('mouseup', stopResize);
      };

      document.addEventListener('mousemove', doResize);
      document.addEventListener('mouseup', stopResize);
    });
  }

  async setupAudioProcessing() {
    try {
      this.audioContext = new AudioContext({ sampleRate: this.SAMPLE_RATE });
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      await this.audioContext.audioWorklet.addModule(chrome.runtime.getURL('processor.js'));
      this.processor = new AudioWorkletNode(this.audioContext, 'vt-processor');

      this.processor.port.onmessage = (event) => {
        if (event.data.type === 'audioData' && this.connectionId) {
          const inputData = event.data.data;

          // Calculate audio level for better silence detection
          let sum = 0;
          for (let i = 0; i < inputData.length; i++) {
            sum += inputData[i] * inputData[i];
          }
          const rms = Math.sqrt(sum / inputData.length);
          const audioLevel = Math.max(0, Math.min(1, rms * 10)); // Normalize to 0-1

          // Only process if audio level is above threshold
          if (audioLevel > 0.01) { // Adjust threshold as needed
            const int16Data = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
              int16Data[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
            }
            this.recordAudioFrame(int16Data.buffer);
            this.sendAudioData(int16Data.buffer);
            this.handleAudioActivity();
          }
        }
      };
      
      source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);
    } catch (error) {
      if (this.audioContext && this.audioContext.state !== 'closed') {
        this.audioContext.close();
        this.audioContext = null;
      }
      throw error;
    }
  }

  handleAudioActivity() {
    this.isUserSpeaking = true;
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }
    this.silenceTimer = setTimeout(() => {
      this.isUserSpeaking = false;
      this.addConversationLine('--- Silence ---', 'silence');
    }, 1500);
  }

  async connectToAssemblyAI() {
    try {
      console.log('Connecting to AssemblyAI with speaker diarization...');
      const response = await fetch(`${this.PROXY_SERVER_URL}/create-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          punctuate: true,        
          format_text: true,      
          disfluencies: false,    
          speaker_labels: true,   // Always enable speaker detection
          speakers_expected: 5    // Expect up to 5 speakers for better detection
        })
      });

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || 'Failed to create connection');
      }

      this.connectionId = result.connectionId;
      await new Promise(resolve => setTimeout(resolve, 1000));
      this.startMessagePolling();
      return true;
    } catch (error) {
      throw error;
    }
  }

  startMessagePolling() {
    if (!this.connectionId) return;

    this.eventSource = new EventSource(`${this.PROXY_SERVER_URL}/events/${this.connectionId}`);

    this.eventSource.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        const msgType = data.type;

        if (msgType === "Begin") {
          this.updateBoxStatus('Session started');
        } else if (msgType === "Turn") {
          const transcript = data.transcript || '';
          const formatted = data.turn_is_formatted || false;
          const speaker = data.speaker || null; // Get speaker label

          if (formatted && transcript.trim()) {
            // Detect language if not already detected
            if (!this.detectedLanguage) {
              this.detectedLanguage = await this.detectLanguage(transcript);
              this.settings.sourceLanguage = this.detectedLanguage;
              const langName = this.getLanguageName(this.detectedLanguage);
              this.updateBoxStatus(`Listening... (Detected: ${langName})`);

              // Notify popup of detected language
              chrome.runtime.sendMessage({
                action: 'languageDetected',
                language: langName
              }).catch(() => { });
            }

            // Add transcript with speaker label
            this.addConversationLine(transcript, 'original', speaker);
            
            if (this.settings.autoTranslate) {
              await this.translateText(transcript, speaker);
            }
          }
        } else if (msgType === "Termination") {
          this.updateBoxStatus('Session terminated');
          this.saveAudioRecording();
        }
      } catch (error) {
        console.error('Error processing SSE message:', error);
      }
    };
  }

  async sendAudioData(audioBuffer) {
    if (!this.connectionId) return;

    try {
      const base64Audio = btoa(String.fromCharCode(...new Uint8Array(audioBuffer)));
      await fetch(`${this.PROXY_SERVER_URL}/send-audio/${this.connectionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioData: base64Audio })
      });
    } catch (error) {
      console.error('Error sending audio data:', error);
    }
  }

  async detectLanguage(text) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.settings.groqApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [
            {
              role: 'system',
              content: "Detect the language of the following text. Respond with only the ISO code (like en-US, es-ES, fr-FR, de-DE, hi-IN). If unsure, respond with en-US."
            },
            { role: 'user', content: text }
          ],
          max_tokens: 5,
          temperature: 0.0
        })
      });
      const result = await response.json();
      const detectedCode = result.choices[0].message.content.trim();
      return detectedCode;
    } catch (err) {
      console.error("Language detection error:", err);
      return "en-US"; // fallback to English
    }
  }

  async translateText(text, speaker = null) {
    if (!text.trim() || !this.settings.groqApiKey) return;

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.settings.groqApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [
            {
              role: 'system',
              content: `You are a direct translator. Translate the following text from ${this.getLanguageName(this.settings.sourceLanguage)} to ${this.getLanguageName(this.settings.targetLanguage)}. Return ONLY the direct translation of the exact words spoken, nothing else. Do not answer questions, do not add explanations, do not provide context - just translate the literal meaning of the text. IF SOMEONE ASKS QUESTION, DONT ANSWER THE QUESTION JUST TRANSLATE THE QUESTION`
            },
            { role: 'user', content: text }
          ],
          max_tokens: 500,
          temperature: 0.1
        })
      });

      if (response.ok) {
        const result = await response.json();
        const translation = result.choices[0].message.content.trim();
        this.addConversationLine(translation, 'translation', speaker);
        
        // Store in persistent transcript history
        chrome.storage.local.get(['fullTranscript'], (res) => {
          const history = res.fullTranscript || [];
          const speakerPrefix = speaker ? `[${this.getSpeakerName(speaker)}] ` : '';
          history.push({ 
            text: speakerPrefix + translation, 
            type: 'translation', 
            time: Date.now(),
            speaker: speaker
          });
          chrome.storage.local.set({ fullTranscript: history });
        });
      }
    } catch (error) {
      console.error('Translation error:', error);
    }
  }

  getSpeakerName(speaker) {
    // Convert speaker label to a more user-friendly format
    if (typeof speaker === 'string' && speaker.startsWith('Speaker')) {
      return speaker;
    }
    return `Speaker ${speaker || 'Unknown'}`;
  }

  addConversationLine(text, type, speaker = null) {
    // Track speakers and assign consistent colors
    if (speaker && !this.speakerMap.has(speaker)) {
      const speakerColor = this.speakerColors[this.speakerMap.size % this.speakerColors.length];
      this.speakerMap.set(speaker, speakerColor);
    }
    
    const displayText = text;
    
    this.conversationLines.push({ 
      text: displayText, 
      type,
      timestamp: Date.now(),
      speaker: speaker,
      speakerColor: speaker ? this.speakerMap.get(speaker) : null
    });

    if (this.conversationLines.length > 50) {
      this.conversationLines = this.conversationLines.slice(-50);
    }

    this.updateConversationDisplay();
    this.syncWithPopup();
  }

  syncWithPopup() {
    chrome.runtime.sendMessage({
      action: 'conversationUpdate',
      history: this.conversationLines.slice(-20)
    }).catch(() => { });
  }

  updateConversationDisplay() {
    const conversationEl = document.getElementById('vt-conversation');
    if (!conversationEl) return;

    conversationEl.innerHTML = '';

    const lines = this.conversationLines.slice(-10);

    lines.forEach((line, index) => {
      const lineEl = document.createElement('div');
      lineEl.className = 'vt-conv-line';
      
      if (line.speaker) {
        // Create speaker badge
        const speakerBadge = document.createElement('span');
        speakerBadge.className = `vt-speaker-badge vt-speaker-${line.speakerColor || 'A'}`;
        speakerBadge.textContent = `Speaker ${line.speaker}`;
        lineEl.appendChild(speakerBadge);
        
        // Create text content
        const textSpan = document.createElement('span');
        textSpan.className = 'vt-text-content';
        textSpan.textContent = line.text;
        lineEl.appendChild(textSpan);
      } else {
        lineEl.textContent = line.text;
      }

      if (index === lines.length - 1) {
        lineEl.classList.add('current');
      } else if (index >= lines.length - 3) {
        lineEl.classList.add('recent');
      }

      if (line.type === 'silence') {
        lineEl.classList.add('silence');
      }
      if (line.type === 'translation') {
        lineEl.classList.add('translation');
      }

      conversationEl.appendChild(lineEl);
    });

    conversationEl.scrollTop = conversationEl.scrollHeight;
  }

  updateBoxStatus(status) {
    const element = document.getElementById('vt-status');
    if (element) {
      element.textContent = status;
    }
  }

  updateBoxSettings() {
    // Update box if needed based on new settings
  }

  getLanguageName(code) {
    const languages = {
      'en': 'English', 'en-US': 'English', 'es': 'Spanish', 'es-ES': 'Spanish',
      'fr': 'French', 'fr-FR': 'French', 'de': 'German', 'de-DE': 'German',
      'it': 'Italian', 'it-IT': 'Italian', 'pt': 'Portuguese', 'pt-PT': 'Portuguese',
      'ru': 'Russian', 'ru-RU': 'Russian', 'ja': 'Japanese', 'ja-JP': 'Japanese',
      'ko': 'Korean', 'ko-KR': 'Korean', 'zh': 'Chinese', 'zh-CN': 'Chinese',
      'hi': 'Hindi', 'hi-IN': 'Hindi', 'ar': 'Arabic', 'ar-SA': 'Arabic'
    };
    return languages[code] || 'Unknown';
  }

  recordAudioFrame(audioData) {
    if (!this.recordingLock) {
      this.recordingLock = true;
      this.recordedFrames.push(new Uint8Array(audioData));
      this.recordingLock = false;
    }
  }

  saveAudioRecording() {
    if (this.recordedFrames.length === 0) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `recorded_audio_${timestamp}.wav`;
    try {
      const audioBuffer = this.createWavFile();
      const blob = new Blob([audioBuffer], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.recordedFrames = [];
    } catch (error) {
      console.error('Error saving WAV file:', error);
    }
  }

  createWavFile() {
    const numFrames = this.recordedFrames.length * this.FRAMES_PER_BUFFER;
    const dataSize = numFrames * 2;
    const fileSize = 44 + dataSize - 8;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, fileSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, this.CHANNELS, true);
    view.setUint32(24, this.SAMPLE_RATE, true);
    view.setUint32(28, this.SAMPLE_RATE * this.CHANNELS * 2, true);
    view.setUint16(32, this.CHANNELS * 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (const frame of this.recordedFrames) {
      const int16Array = new Int16Array(frame.buffer);
      for (let i = 0; i < int16Array.length; i++) {
        view.setInt16(offset, int16Array[i], true);
        offset += 2;
      }
    }
    return buffer;
  }

  showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
      position: fixed; top: 20px; right: 20px; background: rgba(220, 38, 38, 0.9);
      color: white; padding: 16px; border-radius: 8px; z-index: 1000000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px; max-width: 300px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    `;
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);
    setTimeout(() => errorDiv.remove(), 5000);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new VoiceTranslator());
} else {
  new VoiceTranslator();
}