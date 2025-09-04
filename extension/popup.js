document.addEventListener('DOMContentLoaded', async () => {
  const micBtn = document.getElementById('mic-btn');
  const statusText = document.getElementById('status-text');
  const sourceLangSelect = document.getElementById('source-lang');
  const targetLangSelect = document.getElementById('target-lang');
  const swapBtn = document.getElementById('swap-languages');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const autoTranslateToggle = document.getElementById('auto-translate-toggle');
  const speakerToggle = document.getElementById('speaker-toggle'); // New speaker toggle
  const historyContent = document.getElementById('history-content');
  const clearHistoryBtn = document.getElementById('clear-history');
  const contrastToggle = document.getElementById('contrast-toggle');
  const fontSizeSelect = document.getElementById('font-size');
  const downloadSummaryBtn = document.getElementById('download-summary');
  const downloadFullBtn = document.getElementById('download-full');

  let isActive = false;
  let currentTab = null;
  let conversationHistory = [];

  // Load and apply accessibility settings on startup
  await loadAccessibilitySettings();

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    currentTab = tabs[0];

    if (!currentTab.url.includes('meet.google.com')) {
      statusText.textContent = 'Please open Google Meet';
      micBtn.style.opacity = '0.5';
      micBtn.style.cursor = 'not-allowed';
      return;
    }

    chrome.tabs.sendMessage(currentTab.id, { action: 'ping' }, (response) => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript({
          target: { tabId: currentTab.id },
          files: ['content.js']
        }, () => {
          if (chrome.runtime.lastError) {
            statusText.textContent = 'Failed to load extension. Please refresh the page.';
            micBtn.style.opacity = '0.5';
            micBtn.style.cursor = 'not-allowed';
            return;
          }
          setTimeout(() => {
            chrome.tabs.sendMessage(currentTab.id, { action: 'getStatus' }, (response) => {
              if (response && response.isActive) {
                isActive = true;
                updateMicButton();
              }
            });
          }, 1000);
        });
        return;
      }

      chrome.tabs.sendMessage(currentTab.id, { action: 'getStatus' }, (response) => {
        if (response && response.isActive) {
          isActive = true;
          updateMicButton();
        }
      });
    });
  });

  // Load settings with accessibility options and speaker diarization
  chrome.storage.sync.get([
    'sourceLanguage', 'targetLanguage', 'showFloatingBox', 'autoTranslate', 
    'conversationHistory', 'highContrast', 'fontSize', 'speakerDiarization'
  ], (result) => {
    if (result.sourceLanguage) sourceLangSelect.value = result.sourceLanguage;
    if (result.targetLanguage) targetLangSelect.value = result.targetLanguage;
    if (result.showFloatingBox !== undefined) {
      updateToggle(sidebarToggle, result.showFloatingBox);
    }
    if (result.autoTranslate !== undefined) {
      updateToggle(autoTranslateToggle, result.autoTranslate);
    }
    if (result.speakerDiarization !== undefined) {
      updateToggle(speakerToggle, result.speakerDiarization);
    } else {
      // Default to enabled
      updateToggle(speakerToggle, true);
    }
    if (result.conversationHistory) {
      conversationHistory = result.conversationHistory;
      updateHistoryDisplay();
    }
    
    // Apply accessibility settings
    if (result.highContrast !== undefined) {
      updateToggle(contrastToggle, result.highContrast);
      document.body.classList.toggle('high-contrast', result.highContrast);
    }
    if (result.fontSize) {
      fontSizeSelect.value = result.fontSize;
      applyFontSize(result.fontSize);
    }
  });

  // Event listeners
  sourceLangSelect.addEventListener('change', saveSettings);
  targetLangSelect.addEventListener('change', saveSettings);

  swapBtn.addEventListener('click', () => {
    const sourceValue = sourceLangSelect.value;
    const targetValue = targetLangSelect.value;

    const langMap = {
      'en-US': 'en', 'es-ES': 'es', 'fr-FR': 'fr', 'de-DE': 'de',
      'it-IT': 'it', 'pt-PT': 'pt', 'ru-RU': 'ru', 'ja-JP': 'ja',
      'ko-KR': 'ko', 'zh-CN': 'zh', 'hi-IN': 'hi', 'ar-SA': 'ar'
    };

    const reverseMap = Object.fromEntries(
      Object.entries(langMap).map(([k, v]) => [v, k])
    );

    sourceLangSelect.value = reverseMap[targetValue] || 'en-US';
    targetLangSelect.value = langMap[sourceValue] || 'en';

    saveSettings();
  });

  // Accessibility event listeners
  contrastToggle.addEventListener('click', () => {
    toggleSwitch(contrastToggle);
    const enabled = contrastToggle.classList.contains('active');
    document.body.classList.toggle('high-contrast', enabled);
    chrome.storage.sync.set({ highContrast: enabled });
  });

  fontSizeSelect.addEventListener('change', () => {
    const selectedSize = fontSizeSelect.value;
    applyFontSize(selectedSize);
    chrome.storage.sync.set({ fontSize: selectedSize });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.altKey) {
      switch (e.key) {
        case 's':
        case 'S':
          e.preventDefault();
          micBtn.click();
          break;
        case 'w':
        case 'W':
          e.preventDefault();
          swapBtn.click();
          break;
        case 'c':
        case 'C':
          e.preventDefault();
          clearHistoryBtn.click();
          break;
        case 'd':
        case 'D':
          e.preventDefault();
          downloadFullBtn.click();
          break;
      }
    }
  });

  downloadSummaryBtn.addEventListener('click', downloadSummary);
  downloadFullBtn.addEventListener('click', downloadFull);

  sidebarToggle.addEventListener('click', () => {
    toggleSwitch(sidebarToggle);
    saveSettings();
  });

  autoTranslateToggle.addEventListener('click', () => {
    toggleSwitch(autoTranslateToggle);
    saveSettings();
  });

  // New speaker diarization toggle
  speakerToggle.addEventListener('click', () => {
    toggleSwitch(speakerToggle);
    saveSettings();
  });

  clearHistoryBtn.addEventListener('click', () => {
    conversationHistory = [];
    chrome.storage.sync.set({ conversationHistory: [] });
    updateHistoryDisplay();
  });

  micBtn.addEventListener('click', async () => {
    if (!currentTab || !currentTab.url.includes('meet.google.com')) {
      showStatus('Please open Google Meet first', 'error');
      return;
    }

    chrome.tabs.sendMessage(currentTab.id, { action: 'ping' }, (response) => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript({
          target: { tabId: currentTab.id },
          files: ['content.js']
        }, () => {
          if (chrome.runtime.lastError) {
            showStatus('Failed to load extension. Please refresh the page.', 'error');
            return;
          }
          setTimeout(() => {
            chrome.tabs.sendMessage(currentTab.id, { action: 'ping' }, (response) => {
              if (chrome.runtime.lastError) {
                showStatus('Content script still not responding. Please refresh the page.', 'error');
                return;
              }
              proceedWithTranslation();
            });
          }, 1000);
        });
        return;
      }
      proceedWithTranslation();
    });

    function proceedWithTranslation() {
      isActive = !isActive;

      chrome.tabs.sendMessage(currentTab.id, {
        action: isActive ? 'startTranslation' : 'stopTranslation',
        settings: {
          sourceLanguage: sourceLangSelect.value,
          targetLanguage: targetLangSelect.value,
          showFloatingBox: sidebarToggle.classList.contains('active'),
          autoTranslate: autoTranslateToggle.classList.contains('active'),
          speakerDiarization: speakerToggle.classList.contains('active') // Include speaker setting
        }
      }, (response) => {
        if (response && response.success) {
          updateMicButton();
        } else {
          isActive = false;
          const errorMsg = response ? response.error || 'Unknown error' : 'No response from content script';
          showStatus(`Failed to start translator: ${errorMsg}`, 'error');
        }
      });
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'conversationUpdate') {
      conversationHistory = message.history;
      chrome.storage.sync.set({ conversationHistory });
      updateHistoryDisplay();
    } else if (message.action === 'languageDetected') {
      const detectedLangElement = document.getElementById('detected-lang');
      if (detectedLangElement) {
        detectedLangElement.textContent = `Detected: ${message.language}`;
      }
    }
  });

  // Helper functions
  async function loadAccessibilitySettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['highContrast', 'fontSize'], (result) => {
        if (result.highContrast) {
          document.body.classList.add('high-contrast');
          updateToggle(contrastToggle, true);
        }
        if (result.fontSize) {
          applyFontSize(result.fontSize);
          fontSizeSelect.value = result.fontSize;
        }
        resolve();
      });
    });
  }

  function applyFontSize(size) {
    // Remove existing font size classes
    document.body.classList.remove('small', 'medium', 'large');
    // Add the selected font size class
    document.body.classList.add(size);
  }

  function updateMicButton() {
    if (isActive) {
      micBtn.classList.add('recording');
      statusText.textContent = 'Translating...';
      document.querySelector('.action-text').textContent = 'Click to stop';
    } else {
      micBtn.classList.remove('recording');
      statusText.textContent = 'Ready to translate';
      document.querySelector('.action-text').textContent = 'Click to start listening';
    }
  }

  function toggleSwitch(toggle) {
    toggle.classList.toggle('active');
  }

  function updateToggle(toggle, isActive) {
    if (isActive) {
      toggle.classList.add('active');
    } else {
      toggle.classList.remove('active');
    }
  }

  function updateHistoryDisplay() {
    if (!historyContent) return;

    if (conversationHistory.length === 0) {
      historyContent.innerHTML = '<div class="history-line">No conversations yet...</div>';
      return;
    }

    const lines = conversationHistory.slice(-20);

    historyContent.innerHTML = lines.map((line, index) => {
      let className = 'history-line';
      if (index === lines.length - 1) {
        className += ' current';
      } else if (index >= lines.length - 3) {
        className += ' recent';
      }

      if (line.type === 'translation') {
        className += ' translation';
      } else if (line.type === 'silence') {
        className += ' silence';
      }

      // Handle speaker labels in display
      let displayText = line.text;
      const speakerMatch = displayText.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (speakerMatch) {
        displayText = `<span class="speaker-label">${speakerMatch[1]}</span> ${speakerMatch[2]}`;
      }

      return `<div class="${className}">${displayText}</div>`;
    }).join('');

    historyContent.scrollTop = historyContent.scrollHeight;
  }

   function saveSettings() {
    const settings = {
      sourceLanguage: sourceLangSelect.value,
      targetLanguage: targetLangSelect.value,
      showFloatingBox: sidebarToggle ? sidebarToggle.classList.contains('active') : true,
      autoTranslate: autoTranslateToggle ? autoTranslateToggle.classList.contains('active') : true,
      speakerDiarization: speakerToggle ? speakerToggle.classList.contains('active') : true
    };

    chrome.storage.sync.set(settings);

    if (isActive && currentTab) {
      chrome.tabs.sendMessage(currentTab.id, {
        action: 'updateSettings',
        settings: settings
      });
    }
  }
  function showStatus(message, type) {
    const status = document.createElement('div');
    status.style.cssText = `
      position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
      padding: 8px 16px; border-radius: 4px; font-size: 12px; z-index: 1000;
      ${type === 'success' ? 'background: #10b981; color: white;' : 'background: #ef4444; color: white;'}
    `;
    status.textContent = message;
    document.body.appendChild(status);
    setTimeout(() => status.remove(), 3000);
  }

  function downloadSummary() {
    chrome.storage.local.get('fullTranscript', async (result) => {
      const allText = (result.fullTranscript || []).map(l => l.text).join("\n");
      if (!allText) return showStatus("No transcript available", "error");
      const summary = await summarizeText(allText);
      downloadFile("summary.txt", summary);
    });
  }

  function downloadFull() {
    chrome.storage.local.get('fullTranscript', (result) => {
      const full = (result.fullTranscript || []).map(l => l.text).join("\n");
      if (!full) return showStatus("No transcript available", "error");
      downloadFile("full_transcript.txt", full);
    });
  }

  function downloadFile(filename, text) {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function summarizeText(text) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer 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`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: "Summarize the following conversation into key points. Use simple sentences. If there are multiple speakers, mention who said what." },
            { role: 'user', content: text }
          ],
          max_tokens: 800
        })
      });
      const result = await response.json();
      return result.choices[0].message.content.trim();
    } catch (e) {
      console.error("Summarization failed:", e);
      return "Failed to generate summary.";
    }
  }
});