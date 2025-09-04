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
    
    // Enhanced audio detection parameters
    this.silenceThreshold = 0.005;  // More sensitive threshold
    this.activeThreshold = 0.003;   // Lower threshold for continuing speech
    this.lastAudioLevels = new Array(10).fill(0);  // Store recent audio levels
    this.audioLevelIndex = 0;
    this.minSilenceDuration = 1000; // Minimum silence duration in ms
    this.lastAudioTime = Date.now();
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
        // Specifically for Google Meet, we need to capture the tab with video
        this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
          audio: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
            sampleRate: 16000,
            channelCount: 1
          },
          video: {
            displaySurface: "browser",
            width: { max: 1 },
            height: { max: 1 },
            frameRate: { max: 1 }
          }
        });
        
        // Remove video tracks as we only need audio
        this.mediaStream.getVideoTracks().forEach(track => {
          track.stop();
          this.mediaStream.removeTrack(track);
        });
        
        // Also get microphone audio
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });

        // Create audio context for mixing streams
        const audioContext = new AudioContext({
          sampleRate: 16000
        });

        // Create sources for both streams
        const systemSource = audioContext.createMediaStreamSource(this.mediaStream);
        const micSource = audioContext.createMediaStreamSource(micStream);

        // Create a merger node to combine the streams
        const merger = audioContext.createChannelMerger(2);
        systemSource.connect(merger, 0, 0);
        micSource.connect(merger, 0, 1);

        // Create a destination node
        const dest = audioContext.createMediaStreamDestination();
        merger.connect(dest);

        // Use the combined stream
        this.mediaStream = dest.stream;

      } catch (error) {
        console.error('Failed to get system audio:', error);
        // Fallback to just microphone if screen sharing fails
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
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

  // Updated audio setup method - replace your existing setupAudioProcessing method

async setupAudioProcessing() {
  try {
    console.log('Setting up enhanced audio capture...');
    
    // Method 1: Try to capture tab audio (most reliable for Meet)
    let systemStream = null;
    try {
      systemStream = await navigator.mediaDevices.getDisplayMedia({
        audio: {
          autoGainControl: false,  // Important: disable AGC
          echoCancellation: false, // Important: disable echo cancellation
          noiseSuppression: false, // Important: disable noise suppression
          sampleRate: 48000,       // Higher sample rate for better quality
          channelCount: 2,         // Stereo capture
          suppressLocalAudioPlayback: false // Don't suppress local audio
        },
        video: {
          width: { max: 1 },
          height: { max: 1 },
          frameRate: { max: 1 }
        }
      });
      
      console.log('Successfully captured system audio');
      
      // Remove video tracks immediately
      systemStream.getVideoTracks().forEach(track => {
        track.stop();
        systemStream.removeTrack(track);
      });
      
    } catch (error) {
      console.warn('Failed to capture system audio:', error);
      this.showError('Please select "Share tab" and enable "Share audio" for full conversation capture');
    }

    // Method 2: Get microphone audio
    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: 48000,
          channelCount: 1
        }
      });
      console.log('Successfully captured microphone audio');
    } catch (error) {
      console.warn('Failed to capture microphone:', error);
    }

    // Create audio context with higher sample rate
    this.audioContext = new AudioContext({ 
      sampleRate: 48000,
      latencyHint: 'interactive'
    });

    // Method 3: Enhanced audio processing
    if (systemStream && micStream) {
      // Both streams available - mix them
      console.log('Mixing system and microphone audio...');
      this.mediaStream = await this.mixAudioStreams(systemStream, micStream);
    } else if (systemStream) {
      // Only system audio (Meet participants)
      console.log('Using system audio only');
      this.mediaStream = systemStream;
    } else if (micStream) {
      // Only microphone (fallback)
      console.log('Using microphone only - you may miss other participants');
      this.mediaStream = micStream;
      this.showError('Only capturing your voice. Enable screen sharing with audio to capture all participants.');
    } else {
      throw new Error('No audio streams available');
    }

    // Set up audio processing
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    
    // Create a more sensitive audio processor
    await this.audioContext.audioWorklet.addModule(chrome.runtime.getURL('processor.js'));
    this.processor = new AudioWorkletNode(this.audioContext, 'enhanced-vt-processor', {
      processorOptions: {
        sampleRate: 48000,
        frameSize: 4800, // 100ms frames for better voice detection
        sensitivity: 0.001 // Very sensitive threshold
      }
    });

    this.processor.port.onmessage = (event) => {
      if (event.data.type === 'audioData' && this.connectionId) {
        const inputData = event.data.data;
        const audioLevel = event.data.level;
        
        // More sensitive voice activity detection
        if (audioLevel > 0.001) { // Very low threshold
          // Convert to 16kHz for AssemblyAI
          const downsampledData = this.downsampleTo16kHz(inputData);
          const int16Data = new Int16Array(downsampledData.length);
          
          for (let i = 0; i < downsampledData.length; i++) {
            int16Data[i] = Math.max(-32768, Math.min(32767, downsampledData[i] * 32768));
          }
          
          this.recordAudioFrame(int16Data.buffer);
          this.sendAudioData(int16Data.buffer);
          this.handleAudioActivity();
        }
      }
    };

    source.connect(this.processor);
    // Don't connect to destination to avoid feedback
    
    console.log('Audio processing setup complete');
    
  } catch (error) {
    console.error('Audio setup failed:', error);
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }
    throw error;
  }
}

// New method to mix audio streams with proper validation
async mixAudioStreams(systemStream, micStream) {
  // Validate both streams have audio tracks
  const systemAudioTracks = systemStream.getAudioTracks();
  const micAudioTracks = micStream.getAudioTracks();
  
  if (systemAudioTracks.length === 0) {
    console.warn('System stream has no audio tracks, using mic only');
    return micStream;
  }
  
  if (micAudioTracks.length === 0) {
    console.warn('Mic stream has no audio tracks, using system only');
    return systemStream;
  }
  
  try {
    const mixerContext = new AudioContext({ sampleRate: 48000 });
    
    // Create sources with error handling
    let systemSource, micSource;
    
    try {
      systemSource = mixerContext.createMediaStreamSource(systemStream);
      console.log('Created system audio source');
    } catch (error) {
      console.error('Failed to create system audio source:', error);
      throw new Error('System audio source creation failed');
    }
    
    try {
      micSource = mixerContext.createMediaStreamSource(micStream);
      console.log('Created microphone audio source');
    } catch (error) {
      console.error('Failed to create microphone audio source:', error);
      // If mic source fails, just return system stream
      return systemStream;
    }
    
    // Create gain nodes for volume control
    const systemGain = mixerContext.createGain();
    const micGain = mixerContext.createGain();
    
    // Adjust levels - system audio often needs boosting
    systemGain.gain.value = 2.0;  // Boost system audio
    micGain.gain.value = 1.0;     // Normal mic level
    
    // Create a simple mixer node instead of channel merger
    const mixerGain = mixerContext.createGain();
    mixerGain.gain.value = 0.7; // Reduce overall level to prevent clipping
    
    // Connect everything
    systemSource.connect(systemGain);
    micSource.connect(micGain);
    
    // Mix both sources to the same output
    systemGain.connect(mixerGain);
    micGain.connect(mixerGain);
    
    // Create output destination
    const dest = mixerContext.createMediaStreamDestination();
    mixerGain.connect(dest);
    
    // Verify the destination stream has audio tracks
    const outputTracks = dest.stream.getAudioTracks();
    if (outputTracks.length === 0) {
      throw new Error('Mixed stream has no audio tracks');
    }
    
    console.log('Successfully mixed audio streams, output has', outputTracks.length, 'tracks');
    return dest.stream;
    
  } catch (error) {
    console.error('Audio mixing failed:', error);
    // Fallback to system stream if mixing fails
    return systemStream;
  }
}

// Helper method to calculate audio level if not provided
calculateAudioLevel(audioData) {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < audioData.length; i++) {
    const abs = Math.abs(audioData[i]);
    sum += abs * abs;
    peak = Math.max(peak, abs);
  }
  const rms = Math.sqrt(sum / audioData.length);
  return Math.max(rms * 20, peak * 15);
}

// New method to downsample from 48kHz to 16kHz
downsampleTo16kHz(inputData) {
  const inputSampleRate = 48000;
  const outputSampleRate = 16000;
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.floor(inputData.length / ratio);
  const output = new Float32Array(outputLength);
  
  for (let i = 0; i < outputLength; i++) {
    const inputIndex = Math.floor(i * ratio);
    output[i] = inputData[inputIndex];
  }
  
  return output;
}

// Updated connection method with better audio settings
async connectToAssemblyAI() {
  try {
    console.log('Connecting to AssemblyAI with enhanced settings...');
    const response = await fetch(`${this.PROXY_SERVER_URL}/create-connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Enhanced settings for better voice detection
        sample_rate: 16000,
        punctuate: true,
        format_text: true,
        disfluencies: false,
        speaker_labels: true,
        speakers_expected: 10,
        dual_channel: true,
        multichannel: true,        // Process multiple channels
        audio_features: true,
        speech_threshold: 0.05,    // Very sensitive speech detection
        vad_sensitivity: 5,        // Maximum sensitivity
        endpointing_sensitivity: "lowest", // Most lenient silence detection
        silence_threshold: 100,    // Very short silence threshold (100ms)
        utterance_end_ms: 500,     // Short utterance end detection
        boost_param: "high",       // Boost audio processing
        redact_pii: false,
        filter_profanity: false
      })
    });

    const result = await response.json();
    if (!result.success) {
      throw new Error(result.error || 'Failed to create connection');
    }

    this.connectionId = result.connectionId;
    console.log('AssemblyAI connection established:', this.connectionId);
    
    // Wait a bit longer for connection to stabilize
    await new Promise(resolve => setTimeout(resolve, 2000));
    this.startMessagePolling();
    return true;
  } catch (error) {
    console.error('AssemblyAI connection failed:', error);
    throw error;
  }
}

// Enhanced instructions for better user guidance
showMeetInstructions() {
  const instructionsDiv = document.createElement('div');
  instructionsDiv.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0, 0, 0, 0.95);
    color: white;
    padding: 32px;
    border-radius: 16px;
    z-index: 1000001;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    max-width: 500px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    text-align: left;
    border: 1px solid rgba(255, 255, 255, 0.1);
  `;
  
  instructionsDiv.innerHTML = `
    <div style="text-align: center; margin-bottom: 24px;">
      <div style="font-size: 24px; margin-bottom: 8px;">🎤</div>
      <h3 style="margin: 0; color: #60A5FA; font-size: 18px;">Capture All Meeting Audio</h3>
    </div>
    
    <div style="background: rgba(59, 130, 246, 0.1); padding: 16px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #60A5FA;">
      <strong style="color: #60A5FA;">Important:</strong> To capture other participants' voices, you must share your browser tab with audio.
    </div>
    
    <ol style="margin: 0; padding-left: 24px; line-height: 1.6;">
      <li style="margin-bottom: 12px;"><strong style="color: #60A5FA;">Click "Share tab"</strong> when the browser asks for permissions</li>
      <li style="margin-bottom: 12px;"><strong style="color: #60A5FA;">Select this Google Meet tab</strong> from the list</li>
      <li style="margin-bottom: 12px;"><strong style="color: #60A5FA;">✅ Check "Share audio"</strong> - This is crucial!</li>
      <li style="margin-bottom: 12px;"><strong style="color: #60A5FA;">Click "Share"</strong></li>
      <li style="margin-bottom: 12px;"><strong style="color: #60A5FA;">Also allow microphone access</strong> when prompted</li>
    </ol>
    
    <div style="background: rgba(34, 197, 94, 0.1); padding: 12px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #22C55E;">
      <div style="color: #22C55E; font-size: 12px; font-weight: 600;">💡 TIP</div>
      <div style="font-size: 12px; margin-top: 4px;">With both enabled, the extension will capture everyone's voice in the meeting!</div>
    </div>
    
    <div style="margin-top: 24px; display: flex; justify-content: center;">
      <button id="vt-instructions-ok" style="
        background: linear-gradient(135deg, #60A5FA, #3B82F6);
        border: none;
        color: white;
        padding: 12px 24px;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 600;
        font-size: 14px;
        transition: all 0.2s ease;
      ">Start Capturing Audio</button>
    </div>
  `;
  
  document.body.appendChild(instructionsDiv);
  
  document.getElementById('vt-instructions-ok').addEventListener('click', () => {
    instructionsDiv.remove();
  });
  
  // Auto-remove after 30 seconds
  setTimeout(() => {
    if (document.body.contains(instructionsDiv)) {
      instructionsDiv.remove();
    }
  }, 30000);
}

  handleAudioActivity() {
    const currentTime = Date.now();
    this.isUserSpeaking = true;
    
    // Update last audio activity time
    this.lastAudioTime = currentTime;
    
    // Clear any existing silence timer
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }
    
    // Set a new silence timer with dynamic duration
    this.silenceTimer = setTimeout(() => {
      const timeSinceLastAudio = Date.now() - this.lastAudioTime;
      
      // Only mark as silence if enough time has passed
      if (timeSinceLastAudio >= this.minSilenceDuration) {
        this.isUserSpeaking = false;
        // Don't add silence marker anymore
        // this.addConversationLine('--- Silence ---', 'silence');
      }
    }, this.minSilenceDuration);
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
          speaker_labels: true,
          speakers_expected: 10,   // Increased expected speakers
          dual_channel: true,      // Enable dual channel processing
          audio_features: true,    // Enable additional audio features
          speech_threshold: 0.2,   // Lower speech detection threshold
          vad_sensitivity: 3      // Increased Voice Activity Detection sensitivity
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

  showMeetInstructions() {
    const instructionsDiv = document.createElement('div');
    instructionsDiv.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(0, 0, 0, 0.9);
      color: white;
      padding: 24px;
      border-radius: 12px;
      z-index: 1000001;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      max-width: 400px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      text-align: left;
    `;
    
    instructionsDiv.innerHTML = `
      <h3 style="margin: 0 0 16px 0; color: #60A5FA;">Google Meet Audio Capture Instructions</h3>
      <ol style="margin: 0; padding-left: 20px; line-height: 1.5;">
        <li style="margin-bottom: 8px;">When prompted, select <strong style="color: #60A5FA;">"Share tab"</strong></li>
        <li style="margin-bottom: 8px;">Choose the <strong style="color: #60A5FA;">Google Meet tab</strong></li>
        <li style="margin-bottom: 8px;">Make sure to check <strong style="color: #60A5FA;">"Share audio"</strong> checkbox</li>
        <li style="margin-bottom: 8px;">Click <strong style="color: #60A5FA;">"Share"</strong></li>
      </ol>
      <div style="margin-top: 16px; display: flex; justify-content: center;">
        <button id="vt-instructions-ok" style="
          background: #60A5FA;
          border: none;
          color: white;
          padding: 8px 16px;
          border-radius: 4px;
          cursor: pointer;
          font-weight: 500;
        ">Got it!</button>
      </div>
    `;
    
    document.body.appendChild(instructionsDiv);
    
    document.getElementById('vt-instructions-ok').addEventListener('click', () => {
      instructionsDiv.remove();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new VoiceTranslator());
} else {
  new VoiceTranslator();
}
